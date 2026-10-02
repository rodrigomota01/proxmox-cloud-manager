"""Envelope encryption for provider secrets (ADR-0007).

Each secret gets its own random DEK (AES-256-GCM). The DEK is wrapped by a KEK held by
a SecretsBackend: a local key from CM_KEK today, Vault Transit later (same interface).
The record id is bound as AAD, so a ciphertext copied to another row does not decrypt.
"""

import base64
import os
from dataclasses import dataclass
from typing import Protocol

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import Settings

_NONCE = 12


class SecretsError(Exception):
    pass


class SecretsBackend(Protocol):
    kek_ref: str

    def wrap(self, dek: bytes, aad: bytes) -> bytes: ...
    def unwrap(self, wrapped: bytes, aad: bytes) -> bytes: ...


class LocalKek:
    def __init__(self, key: bytes, ref: str = "local:v1") -> None:
        if len(key) != 32:
            raise SecretsError("CM_KEK must be 32 bytes (base64)")
        self._aead = AESGCM(key)
        self.kek_ref = ref

    def wrap(self, dek: bytes, aad: bytes) -> bytes:
        nonce = os.urandom(_NONCE)
        return nonce + self._aead.encrypt(nonce, dek, aad)

    def unwrap(self, wrapped: bytes, aad: bytes) -> bytes:
        try:
            return self._aead.decrypt(wrapped[:_NONCE], wrapped[_NONCE:], aad)
        except InvalidTag as exc:
            raise SecretsError("cannot unwrap data key (wrong KEK or tampered record)") from exc


@dataclass(frozen=True)
class Sealed:
    ciphertext: bytes
    dek_wrapped: bytes
    kek_ref: str


def seal(backend: SecretsBackend, plaintext: str, aad: bytes) -> Sealed:
    dek = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(_NONCE)
    ciphertext = nonce + AESGCM(dek).encrypt(nonce, plaintext.encode(), aad)
    return Sealed(ciphertext, backend.wrap(dek, aad), backend.kek_ref)


def unseal(backend: SecretsBackend, sealed: Sealed, aad: bytes) -> str:
    if sealed.kek_ref != backend.kek_ref:
        raise SecretsError(f"secret sealed with {sealed.kek_ref}, backend is {backend.kek_ref}")
    dek = backend.unwrap(sealed.dek_wrapped, aad)
    try:
        data = AESGCM(dek).decrypt(sealed.ciphertext[:_NONCE], sealed.ciphertext[_NONCE:], aad)
    except InvalidTag as exc:
        raise SecretsError("cannot decrypt secret (tampered record)") from exc
    return data.decode()


def generate_kek() -> str:
    return base64.b64encode(os.urandom(32)).decode()


def build_secrets_backend(settings: Settings) -> SecretsBackend | None:
    """None when no KEK is configured: storing/using provider credentials then fails
    with a clear error instead of silently using a throwaway key."""
    if settings.kek is None:
        return None
    try:
        key = base64.b64decode(settings.kek.get_secret_value(), validate=True)
    except ValueError as exc:
        raise SecretsError("CM_KEK must be base64") from exc
    return LocalKek(key)
