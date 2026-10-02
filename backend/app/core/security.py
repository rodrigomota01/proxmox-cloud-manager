"""Password hashing (argon2id), opaque tokens and Ed25519 JWTs."""

import base64
import hashlib
import hmac
import logging
import secrets
import time
import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from app.core.config import Settings

logger = logging.getLogger(__name__)

AUDIENCE = "cloud-manager-api"

# docs/architecture/08-seguranca.md: time_cost=3, memory_cost=64MiB, parallelism=4
_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4)
# Verified when the user does not exist, so both paths take the same time.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and bool(password_hash)
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def new_opaque_token() -> str:
    return secrets.token_urlsafe(32)  # 256 bits


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def generate_private_key_pem() -> str:
    key = Ed25519PrivateKey.generate()
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


@dataclass(frozen=True)
class SigningKey:
    kid: str
    private: Ed25519PrivateKey
    public: Ed25519PublicKey

    @property
    def public_raw(self) -> bytes:
        return self.public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)

    def jwk(self) -> dict[str, str]:
        x = base64.urlsafe_b64encode(self.public_raw).rstrip(b"=").decode()
        return {
            "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": self.kid, "x": x,
        }


@lru_cache
def _load_key(pem: str) -> SigningKey:
    private = serialization.load_pem_private_key(pem.encode(), password=None)
    if not isinstance(private, Ed25519PrivateKey):
        raise ValueError("CM_JWT_PRIVATE_KEY must be an Ed25519 key")
    public = private.public_key()
    raw = public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return SigningKey(kid=hashlib.sha256(raw).hexdigest()[:16], private=private, public=public)


_ephemeral_pem: str | None = None


def signing_key(settings: Settings) -> SigningKey:
    if settings.jwt_private_key is not None:
        # .env carries the PEM on one line with literal "\\n" (see `app.cli gen-keys`)
        return _load_key(settings.jwt_private_key.get_secret_value().replace("\\n", "\n"))
    if settings.env not in ("dev", "test"):
        raise RuntimeError("CM_JWT_PRIVATE_KEY is required outside dev/test")
    global _ephemeral_pem
    if _ephemeral_pem is None:
        logger.warning("CM_JWT_PRIVATE_KEY not set; using an ephemeral key (dev only)")
        _ephemeral_pem = generate_private_key_pem()
    return _load_key(_ephemeral_pem)


def issue_access_token(
    settings: Settings, *, user_id: uuid.UUID, session_id: uuid.UUID, amr: list[str]
) -> str:
    key = signing_key(settings)
    now = int(time.time())
    claims = {
        "iss": settings.jwt_issuer,
        "aud": AUDIENCE,
        "sub": str(user_id),
        "sid": str(session_id),
        "amr": amr,
        "iat": now,
        "exp": now + settings.access_token_ttl_seconds,
        "jti": secrets.token_hex(16),
    }
    return jwt.encode(claims, key.private, algorithm="EdDSA", headers={"kid": key.kid})


def decode_access_token(settings: Settings, token: str) -> dict[str, Any]:
    """Raises jwt.PyJWTError on any problem (signature, expiry, audience, issuer)."""
    key = signing_key(settings)
    return jwt.decode(
        token,
        key.public,
        algorithms=["EdDSA"],
        audience=AUDIENCE,
        issuer=settings.jwt_issuer,
        options={"require": ["exp", "iat", "sub", "sid", "aud", "iss"]},
    )
