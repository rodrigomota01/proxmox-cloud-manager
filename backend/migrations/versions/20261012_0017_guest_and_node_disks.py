"""Every virtual disk of each guest, and the physical disks of each node.

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-12 15:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0017'
down_revision: str | None = '0016'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('instances', sa.Column(
        'disks', postgresql.JSONB(astext_type=sa.Text()), nullable=True,
    ))
    op.add_column('nodes', sa.Column(
        'disks', postgresql.JSONB(astext_type=sa.Text()), nullable=True,
    ))
    op.add_column('nodes', sa.Column(
        'disks_checked_at', sa.DateTime(timezone=True), nullable=True,
    ))


def downgrade() -> None:
    op.drop_column('nodes', 'disks_checked_at')
    op.drop_column('nodes', 'disks')
    op.drop_column('instances', 'disks')
