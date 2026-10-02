"""Login, refresh rotation with reuse detection, logout and password reset.

Failure paths that must leave a trace (failed-login counter, LOGIN_FAILED,
REFRESH_TOKEN_REUSE) commit explicitly before raising, because the request transaction
is rolled back on error. These tables are global (no RLS scope to lose on commit).
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit
from app.auth.models import PasswordResetToken, RefreshToken, Session
from app.core.config import Settings
from app.core.errors import Unauthenticated
from app.core.security import (
    hash_password,
    hash_token,
    issue_access_token,
    needs_rehash,
    new_opaque_token,
    verify_password,
)
from app.iam.models import User
from app.infra import ratelimit
from app.infra.mailer import Mail

INVALID_CREDENTIALS = "Invalid credentials"
# (failed attempts, lock duration) — docs/architecture/06-autenticacao.md
LOCK_STEPS = ((10, timedelta(minutes=15)), (5, timedelta(minutes=1)))


def _now() -> datetime:
    return datetime.now(UTC)


def revoked_sid_key(session_id: uuid.UUID | str) -> str:
    return f"revoked_sid:{session_id}"


@dataclass(frozen=True)
class IssuedTokens:
    user: User
    session_id: uuid.UUID
    access_token: str
    refresh_token: str
    refresh_expires_at: datetime


class AuthService:
    def __init__(self, db: AsyncSession, redis: Redis, settings: Settings) -> None:
        self.db, self.redis, self.settings = db, redis, settings

    # --- login -------------------------------------------------------------------------

    async def login(
        self, email: str, password: str, *, ip: str | None, user_agent: str | None
    ) -> IssuedTokens:
        s = self.settings
        await ratelimit.hit(self.redis, "login-ip", ip or "-", s.login_rate_limit_ip_per_minute)
        await ratelimit.hit(self.redis, "login-email", email, s.login_rate_limit_email_per_minute)

        user = (
            await self.db.execute(select(User).where(User.email == email).with_for_update())
        ).scalar_one_or_none()
        now = _now()
        locked = user is not None and user.locked_until is not None and user.locked_until > now
        # always verify (dummy hash when the user does not exist) to keep timing constant
        valid = verify_password(user.password_hash if user else None, password)

        if user is None or locked or not valid or not user.is_active:
            reason = (
                "unknown_user" if user is None
                else "locked" if locked
                else "inactive" if not user.is_active
                else "bad_password"
            )
            if user is not None and reason == "bad_password":
                user.failed_login_count += 1
                for threshold, duration in LOCK_STEPS:
                    if user.failed_login_count >= threshold:
                        user.locked_until = now + duration
                        break
            await audit.record(
                self.db, "LOGIN_FAILED", outcome="failure",
                actor_user_id=user.id if user else None, source_ip=ip,
                details={"reason": reason},
            )
            await self.db.commit()
            raise Unauthenticated(INVALID_CREDENTIALS)

        user.failed_login_count = 0
        user.locked_until = None
        user.last_login_at = now
        if user.password_hash and needs_rehash(user.password_hash):
            user.password_hash = hash_password(password)

        sess = Session(
            user_id=user.id, amr=["pwd"], ip=ip, user_agent=(user_agent or "")[:512] or None,
            expires_at=now + timedelta(seconds=s.refresh_absolute_ttl_seconds),
        )
        self.db.add(sess)
        await self.db.flush()
        refresh = self._new_refresh_token(sess, now)
        await audit.record(
            self.db, "LOGIN_SUCCESS", actor_user_id=user.id, source_ip=ip,
            resource_type="session", resource_id=sess.id,
        )
        return self._issue(user, sess, refresh)

    # --- refresh -----------------------------------------------------------------------

    async def refresh(self, raw_token: str, *, ip: str | None) -> IssuedTokens:
        now = _now()
        rt = (
            await self.db.execute(
                select(RefreshToken)
                .where(RefreshToken.token_hash == hash_token(raw_token))
                .with_for_update()
            )
        ).scalar_one_or_none()
        if rt is None:
            raise Unauthenticated()
        sess = await self.db.get(Session, rt.session_id, with_for_update=True)
        if sess is None or sess.revoked_at is not None or sess.expires_at <= now:
            raise Unauthenticated()

        if rt.rotated_at is not None:
            # a rotated token came back: it was copied. Kill the whole family.
            await self._revoke_session(sess, "refresh_token_reuse", now)
            await audit.record(
                self.db, "REFRESH_TOKEN_REUSE", outcome="denied", actor_user_id=sess.user_id,
                source_ip=ip, resource_type="session", resource_id=sess.id,
            )
            await self.db.commit()
            raise Unauthenticated()
        if rt.idle_expires_at <= now:
            raise Unauthenticated()

        user = await self.db.get(User, sess.user_id)
        if user is None or not user.is_active:
            await self._revoke_session(sess, "user_inactive", now)
            await self.db.commit()
            raise Unauthenticated()

        rt.rotated_at = now
        sess.last_seen_at = now
        refresh = self._new_refresh_token(sess, now)
        return self._issue(user, sess, refresh)

    # --- logout ------------------------------------------------------------------------

    async def logout(self, raw_token: str, *, ip: str | None) -> None:
        rt = (
            await self.db.execute(
                select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_token))
            )
        ).scalar_one_or_none()
        if rt is None:
            return
        sess = await self.db.get(Session, rt.session_id, with_for_update=True)
        if sess is None or sess.revoked_at is not None:
            return
        await self._revoke_session(sess, "logout", _now())
        await audit.record(
            self.db, "LOGOUT", actor_user_id=sess.user_id, source_ip=ip,
            resource_type="session", resource_id=sess.id,
        )

    async def logout_all(self, user_id: uuid.UUID, *, ip: str | None) -> int:
        count = await self.revoke_all_sessions(user_id, "logout_all")
        await audit.record(
            self.db, "LOGOUT_ALL", actor_user_id=user_id, source_ip=ip,
            details={"sessions_revoked": count},
        )
        return count

    async def revoke_all_sessions(self, user_id: uuid.UUID, reason: str) -> int:
        now = _now()
        sessions = (
            await self.db.execute(
                select(Session)
                .where(Session.user_id == user_id, Session.revoked_at.is_(None))
                .with_for_update()
            )
        ).scalars().all()
        for sess in sessions:
            await self._revoke_session(sess, reason, now)
        return len(sessions)

    # --- password reset ----------------------------------------------------------------

    async def request_password_reset(self, email: str, *, ip: str | None) -> Mail | None:
        """Returns the e-mail to send (after the response, so timing does not reveal
        whether the address exists), or None."""
        await ratelimit.hit(self.redis, "forgot-ip", ip or "-", 10)
        await ratelimit.hit(self.redis, "forgot-email", email, 3, window_seconds=3600)
        user = (
            await self.db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        if user is None or not user.is_active:
            return None

        now = _now()
        await self.db.execute(
            update(PasswordResetToken)
            .where(PasswordResetToken.user_id == user.id, PasswordResetToken.used_at.is_(None))
            .values(used_at=now)
        )
        token = new_opaque_token()
        self.db.add(
            PasswordResetToken(
                user_id=user.id, token_hash=hash_token(token),
                expires_at=now + timedelta(seconds=self.settings.password_reset_ttl_seconds),
            )
        )
        await audit.record(
            self.db, "PASSWORD_RESET_REQUESTED", actor_user_id=user.id, source_ip=ip
        )
        minutes = self.settings.password_reset_ttl_seconds // 60
        # token in the URL fragment: never sent to servers or leaked via Referer
        link = f"{self.settings.public_base_url}/reset-password#token={token}"
        return Mail(
            to=user.email,
            subject="Cloud Manager — redefinição de senha",
            body=(
                f"Olá {user.display_name},\n\n"
                f"Para redefinir sua senha, acesse:\n{link}\n\n"
                f"O link vale por {minutes} minutos e pode ser usado uma vez.\n"
                "Se você não pediu a redefinição, ignore este e-mail.\n"
            ),
        )

    async def reset_password(self, raw_token: str, new_password: str, *, ip: str | None) -> None:
        now = _now()
        prt = (
            await self.db.execute(
                select(PasswordResetToken)
                .where(PasswordResetToken.token_hash == hash_token(raw_token))
                .with_for_update()
            )
        ).scalar_one_or_none()
        if prt is None or prt.used_at is not None or prt.expires_at <= now:
            raise Unauthenticated("Invalid or expired reset token")
        user = await self.db.get(User, prt.user_id, with_for_update=True)
        if user is None or not user.is_active:
            raise Unauthenticated("Invalid or expired reset token")

        prt.used_at = now
        user.password_hash = hash_password(new_password)
        user.password_changed_at = now
        user.failed_login_count = 0
        user.locked_until = None
        count = await self.revoke_all_sessions(user.id, "password_reset")
        await audit.record(
            self.db, "PASSWORD_RESET", actor_user_id=user.id, source_ip=ip,
            details={"sessions_revoked": count},
        )

    # --- helpers -----------------------------------------------------------------------

    def _new_refresh_token(self, sess: Session, now: datetime) -> tuple[str, datetime]:
        token = new_opaque_token()
        idle = now + timedelta(seconds=self.settings.refresh_idle_ttl_seconds)
        expires = min(idle, sess.expires_at)
        self.db.add(
            RefreshToken(session_id=sess.id, token_hash=hash_token(token), idle_expires_at=expires)
        )
        return token, expires

    def _issue(self, user: User, sess: Session, refresh: tuple[str, datetime]) -> IssuedTokens:
        access = issue_access_token(
            self.settings, user_id=user.id, session_id=sess.id, amr=list(sess.amr)
        )
        return IssuedTokens(
            user=user, session_id=sess.id, access_token=access,
            refresh_token=refresh[0], refresh_expires_at=refresh[1],
        )

    async def _revoke_session(self, sess: Session, reason: str, now: datetime) -> None:
        sess.revoked_at = now
        sess.revoked_reason = reason
        # access tokens of this session die now, not at expiry
        await self.redis.set(
            revoked_sid_key(sess.id), "1", ex=self.settings.access_token_ttl_seconds
        )
