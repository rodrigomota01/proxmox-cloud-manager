"""User account administration (platform scope).

Guard rails:
- nobody deactivates, demotes or edits the platform roles of themselves;
- an admin cannot act on an account whose platform roles grant permissions the admin
  lacks (a PLATFORM_ADMIN cannot touch a SUPER_ADMIN);
- the last active SUPER_ADMIN can be neither deactivated nor demoted;
- platform roles are granted/revoked only with platform:admin.
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit
from app.auth.service import AuthService
from app.core.errors import Conflict, Forbidden, NotFound, ValidationError
from app.iam.authz import PLATFORM, authorize, effective_permissions
from app.iam.models import Role, RoleBinding, User
from app.infra.mailer import Mail

SUPER_ADMIN = "SUPER_ADMIN"


async def platform_roles(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    rows = await db.execute(
        select(Role.name)
        .join(RoleBinding, RoleBinding.role_id == Role.id)
        .where(RoleBinding.user_id == user_id, RoleBinding.scope_type == "platform")
        .order_by(Role.name)
    )
    return list(rows.scalars())


class UserAdminService:
    def __init__(self, db: AsyncSession, actor: uuid.UUID, auth: AuthService) -> None:
        self.db, self.actor, self.auth = db, actor, auth

    async def _audit(self, action: str, target: uuid.UUID, **details: object) -> None:
        await audit.record(
            self.db, action, actor_user_id=self.actor, resource_type="user",
            resource_id=target, details=dict(details),
        )

    async def get(self, user_id: uuid.UUID) -> User:
        user = await self.db.get(User, user_id)
        if user is None:
            raise NotFound()
        return user

    async def _guard(self, target: User, *, allow_self: bool = False) -> None:
        """The actor must hold every platform permission the target holds."""
        if target.id == self.actor and not allow_self:
            raise Forbidden("Use your profile page to change your own account")
        target_perms = await effective_permissions(self.db, target.id, PLATFORM)
        actor_perms = await effective_permissions(self.db, self.actor, PLATFORM)
        if not target_perms <= actor_perms:
            raise Forbidden("This account has platform permissions you do not hold")

    async def _active_super_admins(self, excluding: uuid.UUID | None = None) -> int:
        stmt = (
            select(func.count(func.distinct(User.id)))
            .join(RoleBinding, RoleBinding.user_id == User.id)
            .join(Role, Role.id == RoleBinding.role_id)
            .where(Role.name == SUPER_ADMIN, RoleBinding.scope_type == "platform", User.is_active)
        )
        if excluding is not None:
            stmt = stmt.where(User.id != excluding)
        return await self.db.scalar(stmt) or 0

    # --- create ------------------------------------------------------------------------

    async def create(self, email: str, display_name: str) -> tuple[User, Mail]:
        user = User(email=email, display_name=display_name)
        try:
            async with self.db.begin_nested():
                self.db.add(user)
        except IntegrityError as exc:
            raise Conflict("A user with this e-mail already exists") from exc
        inviter = await self.get(self.actor)
        mail = await self.auth.invite(user, invited_by=inviter.display_name)
        await self._audit("USER_CREATE", user.id, email=email)
        return user, mail

    # --- edit --------------------------------------------------------------------------

    async def update(
        self, user_id: uuid.UUID, *, display_name: str | None, email: str | None,
        is_active: bool | None,
    ) -> User:
        user = await self.get(user_id)
        await self._guard(user)
        changes: dict[str, object] = {}
        if display_name is not None and display_name != user.display_name:
            changes["display_name"] = {"from": user.display_name, "to": display_name}
            user.display_name = display_name
        if email is not None and email != user.email:
            changes["email"] = {"from": user.email, "to": email}
            user.email = email
        if is_active is not None and is_active != user.is_active:
            if not is_active and SUPER_ADMIN in await platform_roles(self.db, user.id):
                if await self._active_super_admins(excluding=user.id) == 0:
                    raise Conflict("The last active SUPER_ADMIN cannot be deactivated")
            changes["is_active"] = {"from": user.is_active, "to": is_active}
            user.is_active = is_active
            if not is_active:  # signed out everywhere, effective immediately
                changes["sessions_revoked"] = await self.auth.revoke_all_sessions(
                    user.id, "deactivated"
                )
        if not changes:
            return user
        try:
            async with self.db.begin_nested():
                await self.db.flush()
        except IntegrityError as exc:
            raise Conflict("A user with this e-mail already exists") from exc
        await self._audit("USER_UPDATE", user.id, **changes)
        return user

    async def unlock(self, user_id: uuid.UUID) -> User:
        user = await self.get(user_id)
        await self._guard(user)
        user.failed_login_count, user.locked_until = 0, None
        await self._audit("USER_UNLOCK", user.id)
        return user

    async def send_password_reset(self, user_id: uuid.UUID) -> Mail:
        user = await self.get(user_id)
        await self._guard(user)
        if not user.is_active:
            raise Conflict("Reactivate the account before sending a reset link")
        await self._audit("USER_PASSWORD_RESET_SENT", user.id)
        return await self.auth.password_reset_mail(user)

    async def revoke_sessions(self, user_id: uuid.UUID) -> int:
        user = await self.get(user_id)
        await self._guard(user)
        count = await self.auth.revoke_all_sessions(user.id, "revoked_by_admin")
        await self._audit("USER_SESSIONS_REVOKE", user.id, sessions_revoked=count)
        return count

    # --- platform roles ----------------------------------------------------------------

    async def set_platform_roles(self, user_id: uuid.UUID, roles: list[str]) -> list[str]:
        await authorize(self.db, self.actor, "platform:admin", PLATFORM)
        user = await self.get(user_id)
        await self._guard(user)
        wanted = set(roles)
        catalog = {
            r.name: r for r in (await self.db.execute(select(Role).where(Role.name.in_(wanted))))
            .scalars()
        }
        for name in wanted:
            role = catalog.get(name)
            if role is None or "platform" not in role.allowed_scopes:
                raise ValidationError(
                    errors=[{"field": "roles", "message": f"{name} is not a platform role"}]
                )
        current = await platform_roles(self.db, user.id)
        if SUPER_ADMIN in current and SUPER_ADMIN not in wanted and user.is_active:
            if await self._active_super_admins(excluding=user.id) == 0:
                raise Conflict("The last active SUPER_ADMIN cannot be demoted")

        bindings = (
            await self.db.execute(
                select(RoleBinding, Role.name)
                .join(Role, Role.id == RoleBinding.role_id)
                .where(RoleBinding.user_id == user.id, RoleBinding.scope_type == "platform")
            )
        ).all()
        for binding, name in bindings:
            if name not in wanted:
                await self.db.delete(binding)
        for name in wanted - set(current):
            self.db.add(RoleBinding(
                user_id=user.id, role_id=catalog[name].id, scope_type="platform",
                created_by=self.actor,
            ))
        await self.db.flush()
        result = await platform_roles(self.db, user.id)
        await self._audit("USER_PLATFORM_ROLES", user.id, before=current, after=result)
        return result

