"""What a kubeconfig says about itself: API server and client certificate expiry.

The kubeconfig carries a client certificate and key (cluster-admin, typically). Parsing
never logs or returns any of it; errors name the problem, not the content.
"""

import base64
import binascii
import hashlib
from dataclasses import dataclass
from datetime import datetime

import yaml
from cryptography import x509


class KubeconfigError(ValueError):
    pass


@dataclass(frozen=True)
class Kubeconfig:
    text: str  # decoded YAML: the secret itself
    sha256: str
    server: str | None
    cert_expires_at: datetime | None  # earliest client certificate's notAfter (UTC)


def decode(b64: str) -> Kubeconfig:
    try:
        text = base64.b64decode(b64, validate=False).decode()
    except (binascii.Error, UnicodeDecodeError):
        raise KubeconfigError("config is not base64 text") from None
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError:
        raise KubeconfigError("config is not valid YAML") from None
    if not isinstance(doc, dict) or doc.get("kind", "Config") != "Config":
        raise KubeconfigError("config is not a kubeconfig")

    servers = [
        (c.get("cluster") or {}).get("server")
        for c in doc.get("clusters") or [] if isinstance(c, dict)
    ]
    expiries = []
    for u in doc.get("users") or []:
        cert = ((u or {}).get("user") or {}).get("client-certificate-data")
        if not cert:
            continue
        try:
            pem = base64.b64decode(cert)
            expiries.append(x509.load_pem_x509_certificate(pem).not_valid_after_utc)
        except (binascii.Error, ValueError):
            raise KubeconfigError("client certificate cannot be read") from None
    return Kubeconfig(
        text=text,
        sha256=hashlib.sha256(text.encode()).hexdigest(),
        server=next((s for s in servers if s), None),
        cert_expires_at=min(expiries) if expiries else None,
    )
