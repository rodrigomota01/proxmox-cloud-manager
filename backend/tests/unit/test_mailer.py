from typing import ClassVar

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.infra import mailer as mailer_mod
from app.infra.mailer import LogOnlyMailer, Mail, SmtpMailer, build_mailer, send_logged

pytestmark = pytest.mark.anyio

MAIL = Mail(to="ana@exemplo.com", subject="Convite", body="token")


class FakeSmtp:
    """Records the calls smtplib.SMTP / SMTP_SSL would get."""

    instances: ClassVar[list["FakeSmtp"]] = []

    def __init__(self, host, port, timeout, context=None):
        self.args, self.calls = (host, port, context), []
        FakeSmtp.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self, context):
        self.calls.append(("starttls", context))

    def login(self, user, password):
        self.calls.append(("login", user, password))

    def send_message(self, msg):
        self.calls.append(("send", msg["To"]))


@pytest.fixture(autouse=True)
def fake_smtp(monkeypatch):
    FakeSmtp.instances = []
    monkeypatch.setattr(mailer_mod.smtplib, "SMTP", FakeSmtp)
    monkeypatch.setattr(mailer_mod.smtplib, "SMTP_SSL", FakeSmtp)


def _settings(**kw) -> Settings:
    return Settings(_env_file=None, **kw)


async def test_plain_smtp_for_dev():
    await SmtpMailer("mailpit", 1025, "cm@x").send(MAIL)
    (smtp,) = FakeSmtp.instances
    assert smtp.calls == [("send", "ana@exemplo.com")]


async def test_starttls_then_login_then_send():
    m = build_mailer(_settings(
        smtp_host="mail.exemplo.com", smtp_port=587, smtp_tls="starttls",
        smtp_username="no-reply@exemplo.com", smtp_password="s3nha",
    ))
    await m.send(MAIL)
    (smtp,) = FakeSmtp.instances
    assert [c[0] for c in smtp.calls] == ["starttls", "login", "send"]
    assert smtp.calls[0][1].verify_mode.name == "CERT_REQUIRED"
    assert smtp.calls[1] == ("login", "no-reply@exemplo.com", "s3nha")


async def test_implicit_tls_verifies_the_certificate():
    m = build_mailer(_settings(
        smtp_host="mail.exemplo.com", smtp_port=465, smtp_tls="ssl",
        smtp_username="no-reply@exemplo.com", smtp_password="s3nha",
    ))
    await m.send(MAIL)
    (smtp,) = FakeSmtp.instances
    assert smtp.args[2].verify_mode.name == "CERT_REQUIRED"
    assert [c[0] for c in smtp.calls] == ["login", "send"]


def test_login_without_tls_is_refused():
    with pytest.raises(ValidationError, match="requires CM_SMTP_TLS"):
        _settings(smtp_host="mail.exemplo.com", smtp_username="u", smtp_password="p")


def test_username_without_password_is_refused():
    with pytest.raises(ValidationError, match="go together"):
        _settings(smtp_host="mail.exemplo.com", smtp_tls="starttls", smtp_username="u")


def test_empty_values_from_compose_are_unset():
    s = _settings(smtp_host="", smtp_username="", smtp_password="")
    assert isinstance(build_mailer(s), LogOnlyMailer)


async def test_send_logged_turns_a_failure_into_one_log_line(caplog):
    class Refused:
        async def send(self, mail):
            raise mailer_mod.smtplib.SMTPAuthenticationError(535, b"authentication failed")

    await send_logged(Refused(), MAIL)  # does not raise
    (record,) = [r for r in caplog.records if r.message == "e-mail not sent"]
    assert record.error.startswith("SMTPAuthenticationError: (535")
    assert record.exc_info is None and "token" not in record.getMessage()
