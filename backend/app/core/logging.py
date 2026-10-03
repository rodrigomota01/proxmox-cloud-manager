"""Structured JSON logging (stdlib only for now; structlog/OTel arrive in Phase 1/5)."""

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from app.core.request_id import current_request_id

_REDACT = ("password", "token", "secret", "authorization", "cookie", "sshkeys")
_RESERVED = set(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime"}


def _redact(key: str, value: Any) -> Any:
    return "[REDACTED]" if any(word in key.lower() for word in _REDACT) else value


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "service": self.service,
            "logger": record.name,
            "message": record.getMessage(),
        }
        rid = current_request_id()
        if rid:
            payload["request_id"] = rid
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = _redact(key, value)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(service: str, level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    logging.getLogger("httpx").setLevel(logging.WARNING)  # per-request INFO lines are noise
    # uvicorn installs its own handlers; route them through ours
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
