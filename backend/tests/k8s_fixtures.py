"""Throwaway kubeconfigs with a real (self-signed) client certificate."""

import base64
from datetime import UTC, datetime

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def kubeconfig_b64(server: str, not_after: datetime) -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "kubernetes-admin")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime(2025, 1, 1, tzinfo=UTC)).not_valid_after(not_after)
        .sign(key, hashes.SHA256())
    )
    pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    text = f"""apiVersion: v1
kind: Config
clusters:
- name: k
  cluster:
    server: {server}
    certificate-authority-data: {b64(pem)}
users:
- name: kubernetes-admin
  user:
    client-certificate-data: {b64(pem)}
    client-key-data: {b64(key_pem)}
contexts:
- name: admin@k
  context: {{cluster: k, user: kubernetes-admin}}
current-context: admin@k
"""
    return b64(text.encode())
