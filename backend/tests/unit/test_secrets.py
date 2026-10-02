import os
import uuid

import pytest

from app.core.config import Settings
from app.infra.secrets import (
    LocalKek,
    Sealed,
    SecretsError,
    build_secrets_backend,
    generate_kek,
    seal,
    unseal,
)


@pytest.fixture
def kek() -> LocalKek:
    return LocalKek(os.urandom(32))


def test_roundtrip_and_no_plaintext(kek):
    aad = uuid.uuid4().bytes
    sealed = seal(kek, "super-secret-token", aad)
    assert b"super-secret-token" not in sealed.ciphertext + sealed.dek_wrapped
    assert unseal(kek, sealed, aad) == "super-secret-token"


def test_each_seal_uses_a_fresh_dek(kek):
    a, b = seal(kek, "x", b"id"), seal(kek, "x", b"id")
    assert a.ciphertext != b.ciphertext and a.dek_wrapped != b.dek_wrapped


def test_ciphertext_bound_to_record(kek):
    sealed = seal(kek, "secret", b"cluster-a")
    with pytest.raises(SecretsError):
        unseal(kek, sealed, b"cluster-b")


def test_wrong_kek_and_tampering(kek):
    sealed = seal(kek, "secret", b"id")
    with pytest.raises(SecretsError):
        unseal(LocalKek(os.urandom(32)), sealed, b"id")
    tampered = Sealed(sealed.ciphertext[:-1] + b"\0", sealed.dek_wrapped, sealed.kek_ref)
    with pytest.raises(SecretsError):
        unseal(kek, tampered, b"id")
    with pytest.raises(SecretsError):
        unseal(kek, Sealed(sealed.ciphertext, sealed.dek_wrapped, "vault:x"), b"id")


def test_backend_from_settings():
    assert build_secrets_backend(Settings(env="test")) is None
    backend = build_secrets_backend(Settings(env="test", kek=generate_kek()))
    assert isinstance(backend, LocalKek)
    with pytest.raises(SecretsError):
        build_secrets_backend(Settings(env="test", kek="c2hvcnQ="))  # 5 bytes
