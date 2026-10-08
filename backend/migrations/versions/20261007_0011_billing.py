"""Billing: price tables (versioned items), tenant price table, hourly usage records.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-07 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0011'
down_revision: str | None = '0010'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RESOURCES = ("vcpu", "memory_gb", "disk_gb", "instance")


def _money(name: str) -> sa.Column:
    return sa.Column(name, sa.Numeric(18, 6), server_default='0', nullable=False)


def upgrade() -> None:
    op.create_table('price_tables',
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('description', sa.Text(), server_default='', nullable=False),
    sa.Column('is_default', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_price_tables')),
    sa.UniqueConstraint('name', name=op.f('uq_price_tables_name'))
    )
    op.create_index('uq_price_tables_default', 'price_tables', ['is_default'], unique=True, postgresql_where=sa.text('is_default'))

    op.create_table('price_items',
    sa.Column('price_table_id', sa.Uuid(), nullable=False),
    sa.Column('resource', sa.Text(), nullable=False),
    sa.Column('monthly_price', sa.Numeric(18, 6), nullable=False),
    sa.Column('effective_from', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.CheckConstraint(f"resource IN {RESOURCES}", name=op.f('ck_price_items_resource')),
    sa.CheckConstraint('monthly_price >= 0', name=op.f('ck_price_items_price')),
    sa.ForeignKeyConstraint(['price_table_id'], ['price_tables.id'], name=op.f('fk_price_items_price_table_id_price_tables'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_price_items')),
    sa.UniqueConstraint('price_table_id', 'resource', 'effective_from', name=op.f('uq_price_items_price_table_id'))
    )

    op.add_column('tenants', sa.Column('price_table_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(op.f('fk_tenants_price_table_id_price_tables'), 'tenants', 'price_tables', ['price_table_id'], ['id'], ondelete='SET NULL')

    op.create_table('usage_records',
    sa.Column('tenant_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=True),
    sa.Column('instance_id', sa.Uuid(), nullable=False),
    sa.Column('price_table_id', sa.Uuid(), nullable=True),
    sa.Column('period_start', sa.DateTime(timezone=True), nullable=False),
    sa.Column('instance_name', sa.Text(), nullable=False),
    sa.Column('vcpus', sa.Integer(), nullable=False),
    sa.Column('memory_mb', sa.Integer(), nullable=False),
    sa.Column('disk_gb', sa.Integer(), nullable=False),
    sa.Column('seconds', sa.Integer(), server_default='0', nullable=False),
    sa.Column('running_seconds', sa.Integer(), server_default='0', nullable=False),
    _money('cost_vcpu'),
    _money('cost_memory'),
    _money('cost_disk'),
    _money('cost_instance'),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.CheckConstraint('running_seconds <= seconds', name=op.f('ck_usage_records_seconds')),
    sa.ForeignKeyConstraint(['instance_id'], ['instances.id'], name=op.f('fk_usage_records_instance_id_instances'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['price_table_id'], ['price_tables.id'], name=op.f('fk_usage_records_price_table_id_price_tables'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_usage_records_project_id_projects'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], name=op.f('fk_usage_records_tenant_id_tenants'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_usage_records')),
    sa.UniqueConstraint('instance_id', 'period_start', name=op.f('uq_usage_records_instance_id'))
    )
    op.create_index('ix_usage_records_tenant_period', 'usage_records', ['tenant_id', 'period_start'], unique=False)

    op.create_table('billing_cursor',
    sa.Column('id', sa.Integer(), autoincrement=False, nullable=False),
    sa.Column('accrued_until', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint('id = 1', name=op.f('ck_billing_cursor_single_row')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_billing_cursor'))
    )

    # price tables and the cursor are global (no RLS, like provider_clusters): reached
    # only through platform routes or the tenant's own projection. Usage records are
    # read by their tenant and written only by the worker (platform scope).
    platform = "current_setting('app.platform_scope', true) = 'on'"
    in_tenant = (
        "tenant_id = ANY (string_to_array(current_setting('app.tenant_ids', true), ',')::uuid[])"
    )
    op.execute("ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY")
    op.execute(f"CREATE POLICY usage_records_read ON usage_records FOR SELECT USING ({platform} OR {in_tenant})")
    op.execute(f"CREATE POLICY usage_records_write ON usage_records FOR ALL USING ({platform}) WITH CHECK ({platform})")

    from app.core.ids import uuid7

    table_id = uuid7()
    op.bulk_insert(
        sa.table('price_tables', sa.column('id', sa.Uuid()), sa.column('name', sa.Text()),
                 sa.column('description', sa.Text()), sa.column('is_default', sa.Boolean())),
        [{"id": table_id, "name": "Padrão", "is_default": True,
          "description": "Clientes sem tabela própria. Defina os preços em Plataforma → Preços."}],
    )
    op.bulk_insert(
        sa.table('price_items', sa.column('id', sa.Uuid()), sa.column('price_table_id', sa.Uuid()),
                 sa.column('resource', sa.Text()), sa.column('monthly_price', sa.Numeric(18, 6))),
        [{"id": uuid7(), "price_table_id": table_id, "resource": r, "monthly_price": 0}
         for r in RESOURCES],
    )


def downgrade() -> None:
    op.drop_table('billing_cursor')
    op.drop_table('usage_records')
    op.drop_constraint(op.f('fk_tenants_price_table_id_price_tables'), 'tenants', type_='foreignkey')
    op.drop_column('tenants', 'price_table_id')
    op.drop_table('price_items')
    op.drop_table('price_tables')
