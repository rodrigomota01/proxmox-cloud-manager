"""The guest's notes (Proxmox description), read with its config.

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-20 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0020'
down_revision: str | None = '0019'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('instances', sa.Column('description', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('instances', 'description')
