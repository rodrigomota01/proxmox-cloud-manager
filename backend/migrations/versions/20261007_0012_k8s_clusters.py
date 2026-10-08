"""Kubernetes clusters: local copy of the legacy kubernetes_clusters table.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-07 21:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0012'
down_revision: str | None = '0011'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('k8s_clusters',
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('api_server', sa.Text(), nullable=True),
    sa.Column('server_url', sa.Text(), nullable=True),
    sa.Column('certs_expire_on', sa.Date(), nullable=True),
    sa.Column('cert_expires_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('nodes', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
    sa.Column('kubeconfig_ciphertext', sa.LargeBinary(), nullable=True),
    sa.Column('dek_wrapped', sa.LargeBinary(), nullable=True),
    sa.Column('kek_ref', sa.Text(), nullable=True),
    sa.Column('kubeconfig_sha256', sa.Text(), nullable=True),
    sa.Column('kubeconfig_error', sa.Text(), nullable=True),
    sa.Column('source_modified_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('synced_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_k8s_clusters')),
    sa.UniqueConstraint('name', name=op.f('uq_k8s_clusters_name'))
    )
    # platform data holding credentials: invisible outside platform scope, even to a
    # buggy tenant route
    platform = "current_setting('app.platform_scope', true) = 'on'"
    op.execute("ALTER TABLE k8s_clusters ENABLE ROW LEVEL SECURITY")
    op.execute(f"CREATE POLICY k8s_clusters_platform ON k8s_clusters FOR ALL USING ({platform}) WITH CHECK ({platform})")


def downgrade() -> None:
    op.drop_table('k8s_clusters')
