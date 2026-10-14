"""Kubernetes clusters created by the platform (ADR-0018): lifecycle, node pools, nodes.

- k8s_clusters: source 'managed' plus state, owning project, provider server, image,
  version and spec (networks, endpoint, component versions; never secrets).
- k8s_node_pools: control-plane / worker pools. Platform-only like k8s_clusters; tenants
  read them through the k8s_tenant_node_pools view.
- instances.k8s_cluster_id / k8s_pool_id: the nodes are ordinary instances.
- images.kubernetes_version: an image that carries a fixed Kubernetes version can only
  be used for cluster nodes.

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-13 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0018'
down_revision: str | None = '0017'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PLATFORM = "current_setting('app.platform_scope', true) = 'on'"
IN_TENANT = "c.tenant_id = ANY (string_to_array(current_setting('app.tenant_ids', true), ',')::uuid[])"
STATES = "('provisioning', 'active', 'updating', 'error', 'deleting')"


def _tenant_clusters_view(extra: str) -> None:
    op.execute("DROP VIEW k8s_tenant_clusters")
    op.execute(f"""
        CREATE VIEW k8s_tenant_clusters WITH (security_barrier) AS
        SELECT c.id, c.name, c.source, c.api_server, c.server_url, c.certs_expire_on,
               c.cert_expires_at, c.synced_at, c.tenant_id{extra}
        FROM k8s_clusters c
        WHERE c.tenant_id IS NOT NULL AND {IN_TENANT}
    """)
    op.execute("REVOKE ALL ON k8s_tenant_clusters FROM cm_app")
    op.execute("GRANT SELECT ON k8s_tenant_clusters TO cm_app")


def upgrade() -> None:
    op.drop_constraint(op.f('ck_k8s_clusters_source'), 'k8s_clusters', type_='check')
    op.create_check_constraint(
        op.f('ck_k8s_clusters_source'), 'k8s_clusters', "source IN ('table', 'manual', 'managed')"
    )
    op.add_column('k8s_clusters', sa.Column('state', sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f('ck_k8s_clusters_state'), 'k8s_clusters', f"state IS NULL OR state IN {STATES}"
    )
    op.add_column('k8s_clusters', sa.Column('state_message', sa.Text(), nullable=True))
    op.add_column('k8s_clusters', sa.Column('project_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_k8s_clusters_project_id_projects'), 'k8s_clusters', 'projects',
        ['project_id'], ['id'], ondelete='RESTRICT',
    )
    op.add_column('k8s_clusters', sa.Column('provider_cluster_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_k8s_clusters_provider_cluster_id_provider_clusters'), 'k8s_clusters',
        'provider_clusters', ['provider_cluster_id'], ['id'], ondelete='RESTRICT',
    )
    op.add_column('k8s_clusters', sa.Column('image_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_k8s_clusters_image_id_images'), 'k8s_clusters', 'images',
        ['image_id'], ['id'], ondelete='SET NULL',
    )
    op.add_column('k8s_clusters', sa.Column('kubernetes_version', sa.Text(), nullable=True))
    op.add_column('k8s_clusters', sa.Column(
        'spec', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False,
    ))
    op.add_column('k8s_clusters', sa.Column('created_by', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_k8s_clusters_created_by_users'), 'k8s_clusters', 'users',
        ['created_by'], ['id'], ondelete='SET NULL',
    )
    op.create_check_constraint(
        op.f('ck_k8s_clusters_managed_has_owner'), 'k8s_clusters',
        "source <> 'managed' OR (state IS NOT NULL AND tenant_id IS NOT NULL"
        " AND project_id IS NOT NULL AND provider_cluster_id IS NOT NULL)",
    )

    op.create_table(
        'k8s_node_pools',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('k8s_cluster_id', sa.Uuid(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('role', sa.Text(), nullable=False),
        sa.Column('count', sa.Integer(), nullable=False),
        sa.Column('vcpus', sa.Integer(), nullable=False),
        sa.Column('memory_mb', sa.Integer(), nullable=False),
        sa.Column('disk_gb', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
                  nullable=False),
        sa.CheckConstraint("role IN ('control-plane', 'worker')", name=op.f('ck_k8s_node_pools_role')),
        sa.CheckConstraint("count >= 0", name=op.f('ck_k8s_node_pools_count')),
        sa.ForeignKeyConstraint(['k8s_cluster_id'], ['k8s_clusters.id'],
                                name=op.f('fk_k8s_node_pools_k8s_cluster_id_k8s_clusters'),
                                ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_k8s_node_pools')),
        sa.UniqueConstraint('k8s_cluster_id', 'name', name=op.f('uq_k8s_node_pools_k8s_cluster_id')),
    )
    op.execute("ALTER TABLE k8s_node_pools ENABLE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY k8s_node_pools_platform ON k8s_node_pools FOR ALL"
        f" USING ({PLATFORM}) WITH CHECK ({PLATFORM})"
    )

    op.add_column('instances', sa.Column('k8s_cluster_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_instances_k8s_cluster_id_k8s_clusters'), 'instances', 'k8s_clusters',
        ['k8s_cluster_id'], ['id'], ondelete='SET NULL',
    )
    op.create_index('ix_instances_k8s_cluster_id', 'instances', ['k8s_cluster_id'])
    op.add_column('instances', sa.Column('k8s_pool_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f('fk_instances_k8s_pool_id_k8s_node_pools'), 'instances', 'k8s_node_pools',
        ['k8s_pool_id'], ['id'], ondelete='SET NULL',
    )

    op.add_column('images', sa.Column('kubernetes_version', sa.Text(), nullable=True))

    _tenant_clusters_view(
        ", c.state, c.state_message, c.project_id, c.kubernetes_version, c.spec, c.created_at"
    )
    op.execute(f"""
        CREATE VIEW k8s_tenant_node_pools WITH (security_barrier) AS
        SELECT p.*
        FROM k8s_node_pools p JOIN k8s_clusters c ON c.id = p.k8s_cluster_id
        WHERE c.tenant_id IS NOT NULL AND {IN_TENANT}
    """)
    op.execute("REVOKE ALL ON k8s_tenant_node_pools FROM cm_app")
    op.execute("GRANT SELECT ON k8s_tenant_node_pools TO cm_app")


def downgrade() -> None:
    op.execute("DROP VIEW k8s_tenant_node_pools")
    _tenant_clusters_view("")
    op.drop_column('images', 'kubernetes_version')
    op.drop_constraint(op.f('fk_instances_k8s_pool_id_k8s_node_pools'), 'instances', type_='foreignkey')
    op.drop_column('instances', 'k8s_pool_id')
    op.drop_index('ix_instances_k8s_cluster_id', table_name='instances')
    op.drop_constraint(op.f('fk_instances_k8s_cluster_id_k8s_clusters'), 'instances', type_='foreignkey')
    op.drop_column('instances', 'k8s_cluster_id')
    op.drop_table('k8s_node_pools')
    op.execute("DELETE FROM k8s_clusters WHERE source = 'managed'")
    op.drop_constraint(op.f('ck_k8s_clusters_managed_has_owner'), 'k8s_clusters', type_='check')
    for fk in ('created_by_users', 'image_id_images', 'provider_cluster_id_provider_clusters',
               'project_id_projects'):
        op.drop_constraint(op.f(f'fk_k8s_clusters_{fk}'), 'k8s_clusters', type_='foreignkey')
    op.drop_constraint(op.f('ck_k8s_clusters_state'), 'k8s_clusters', type_='check')
    for col in ('created_by', 'spec', 'kubernetes_version', 'image_id', 'provider_cluster_id',
                'project_id', 'state_message', 'state'):
        op.drop_column('k8s_clusters', col)
    op.drop_constraint(op.f('ck_k8s_clusters_source'), 'k8s_clusters', type_='check')
    op.create_check_constraint(
        op.f('ck_k8s_clusters_source'), 'k8s_clusters', "source IN ('table', 'manual')"
    )
