import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Email = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, to_lower=True, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
    ),
]
NewPassword = Annotated[str, Field(min_length=12, max_length=256)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginRequest(Input):
    email: Email
    password: Annotated[str, Field(min_length=1, max_length=256)]


class ForgotPasswordRequest(Input):
    email: Email


class ResetPasswordRequest(Input):
    token: Annotated[str, Field(min_length=20, max_length=128)]
    new_password: NewPassword


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["Bearer"] = "Bearer"  # noqa: S105 (not a secret)
    expires_in: int


class LoginResponse(TokenResponse):
    user: UserOut


class TenantSummary(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    status: str


class MeResponse(UserOut):
    tenants: list[TenantSummary]
    platform_roles: list[str]
