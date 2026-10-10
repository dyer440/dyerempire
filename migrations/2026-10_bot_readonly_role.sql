-- migrations/2026-10_bot_readonly_role.sql
-- A read-only Postgres role for the bot SQL endpoint (/api/v1/query and the
-- run_sql MCP tool). With this in place, a bot's ad-hoc SQL physically cannot
-- write, even if every app-level check were bypassed.
--
-- Run AFTER 2026-10_bot_api.sql, in the Neon SQL editor, connected as the owner
-- role (normally neondb_owner). If your owner role has another name, change it
-- in the ALTER DEFAULT PRIVILEGES line.
--
-- BEFORE RUNNING: replace REPLACE_WITH_LONG_RANDOM_PASSWORD with a random
-- password of 24+ characters (letters and digits only keeps the URL simple).
-- Neon rejects weak passwords.
--
-- AFTER RUNNING: in Vercel → Settings → Environment Variables add
--   DATABASE_URL_READONLY = your DATABASE_URL with the user and password swapped
--   postgresql://dyer_bot_ro:<password>@<same host>/<same db>?sslmode=require
-- then redeploy. Until it is set, the endpoint still runs every query inside a
-- READ ONLY transaction on the main connection, but this role is the real wall.

CREATE ROLE dyer_bot_ro WITH LOGIN PASSWORD 'REPLACE_WITH_LONG_RANDOM_PASSWORD';

GRANT USAGE ON SCHEMA public TO dyer_bot_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dyer_bot_ro;

-- Bots never need to see key hashes.
REVOKE ALL ON api_keys FROM dyer_bot_ro;

-- Tables created later (by the owner) are readable automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO dyer_bot_ro;

-- Belt and braces: every session for this role is read-only and time-boxed.
ALTER ROLE dyer_bot_ro SET default_transaction_read_only = on;
ALTER ROLE dyer_bot_ro SET statement_timeout = '15s';

-- Verify (expect SELECT on every table except api_keys):
--   SELECT table_name, privilege_type FROM information_schema.role_table_grants
--   WHERE grantee = 'dyer_bot_ro' ORDER BY table_name;

-- ROLLBACK:
--   REASSIGN OWNED BY dyer_bot_ro TO neondb_owner; DROP OWNED BY dyer_bot_ro; DROP ROLE dyer_bot_ro;
