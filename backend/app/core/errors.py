"""RFC 9457 problem+json errors with stable codes (docs/architecture/05-api.md)."""

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.request_id import current_request_id

logger = logging.getLogger(__name__)

PROBLEM_JSON = "application/problem+json"
_TYPE_BASE = "https://cloud-manager.dev/errors/"


class AppError(Exception):
    status: int = 500
    code: str = "INTERNAL_ERROR"
    title: str = "Internal error"

    def __init__(
        self,
        detail: str | None = None,
        *,
        errors: list[dict[str, str]] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail or self.title)
        self.detail = detail
        self.errors = errors
        self.headers = headers


class ValidationError(AppError):
    status, code, title = 422, "VALIDATION_ERROR", "Validation error"


class Unauthenticated(AppError):
    status, code, title = 401, "UNAUTHENTICATED", "Authentication required"


class Forbidden(AppError):
    status, code, title = 403, "FORBIDDEN", "Forbidden"


class NotFound(AppError):
    status, code, title = 404, "NOT_FOUND", "Not found"


class Conflict(AppError):
    status, code, title = 409, "CONFLICT", "Conflict"


class RateLimited(AppError):
    status, code, title = 429, "RATE_LIMITED", "Too many requests"

    def __init__(self, retry_after: int) -> None:
        super().__init__(headers={"Retry-After": str(retry_after)})


def problem(
    status: int,
    code: str,
    title: str,
    detail: str | None = None,
    errors: list[dict[str, str]] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    body: dict[str, Any] = {
        "type": _TYPE_BASE + code.lower().replace("_", "-"),
        "title": title,
        "status": status,
        "code": code,
        "request_id": current_request_id(),
    }
    if detail:
        body["detail"] = detail
    if errors:
        body["errors"] = errors
    return JSONResponse(body, status_code=status, media_type=PROBLEM_JSON, headers=headers)


_HTTP_CODES = {
    401: ("UNAUTHENTICATED", "Authentication required"),
    403: ("FORBIDDEN", "Forbidden"),
    404: ("NOT_FOUND", "Not found"),
    405: ("METHOD_NOT_ALLOWED", "Method not allowed"),
}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return problem(exc.status, exc.code, exc.title, exc.detail, exc.errors, exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {
                "field": ".".join(str(p) for p in err["loc"] if p != "body"),
                "message": err["msg"],
            }
            for err in exc.errors()
        ]
        return problem(422, "VALIDATION_ERROR", "Validation error", errors=errors)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code, title = _HTTP_CODES.get(exc.status_code, ("HTTP_ERROR", "HTTP error"))
        return problem(exc.status_code, code, title, headers=getattr(exc, "headers", None))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled error", extra={"error": type(exc).__name__})
        return problem(500, "INTERNAL_ERROR", "Internal error")
