"""Outgoing e-mail. Dev uses Mailpit (SMTP without auth/TLS on the internal network);
production uses STARTTLS or implicit TLS, with a login, and always verifies the certificate."""

import asyncio
import logging
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Literal, Protocol

from app.core.config import Settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Mail:
    to: str
    subject: str
    body: str  # plain text: always sent, for clients that do not render HTML
    html: str | None = None  # richer alternative of the same message


class Mailer(Protocol):
    async def send(self, mail: Mail) -> None: ...


class SmtpMailer:
    def __init__(
        self,
        host: str,
        port: int,
        sender: str,
        tls: Literal["none", "starttls", "ssl"] = "none",
        login: tuple[str, str] | None = None,
    ) -> None:
        self.host, self.port, self.sender, self.tls, self.login = host, port, sender, tls, login

    def _send_sync(self, mail: Mail) -> None:
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = self.sender, mail.to, mail.subject
        msg.set_content(mail.body)
        if mail.html:
            msg.add_alternative(mail.html, subtype="html")
        context = ssl.create_default_context()
        if self.tls == "ssl":
            smtp = smtplib.SMTP_SSL(self.host, self.port, timeout=10, context=context)
        else:
            smtp = smtplib.SMTP(self.host, self.port, timeout=10)
        with smtp:
            if self.tls == "starttls":
                smtp.starttls(context=context)  # raises if the server does not offer it
            if self.login:
                smtp.login(*self.login)
            smtp.send_message(msg)

    async def send(self, mail: Mail) -> None:
        await asyncio.to_thread(self._send_sync, mail)


class LogOnlyMailer:
    """Used when no SMTP is configured. Never logs the body (it carries tokens)."""

    async def send(self, mail: Mail) -> None:
        logger.warning("smtp not configured; e-mail dropped", extra={"subject": mail.subject})


async def send_logged(mailer: Mailer, mail: Mail) -> None:
    """For sends in a background task, after the response: a failure becomes one log line
    (no traceback, never the body) instead of an unhandled error."""
    try:
        await mailer.send(mail)
    except (OSError, smtplib.SMTPException) as e:  # ssl.SSLError is an OSError
        logger.error(
            "e-mail not sent", extra={"subject": mail.subject, "error": f"{type(e).__name__}: {e}"}
        )


def build_mailer(settings: Settings) -> Mailer:
    if settings.smtp_host:
        login = None
        if settings.smtp_username and settings.smtp_password:
            login = (settings.smtp_username, settings.smtp_password.get_secret_value())
        return SmtpMailer(
            settings.smtp_host, settings.smtp_port, settings.smtp_from, settings.smtp_tls, login
        )
    return LogOnlyMailer()
