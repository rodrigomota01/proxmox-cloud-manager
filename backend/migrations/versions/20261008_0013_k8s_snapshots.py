"""Kubernetes: manual clusters (source) and the last collection from each cluster API.

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-08 01:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0013'
down_revision: str | None = '0012'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('k8s_clusters', sa.Column('source', sa.Text(), server_default='table', nullable=False))
    op.create_check_constraint(op.f('ck_k8s_clusters_source'), 'k8s_clusters', "source IN ('table', 'manual')")

    op.create_table('k8s_snapshots',
    sa.Column('cluster_id', sa.Uuid(), nullable=False),
    sa.Column('health', sa.Text(), nullable=False),
    sa.Column('reasons', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('version', sa.Text(), nullable=True),
    sa.Column('summary', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
    sa.Column('collected_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('ok_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("health IN ('healthy', 'warning', 'critical', 'unreachable')", name=op.f('ck_k8s_snapshots_health')),
    sa.ForeignKeyConstraint(['cluster_id'], ['k8s_clusters.id'], name=op.f('fk_k8s_snapshots_cluster_id_k8s_clusters'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('cluster_id', name=op.f('pk_k8s_snapshots'))
    )
    platform = "current_setting('app.platform_scope', true) = 'on'"
    op.execute("ALTER TABLE k8s_snapshots ENABLE ROW LEVEL SECURITY")
    op.execute(f"CREATE POLICY k8s_snapshots_platform ON k8s_snapshots FOR ALL USING ({platform}) WITH CHECK ({platform})")


def downgrade() -> None:
    op.drop_table('k8s_snapshots')
    op.drop_constraint(op.f('ck_k8s_clusters_source'), 'k8s_clusters', type_='check')
    op.drop_column('k8s_clusters', 'source')
