// lib/notes.ts
// The note box. Betsy (or David) leaves a plain-language note for the books,
// e.g. "Billy paid $155 cash for 500 West, August". Notes never touch the
// ledger themselves. Claude or GrokBot read the open ones, post whatever they
// describe (matching the bank so nothing is entered twice), then mark the note
// done with a short reply that shows on the Notes page.
import sql from './db'

let ready: Promise<void> | null = null

/** Creates the table on first use, so no manual migration is needed. */
export function ensureNotes(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await sql`
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
        )`
      await sql`CREATE INDEX IF NOT EXISTS book_notes_open_idx ON book_notes (status, created_at)`
    })().catch((e) => { ready = null; throw e })
  }
  return ready
}

export type BookNote = {
  id: number
  body: string
  property_id: number | null
  property: string | null
  author_email: string | null
  author_name: string | null
  status: 'open' | 'done' | 'dismissed'
  reply: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

export async function listNotes(opts: { status?: 'open' | 'done' | 'dismissed' | 'all'; limit?: number } = {}): Promise<BookNote[]> {
  await ensureNotes()
  const status = opts.status && opts.status !== 'all' ? opts.status : null
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  return (await sql`
    SELECT n.id, n.body, n.property_id, p.name AS property, n.author_email, n.author_name,
           n.status, n.reply, n.resolved_by,
           to_char(n.resolved_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS resolved_at,
           to_char(n.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS created_at
    FROM book_notes n LEFT JOIN properties p ON p.id = n.property_id
    WHERE (${status}::text IS NULL OR n.status = ${status})
    ORDER BY (n.status = 'open') DESC, n.created_at DESC
    LIMIT ${limit}
  `) as BookNote[]
}

export async function addNote(input: { body: string; propertyId: number | null; email: string; name: string | null }) {
  await ensureNotes()
  const rows = (await sql`
    INSERT INTO book_notes (body, property_id, author_email, author_name)
    VALUES (${input.body}, ${input.propertyId}, ${input.email}, ${input.name})
    RETURNING id
  `) as { id: number }[]
  return rows[0].id
}
