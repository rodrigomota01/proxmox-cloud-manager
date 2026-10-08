"""What a tenant's members see of its billing: costs (full), resource usage only, or nothing.

Set by a platform admin (billing:manage); platform billing viewers always see everything.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-08 18:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0015'
down_revision: str | None = '0014'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('tenants', sa.Column(
        'cost_visibility', sa.Text(), server_default='full', nullable=False,
    ))
    op.create_check_constraint(
        op.f('ck_tenants_cost_visibility'), 'tenants',
        "cost_visibility IN ('full', 'usage', 'none')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f('ck_tenants_cost_visibility'), 'tenants', type_='check')
    op.drop_column('tenants', 'cost_visibility')
