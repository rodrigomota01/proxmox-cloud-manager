"""Root filesystem of each node, and the addresses a VM's guest agent reports.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-12 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0016'
down_revision: str | None = '0015'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('nodes', sa.Column(
        'root_disk_bytes', sa.BigInteger(), server_default='0', nullable=False,
    ))
    op.add_column('nodes', sa.Column(
        'root_disk_used_bytes', sa.BigInteger(), server_default='0', nullable=False,
    ))
    op.add_column('instances', sa.Column(
        'guest_addresses', postgresql.JSONB(astext_type=sa.Text()), nullable=True,
    ))


def downgrade() -> None:
    op.drop_column('instances', 'guest_addresses')
    op.drop_column('nodes', 'root_disk_used_bytes')
    op.drop_column('nodes', 'root_disk_bytes')
