"""IPAM: local copy of awf_ip_pool, network profiles per server, instance NICs.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-03 14:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0010'
down_revision: str | None = '0009'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('ipam_addresses',
    sa.Column('external_id', sa.BigInteger(), nullable=False),
    sa.Column('address', postgresql.INET(), nullable=False),
    sa.Column('prefix', sa.Integer(), nullable=True),
    sa.Column('hypervisor', sa.Text(), nullable=True),
    sa.Column('node_name', sa.Text(), nullable=True),
    sa.Column('cluster_id', sa.Uuid(), nullable=True),
    sa.Column('assigned', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('mac', sa.Text(), nullable=True),
    sa.Column('hostname', sa.Text(), nullable=True),
    sa.Column('host_owner', sa.Text(), nullable=True),
    sa.Column('ip_block', sa.Text(), nullable=True),
    sa.Column('synced_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['cluster_id'], ['provider_clusters.id'], name=op.f('fk_ipam_addresses_cluster_id_provider_clusters'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_ipam_addresses')),
    sa.UniqueConstraint('external_id', name=op.f('uq_ipam_addresses_external_id'))
    )
    op.create_index(op.f('ix_ipam_addresses_cluster_id'), 'ipam_addresses', ['cluster_id'], unique=False)
    op.create_table('ipam_networks',
    sa.Column('cluster_id', sa.Uuid(), nullable=False),
    sa.Column('cidr', postgresql.CIDR(), nullable=False),
    sa.Column('gateway', postgresql.INET(), nullable=False),
    sa.Column('vlan', sa.Integer(), nullable=True),
    sa.Column('bridge', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['cluster_id'], ['provider_clusters.id'], name=op.f('fk_ipam_networks_cluster_id_provider_clusters'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_ipam_networks')),
    sa.UniqueConstraint('cluster_id', 'cidr', name=op.f('uq_ipam_networks_cluster_id'))
    )
    op.add_column('instances', sa.Column('nics', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column('instances', 'nics')
    op.drop_table('ipam_networks')
    op.drop_table('ipam_addresses')
