"""docs/api/openapi.json is the contract the frontend types are generated from; it must
match the code. Regenerate (from backend/):
    .venv/bin/python -m app.cli openapi > ../docs/api/openapi.json
"""

from pathlib import Path

from app.cli import openapi_document

COMMITTED = Path(__file__).resolve().parents[3] / "docs" / "api" / "openapi.json"


def test_committed_openapi_is_current():
    assert COMMITTED.read_text().strip() == openapi_document().strip(), (
        "OpenAPI changed: run `python -m app.cli openapi > ../docs/api/openapi.json` "
        "and `npm run gen:api` in frontend/"
    )
