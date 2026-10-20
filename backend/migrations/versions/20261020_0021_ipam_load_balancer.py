"""IPs dedicated to a load balancer (awf_ip_pool.assigned_load_balancer).

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-20 18:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0021'
down_revision: str | None = '0020'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'ipam_addresses',
        sa.Column('load_balancer', sa.Boolean(), server_default='false', nullable=False),
    )


def downgrade() -> None:
    op.drop_column('ipam_addresses', 'load_balancer')
