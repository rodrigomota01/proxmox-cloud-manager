from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.billing.accrual import hour_slices
from app.billing.pricing import Rates, cost_for, monthly_cost
from app.billing.service import month_of
from app.core.errors import ValidationError

RATES = Rates(monthly={
    "vcpu": Decimal("73"), "memory_gb": Decimal("36.5"), "disk_gb": Decimal("0.73"),
    "instance": Decimal("7.3"),
})


def test_hour_slices_cut_on_utc_hours():
    start = datetime(2026, 10, 7, 9, 40, tzinfo=UTC)
    slices = hour_slices(start, start + timedelta(hours=2))
    assert slices == [
        (datetime(2026, 10, 7, 9, tzinfo=UTC), 1200),
        (datetime(2026, 10, 7, 10, tzinfo=UTC), 3600),
        (datetime(2026, 10, 7, 11, tzinfo=UTC), 2400),
    ]
    assert hour_slices(start, start) == []


def test_running_pays_compute_stopped_pays_disk_and_fee():
    running = monthly_cost(RATES, vcpus=2, memory_mb=2048, disk_gb=20, running=True)
    stopped = monthly_cost(RATES, vcpus=2, memory_mb=2048, disk_gb=20, running=False)
    assert running.total == Decimal("240.9")  # (0.2 + 0.1 + 0.02 + 0.01) x 730
    assert (stopped.vcpu, stopped.memory) == (0, 0)
    assert stopped.total == Decimal("21.9")
    assert cost_for(3600, running).total == Decimal("0.33")


def test_missing_prices_are_free():
    assert monthly_cost(Rates(), vcpus=8, memory_mb=8192, disk_gb=100, running=True).total == 0


def test_months_follow_the_billing_timezone():
    # 02:00 UTC on Nov 1st is still October in São Paulo (UTC-3)
    now = datetime(2026, 11, 1, 2, tzinfo=UTC)
    m = month_of(None, "America/Sao_Paulo", now)
    assert m.label == "2026-10" and m.current
    assert m.end.astimezone(UTC) == datetime(2026, 11, 1, 3, tzinfo=UTC)
    assert m.hours_left(now) == 1
    december = month_of("2025-12", "America/Sao_Paulo", now)
    assert december.end.year == 2026 and not december.current
    with pytest.raises(ValidationError):
        month_of("2026-12", "America/Sao_Paulo", now)  # future
    with pytest.raises(ValidationError):
        month_of("2026-13", "America/Sao_Paulo", now)
