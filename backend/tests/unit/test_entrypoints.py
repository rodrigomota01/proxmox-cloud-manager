"""Entry points import cleanly in a fresh interpreter (the test process itself imports
everything, which once hid a missing mapper in the CLI)."""

import subprocess
import sys

import pytest

# resolving every FK target is what the first flush does (and what failed in the CLI)
SNIPPET = (
    "import {module}\n"
    "from app.db.base import Base\n"
    "[fk.column for t in Base.metadata.tables.values() for fk in t.foreign_keys]\n"
)


@pytest.mark.parametrize("module", ["app.cli", "app.worker.main", "app.main"])
def test_entrypoint_mappers_resolve(module):
    result = subprocess.run(  # noqa: S603 - fixed interpreter and code
        [sys.executable, "-c", SNIPPET.format(module=module)],
        capture_output=True, text=True, check=False,
        env={"CM_ENV": "test", "PATH": ""},
    )
    assert result.returncode == 0, result.stderr[-2000:]
