"""Operational commands: python -m app.cli <command>

  migrate        alembic upgrade head + sync RBAC catalog   (CM_MIGRATION_DATABASE_URL)
  create-admin   create a SUPER_ADMIN user (bootstrap)        (CM_MIGRATION_DATABASE_URL)
  gen-keys       print a new CM_JWT_PRIVATE_KEY for .env
"""

import argparse
import asyncio
import getpass
import os
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import select

from app.audit import service as audit
from app.core.config import get_settings
from app.core.security import generate_private_key_pem, hash_password
from app.db.session import create_engine, create_sessionmaker
from app.iam.catalog import sync_catalog
from app.iam.models import Role, RoleBinding, User

ALEMBIC_INI = Path(__file__).resolve().parent.parent / "alembic.ini"


def migrate() -> None:
    command.upgrade(Config(str(ALEMBIC_INI)), "head")
    asyncio.run(_sync_catalog())
    print("database at head; RBAC catalog synced")


async def _sync_catalog() -> None:
    engine = create_engine(get_settings(), migration=True)
    try:
        async with create_sessionmaker(engine)() as session, session.begin():
            await sync_catalog(session)
    finally:
        await engine.dispose()


async def create_admin(email: str, display_name: str, password: str) -> None:
    settings = get_settings()
    engine = create_engine(settings, migration=True)  # owner: bypasses RLS for bootstrap
    try:
        async with create_sessionmaker(engine)() as session, session.begin():
            email = email.strip().lower()
            if (await session.execute(select(User).where(User.email == email))).first():
                raise SystemExit(f"user {email} already exists")
            role_id = (
                await session.execute(select(Role.id).where(Role.name == "SUPER_ADMIN"))
            ).scalar_one()
            user = User(
                email=email, display_name=display_name, password_hash=hash_password(password)
            )
            session.add(user)
            await session.flush()
            session.add(RoleBinding(user_id=user.id, role_id=role_id, scope_type="platform"))
            await audit.record(
                session, "ADMIN_BOOTSTRAP", actor_user_id=user.id,
                resource_type="user", resource_id=user.id, details={"via": "cli"},
            )
        print(f"created SUPER_ADMIN {email} ({user.id})")
    finally:
        await engine.dispose()


def _read_password() -> str:
    if pw := os.environ.get("CM_ADMIN_PASSWORD"):
        return pw
    first = getpass.getpass("password (min 12 chars): ")
    if getpass.getpass("repeat: ") != first:
        raise SystemExit("passwords do not match")
    return first


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    p_admin = sub.add_parser("create-admin")
    p_admin.add_argument("--email", required=True)
    p_admin.add_argument("--name", required=True)
    sub.add_parser("gen-keys")
    args = parser.parse_args(argv)

    if args.cmd == "migrate":
        migrate()
    elif args.cmd == "create-admin":
        password = _read_password()
        if len(password) < 12:
            raise SystemExit("password must have at least 12 characters")
        asyncio.run(create_admin(args.email, args.name, password))
    elif args.cmd == "gen-keys":
        pem = generate_private_key_pem().strip().replace("\n", "\\n")
        sys.stdout.write(f'CM_JWT_PRIVATE_KEY="{pem}"\n')


if __name__ == "__main__":
    main()
