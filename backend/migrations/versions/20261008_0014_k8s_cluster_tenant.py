"""Kubernetes clusters linked to a tenant, and the tenant's read-only views of them.

The tables stay platform-only (k8s_clusters holds the sealed kubeconfig). Tenants read
through two views owned by cm_owner (who bypasses RLS): they expose no credential
column and only the rows of clusters linked to a tenant in app.tenant_ids.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-08 14:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0014'
down_revision: str | None = '0013'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

IN_TENANT = "c.tenant_id = ANY (string_to_array(current_setting('app.tenant_ids', true), ',')::uuid[])"


def upgrade() -> None:
    op.add_column('k8s_clusters', sa.Column('tenant_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_k8s_clusters_tenant_id_tenants'), 'k8s_clusters', 'tenants',
        ['tenant_id'], ['id'], ondelete='SET NULL',
    )
    op.create_index('ix_k8s_clusters_tenant_id', 'k8s_clusters', ['tenant_id'])

    op.execute(f"""
        CREATE VIEW k8s_tenant_clusters WITH (security_barrier) AS
        SELECT c.id, c.name, c.source, c.api_server, c.server_url, c.certs_expire_on,
               c.cert_expires_at, c.synced_at, c.tenant_id
        FROM k8s_clusters c
        WHERE c.tenant_id IS NOT NULL AND {IN_TENANT}
    """)
    op.execute(f"""
        CREATE VIEW k8s_tenant_snapshots WITH (security_barrier) AS
        SELECT s.*
        FROM k8s_snapshots s JOIN k8s_clusters c ON c.id = s.cluster_id
        WHERE c.tenant_id IS NOT NULL AND {IN_TENANT}
    """)
    # default privileges grant writes on every new relation; these views are read-only
    for view in ('k8s_tenant_clusters', 'k8s_tenant_snapshots'):
        op.execute(f"REVOKE ALL ON {view} FROM cm_app")
        op.execute(f"GRANT SELECT ON {view} TO cm_app")


def downgrade() -> None:
    op.execute("DROP VIEW k8s_tenant_snapshots")
    op.execute("DROP VIEW k8s_tenant_clusters")
    op.drop_index('ix_k8s_clusters_tenant_id', table_name='k8s_clusters')
    op.drop_constraint(op.f('fk_k8s_clusters_tenant_id_tenants'), 'k8s_clusters', type_='foreignkey')
    op.drop_column('k8s_clusters', 'tenant_id')
