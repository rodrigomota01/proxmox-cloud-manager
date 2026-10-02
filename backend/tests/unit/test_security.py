import time
import uuid

import jwt
import pytest

from app.core.config import Settings
from app.core.ids import uuid7
from app.core.security import (
    decode_access_token,
    generate_private_key_pem,
    hash_password,
    issue_access_token,
    verify_password,
)
from app.iam.catalog import PERMISSIONS, ROLES


def test_uuid7_version_variant_and_order():
    ids = [uuid7() for _ in range(50)]
    assert all(u.version == 7 and u.variant == uuid.RFC_4122 for u in ids)
    time.sleep(0.002)
    assert uuid7() > ids[0]


def test_password_hash_roundtrip():
    h = hash_password("correct horse battery staple")
    assert h.startswith("$argon2id$")
    assert verify_password(h, "correct horse battery staple")
    assert not verify_password(h, "wrong")
    assert not verify_password(None, "anything")
    assert not verify_password("not-a-hash", "anything")


@pytest.fixture
def settings() -> Settings:
    pem = generate_private_key_pem().replace("\n", "\\n")  # as written by `gen-keys`
    return Settings(env="test", jwt_private_key=pem)


def test_access_token_roundtrip(settings):
    uid, sid = uuid7(), uuid7()
    claims = decode_access_token(
        settings, issue_access_token(settings, user_id=uid, session_id=sid, amr=["pwd"])
    )
    assert claims["sub"] == str(uid) and claims["sid"] == str(sid)
    assert claims["aud"] == "cloud-manager-api" and claims["amr"] == ["pwd"]


def test_access_token_rejects_other_key_and_expired(settings):
    other = Settings(env="test", jwt_private_key=generate_private_key_pem())
    token = issue_access_token(other, user_id=uuid7(), session_id=uuid7(), amr=["pwd"])
    with pytest.raises(jwt.InvalidSignatureError):
        decode_access_token(settings, token)

    expired = settings.model_copy(update={"access_token_ttl_seconds": -1})
    token = issue_access_token(expired, user_id=uuid7(), session_id=uuid7(), amr=["pwd"])
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_access_token(settings, token)


def test_missing_key_outside_dev_fails():
    from app.core.security import signing_key

    with pytest.raises(RuntimeError):
        signing_key(Settings(env="production"))


def test_catalog_roles_only_use_known_permissions():
    for name, (_, scopes, perms) in ROLES.items():
        assert perms <= set(PERMISSIONS), name
        assert set(scopes) <= {"platform", "tenant", "project"}


@pytest.mark.parametrize(
    ("role", "allowed", "denied"),
    [
        ("OPERATOR", {"vm:start", "container:console"}, {"vm:create", "vm:delete"}),
        ("READ_ONLY", {"vm:view", "quota:view"}, {"vm:start", "snapshot:create"}),
        ("TENANT_ADMIN", {"member:manage", "audit:view"}, {"vm:migrate", "quota:manage"}),
        ("PROJECT_ADMIN", {"member:manage"}, {"project:create", "audit:view"}),
        ("PLATFORM_ADMIN", {"cluster:manage", "quota:manage"}, {"platform:admin"}),
    ],
)
def test_matrix_spot_checks(role, allowed, denied):
    perms = ROLES[role][2]
    assert allowed <= perms
    assert not (denied & perms)
