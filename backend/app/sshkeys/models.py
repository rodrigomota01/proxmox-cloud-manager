import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPk


class SshPublicKey(UUIDPk, Base):
    """A user's public key (never private keys). Owner-only (RLS on app.user_id)."""

    __tablename__ = "ssh_public_keys"
    __table_args__ = (UniqueConstraint("user_id", "fingerprint"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(Text)
    public_key: Mapped[str] = mapped_column(Text)
    fingerprint: Mapped[str] = mapped_column(Text)  # SHA256:..., as ssh-keygen -l prints
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
