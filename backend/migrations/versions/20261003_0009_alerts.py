"""Alert rules, alerts and notification channels (+ default platform rules).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-03 11:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0009'
down_revision: str | None = '0008'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# name, target, metric, threshold, duration (s), severity
DEFAULT_RULES = [
    ("Hypervisor com CPU alta", "node", "cpu", 0.90, 600, "critical"),
    ("Hypervisor com memória alta", "node", "memory", 0.90, 600, "critical"),
    ("Storage quase cheio", "storage", "disk", 0.85, 0, "warning"),
    ("Storage cheio", "storage", "disk", 0.95, 0, "critical"),
    ("VM com CPU alta", "instance", "cpu", 0.95, 900, "warning"),
    ("VM com memória alta", "instance", "memory", 0.95, 900, "warning"),
    ("VM com disco quase cheio", "instance", "disk", 0.90, 0, "warning"),
    ("VM com disco cheio", "instance", "disk", 0.97, 0, "critical"),
]


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    ]


def upgrade() -> None:
    op.create_table('alert_rules',
    sa.Column('tenant_id', sa.Uuid(), nullable=True),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('target', sa.Text(), nullable=False),
    sa.Column('metric', sa.Text(), nullable=False),
    sa.Column('threshold', sa.Float(), nullable=False),
    sa.Column('duration_seconds', sa.Integer(), server_default='300', nullable=False),
    sa.Column('severity', sa.Text(), server_default='warning', nullable=False),
    sa.Column('enabled', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    *_timestamps(),
    sa.CheckConstraint("target IN ('node', 'storage', 'instance')", name=op.f('ck_alert_rules_target')),
    sa.CheckConstraint("metric IN ('cpu', 'memory', 'disk', 'net_in', 'net_out')", name=op.f('ck_alert_rules_metric')),
    sa.CheckConstraint("severity IN ('warning', 'critical')", name=op.f('ck_alert_rules_severity')),
    sa.CheckConstraint("tenant_id IS NULL OR target = 'instance'", name=op.f('ck_alert_rules_tenant_target')),
    sa.CheckConstraint('threshold > 0 AND duration_seconds >= 0', name=op.f('ck_alert_rules_limits')),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], name=op.f('fk_alert_rules_tenant_id_tenants'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_alert_rules'))
    )
    op.create_index(op.f('ix_alert_rules_tenant_id'), 'alert_rules', ['tenant_id'], unique=False)

    op.create_table('alerts',
    sa.Column('rule_id', sa.Uuid(), nullable=False),
    sa.Column('rule_tenant_id', sa.Uuid(), nullable=True),
    sa.Column('tenant_id', sa.Uuid(), nullable=True),
    sa.Column('project_id', sa.Uuid(), nullable=True),
    sa.Column('resource_type', sa.Text(), nullable=False),
    sa.Column('resource_id', sa.Uuid(), nullable=False),
    sa.Column('resource_name', sa.Text(), nullable=False),
    sa.Column('rule_name', sa.Text(), nullable=False),
    sa.Column('metric', sa.Text(), nullable=False),
    sa.Column('threshold', sa.Float(), nullable=False),
    sa.Column('severity', sa.Text(), nullable=False),
    sa.Column('value', sa.Float(), nullable=False),
    sa.Column('peak', sa.Float(), nullable=False),
    sa.Column('state', sa.Text(), server_default='pending', nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('fired_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.CheckConstraint("state IN ('pending', 'firing', 'resolved')", name=op.f('ck_alerts_state')),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_alerts_project_id_projects'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['rule_id'], ['alert_rules.id'], name=op.f('fk_alerts_rule_id_alert_rules'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['rule_tenant_id'], ['tenants.id'], name=op.f('fk_alerts_rule_tenant_id_tenants'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], name=op.f('fk_alerts_tenant_id_tenants'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_alerts'))
    )
    op.create_index('ix_alerts_tenant_state', 'alerts', ['tenant_id', 'state'], unique=False)
    op.create_index('uq_alerts_open', 'alerts', ['rule_id', 'resource_id'], unique=True, postgresql_where=sa.text("state IN ('pending', 'firing')"))

    op.create_table('notification_channels',
    sa.Column('tenant_id', sa.Uuid(), nullable=True),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('type', sa.Text(), nullable=False),
    sa.Column('config', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('min_severity', sa.Text(), server_default='warning', nullable=False),
    sa.Column('enabled', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('secret_ciphertext', sa.LargeBinary(), nullable=True),
    sa.Column('dek_wrapped', sa.LargeBinary(), nullable=True),
    sa.Column('kek_ref', sa.Text(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    *_timestamps(),
    sa.CheckConstraint("type IN ('email', 'webhook')", name=op.f('ck_notification_channels_type')),
    sa.CheckConstraint("min_severity IN ('warning', 'critical')", name=op.f('ck_notification_channels_min_severity')),
    sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], name=op.f('fk_notification_channels_tenant_id_tenants'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_notification_channels'))
    )
    op.create_index(op.f('ix_notification_channels_tenant_id'), 'notification_channels', ['tenant_id'], unique=False)

    platform = "current_setting('app.platform_scope', true) = 'on'"
    in_tenant = (
        "tenant_id = ANY (string_to_array(current_setting('app.tenant_ids', true), ',')::uuid[])"
    )
    # rules and channels: platform ones (tenant_id NULL) only in platform scope
    for table in ("alert_rules", "notification_channels", "alerts"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    for table in ("alert_rules", "notification_channels"):
        cond = f"{platform} OR {in_tenant}"
        op.execute(f"CREATE POLICY {table}_scope ON {table} FOR ALL USING ({cond}) WITH CHECK ({cond})")
    # alerts: tenants read those on their resources; only the worker (platform) writes
    op.execute(f"CREATE POLICY alerts_read ON alerts FOR SELECT USING ({platform} OR {in_tenant})")
    op.execute(f"CREATE POLICY alerts_write ON alerts FOR ALL USING ({platform}) WITH CHECK ({platform})")

    rules = sa.table(
        'alert_rules', sa.column('id', sa.Uuid()), sa.column('name', sa.Text()),
        sa.column('target', sa.Text()), sa.column('metric', sa.Text()),
        sa.column('threshold', sa.Float()), sa.column('duration_seconds', sa.Integer()),
        sa.column('severity', sa.Text()),
    )
    from app.core.ids import uuid7

    op.bulk_insert(rules, [
        {"id": uuid7(), "name": n, "target": t, "metric": m, "threshold": th,
         "duration_seconds": d, "severity": sev}
        for n, t, m, th, d, sev in DEFAULT_RULES
    ])


def downgrade() -> None:
    op.drop_table('notification_channels')
    op.drop_table('alerts')
    op.drop_table('alert_rules')
