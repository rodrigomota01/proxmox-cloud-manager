"""Live disk and network usage of instances (guest agent, counter deltas).

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-03 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0008'
down_revision: str | None = '0007'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_BIG = ("net_in_bytes", "net_out_bytes")
_RATE = ("net_in_bps", "net_out_bps")


def upgrade() -> None:
    for col in _BIG:
        op.add_column('instances', sa.Column(col, sa.BigInteger(), server_default='0', nullable=False))
    for col in _RATE:
        op.add_column('instances', sa.Column(col, sa.Float(), server_default='0', nullable=False))
    op.add_column('instances', sa.Column('disk_used_bytes', sa.BigInteger(), nullable=True))
    op.add_column('instances', sa.Column('disk_total_bytes', sa.BigInteger(), nullable=True))
    op.add_column('instances', sa.Column('disk_usage', sa.Float(), nullable=True))
    op.add_column('instances', sa.Column('filesystems', postgresql.JSONB(), nullable=True))
    op.add_column('instances', sa.Column('disk_checked_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('instances', sa.Column('guest_agent', sa.Text(), nullable=True))


def downgrade() -> None:
    for col in (*_BIG, *_RATE, 'disk_used_bytes', 'disk_total_bytes', 'disk_usage',
                'filesystems', 'disk_checked_at', 'guest_agent'):
        op.drop_column('instances', col)
