"""Interface and e-mail language of each user.

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-16 01:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0019'
down_revision: str | None = '0018'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('users', sa.Column('locale', sa.Text(), server_default='pt-BR', nullable=False))
    op.create_check_constraint(op.f('ck_users_locale_known'), 'users', "locale IN ('pt-BR', 'en')")


def downgrade() -> None:
    op.drop_constraint(op.f('ck_users_locale_known'), 'users', type_='check')
    op.drop_column('users', 'locale')
