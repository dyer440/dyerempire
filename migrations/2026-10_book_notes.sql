-- migrations/2026-10_book_notes.sql
-- The website note box. NOTHING TO RUN: lib/notes.ts creates this table on
-- first use. Kept here so the schema history is complete.
CREATE TABLE IF NOT EXISTS book_notes (
  id SERIAL PRIMARY KEY,
  body TEXT NOT NULL,
  property_id INTEGER REFERENCES properties(id),
  author_email TEXT,
  author_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  reply TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS book_notes_open_idx ON book_notes (status, created_at);
