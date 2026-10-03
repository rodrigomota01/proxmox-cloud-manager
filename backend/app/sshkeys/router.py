"""/api/v1/ssh-keys — the caller's own public keys (RLS on app.user_id)."""

import base64
import binascii
import hashlib
import struct
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentPrincipal, DbSession
from app.audit import service as audit
from app.core.errors import Conflict, NotFound, ValidationError
from app.sshkeys.models import SshPublicKey

router = APIRouter(tags=["ssh-keys"])

ALLOWED_TYPES = {
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
}


def parse_public_key(text: str) -> tuple[str, str]:
    """Returns (normalized 'type base64 [comment]', 'SHA256:...' fingerprint)."""
    if "PRIVATE KEY" in text:
        raise ValidationError(
            "That is a private key. Paste the public key (the .pub file).",
            errors=[{"field": "public_key", "message": "private key rejected"}],
        )
    parts = text.strip().split(None, 2)
    if len(parts) < 2 or parts[0] not in ALLOWED_TYPES:
        raise ValidationError(errors=[{"field": "public_key", "message": "unsupported key"}])
    try:
        blob = base64.b64decode(parts[1], validate=True)
        (name_len,) = struct.unpack(">I", blob[:4])
        embedded_type = blob[4 : 4 + name_len].decode()
    except (binascii.Error, struct.error, UnicodeDecodeError) as exc:
        raise ValidationError(
            errors=[{"field": "public_key", "message": "malformed key"}]
        ) from exc
    if embedded_type != parts[0]:
        raise ValidationError(errors=[{"field": "public_key", "message": "malformed key"}])
    if parts[0] == "ssh-rsa" and len(blob) < 270:  # < 2048-bit modulus
        raise ValidationError(errors=[{"field": "public_key", "message": "RSA key too short"}])
    digest = base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    return " ".join(parts), f"SHA256:{digest}"


class KeyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
    public_key: Annotated[str, Field(max_length=16_384)]


class KeyOut(BaseModel):
    id: uuid.UUID
    name: str
    fingerprint: str
    public_key: str
    created_at: datetime


def key_out(k: SshPublicKey) -> KeyOut:
    return KeyOut(
        id=k.id, name=k.name, fingerprint=k.fingerprint, public_key=k.public_key,
        created_at=k.created_at,
    )


@router.get("/ssh-keys")
async def list_keys(principal: CurrentPrincipal, db: DbSession) -> list[KeyOut]:
    keys = await db.execute(
        select(SshPublicKey)
        .where(SshPublicKey.user_id == principal.user_id)
        .order_by(SshPublicKey.created_at)
    )
    return [key_out(k) for k in keys.scalars()]


@router.post("/ssh-keys", status_code=status.HTTP_201_CREATED)
async def add_key(body: KeyCreate, principal: CurrentPrincipal, db: DbSession) -> KeyOut:
    public_key, fingerprint = parse_public_key(body.public_key)
    key = SshPublicKey(
        user_id=principal.user_id, name=body.name, public_key=public_key,
        fingerprint=fingerprint,
    )
    try:
        async with db.begin_nested():
            db.add(key)
    except IntegrityError as exc:
        raise Conflict("This key is already registered") from exc
    await audit.record(
        db, "SSH_KEY_ADD", actor_user_id=principal.user_id, resource_type="ssh_key",
        resource_id=key.id, details={"fingerprint": fingerprint},
    )
    await db.refresh(key)
    return key_out(key)


@router.delete("/ssh-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_key(key_id: uuid.UUID, principal: CurrentPrincipal, db: DbSession) -> None:
    key = await db.get(SshPublicKey, key_id)
    if key is None or key.user_id != principal.user_id:
        raise NotFound()
    await db.delete(key)
    await audit.record(
        db, "SSH_KEY_DELETE", actor_user_id=principal.user_id, resource_type="ssh_key",
        resource_id=key_id, details={"fingerprint": key.fingerprint},
    )
