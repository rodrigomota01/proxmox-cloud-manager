#!/usr/bin/env bash
# Creates the two application roles described in ADR-0004:
#   cm_owner -> owns schema objects, runs Alembic migrations
#   cm_app   -> runtime role for API/worker; NOT owner, NO BYPASSRLS (so RLS applies)
set -euo pipefail

: "${CM_OWNER_PASSWORD:?CM_OWNER_PASSWORD is required}"
: "${CM_APP_PASSWORD:?CM_APP_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v owner_pw="$CM_OWNER_PASSWORD" -v app_pw="$CM_APP_PASSWORD" <<'SQL'
CREATE ROLE cm_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE cm_app   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;

SELECT format('ALTER DATABASE %I OWNER TO cm_owner', current_database()) \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO cm_owner;
GRANT USAGE ON SCHEMA public TO cm_app;

-- Objects created later by cm_owner (migrations) become usable by cm_app.
-- Table-specific restrictions (e.g. audit_logs INSERT/SELECT only) are applied by migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE cm_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cm_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cm_app;
SQL
