import base64
from datetime import UTC, date, datetime

import pytest

from app.k8s.kubeconfig import KubeconfigError, decode
from app.k8s.models import K8sCluster
from app.k8s.service import expires_on, status
from tests.k8s_fixtures import kubeconfig_b64


def test_decode_reads_server_and_certificate_expiry():
    kc = decode(kubeconfig_b64("https://k.example:6443", datetime(2027, 2, 18, 12, tzinfo=UTC)))
    assert kc.server == "https://k.example:6443"
    assert kc.cert_expires_at == datetime(2027, 2, 18, 12, tzinfo=UTC)
    assert "client-key-data" in kc.text and len(kc.sha256) == 64


@pytest.mark.parametrize("bad", ["***", base64.b64encode(b"\xff\xfe").decode(),
                                 base64.b64encode(b"a: [").decode(),
                                 base64.b64encode(b"kind: Pod").decode()])
def test_decode_errors_never_echo_content(bad):
    with pytest.raises(KubeconfigError) as err:
        decode(bad)
    assert bad not in str(err.value)


def test_expiry_is_the_earliest_known_date():
    c = K8sCluster(certs_expire_on=date(2099, 4, 10),
                   cert_expires_at=datetime(2026, 4, 10, tzinfo=UTC))
    assert expires_on(c) == date(2026, 4, 10)  # the table drifted; the certificate rules
    assert expires_on(K8sCluster()) is None


@pytest.mark.parametrize(("days", "expected"), [
    (None, "unknown"), (-1, "expired"), (0, "critical"), (7, "critical"), (8, "warning"),
    (30, "warning"), (31, "ok"),
])
def test_status(days, expected):
    assert status(days) == expected
