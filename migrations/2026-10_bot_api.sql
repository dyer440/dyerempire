-- migrations/2026-10_bot_api.sql
-- Bot API foundation: per-bot API keys and the mutations audit log.
-- Run once in the Neon SQL console. Idempotent (safe to re-run).
-- Reverse with the ROLLBACK block at the bottom.

BEGIN;

-- One row per bot. The key itself is NEVER stored, only its SHA-256 hash.
-- key_prefix (first 11 chars, e.g. "de_Ab3xY9qZ") is kept so the admin page can
-- show which key is which without revealing it.
CREATE TABLE IF NOT EXISTS api_keys (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,                       -- e.g. 'GrokBot', 'Cursor'
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,                -- sha256 hex of the full key
  scopes        TEXT[] NOT NULL DEFAULT ARRAY['read']::text[],
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CONSTRAINT api_keys_scopes_valid CHECK (scopes <@ ARRAY['read', 'write', 'sql']::text[])
);

-- Every write a bot makes lands here in the SAME statement as the write itself
-- (data-modifying CTE), so a change can never happen without its log row.
-- This is also the backlog's mutations_log; UI actions can be wired in later.
CREATE TABLE IF NOT EXISTS mutations_log (
  id               BIGSERIAL PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor            TEXT NOT NULL,                    -- 'bot:GrokBot' or an email
  api_key_id       INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  source           TEXT NOT NULL,                    -- 'api' | 'mcp' | 'ui'
  action           TEXT NOT NULL,                    -- 'transaction.create', ...
  target_table     TEXT NOT NULL,
  target_id        INTEGER,
  before           JSONB,
  after            JSONB,
  idempotency_key  TEXT,
  note             TEXT
);
CREATE INDEX IF NOT EXISTS idx_mutations_log_at     ON mutations_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_mutations_log_target ON mutations_log (target_table, target_id);
-- A retried bot request with the same Idempotency-Key cannot write twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mutations_log_idem
  ON mutations_log (api_key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;

-- Verify:
--   SELECT to_regclass('api_keys'), to_regclass('mutations_log');

-- ROLLBACK (only if abandoning the bot API entirely; destroys the audit trail):
--   DROP TABLE IF EXISTS mutations_log;
--   DROP TABLE IF EXISTS api_keys;
