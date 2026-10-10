// lib/api/notes.ts
// Notes left on the site's note box, for bots to act on. Reading is free;
// resolving a note (done or dismissed, with a short reply the author sees on
// the Notes page) is a logged write. Posting what a note describes is done
// with the normal tools (post_bank_txn, match_bank_txn, create_transaction),
// never by this module.
import sql from '@/lib/db'
import { ensureNotes, listNotes } from '@/lib/notes'
import { conflict, notFound, badRequest } from './errors'
import { type Actor, refreshUi } from './service'
import { type Input, reqInt, optString, optEnum, clampInt } from './validate'

export async function listBookNotes(input: Input) {
  const status = optEnum(input, 'status', ['open', 'done', 'dismissed', 'all'] as const) ?? 'open'
  const limit = clampInt(input, 'limit', 50, 1, 500)
  const notes = await listNotes({ status, limit })
  return { status, count: notes.length, notes }
}

export async function resolveBookNote(input: Input, who: Actor) {
  await ensureNotes()
  const id = reqInt(input, 'id')
  const status = optEnum(input, 'status', ['done', 'dismissed'] as const)
  if (!status) throw badRequest("status is required: 'done' (handled) or 'dismissed' (nothing to post).")
  const reply = optString(input, 'reply', 1000)
  if (!reply) throw badRequest('reply is required: one or two sentences the author will read, e.g. "Posted $155 to 500 West, Aug rent (txn 2231)."')

  const rows = (await sql`
    WITH before AS (SELECT * FROM book_notes WHERE id = ${id}),
    upd AS (
      UPDATE book_notes SET status = ${status}, reply = ${reply}, resolved_by = ${who.actor}, resolved_at = now()
      WHERE id = ${id} AND status = 'open'
      RETURNING *
    ), log AS (
      INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after, note)
      SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'note.resolve', 'book_notes', upd.id,
             (SELECT to_jsonb(before) FROM before), to_jsonb(upd), ${status}
      FROM upd
    )
    SELECT (SELECT status FROM before) AS was, (SELECT id FROM upd) AS updated
  `) as { was: string | null; updated: number | null }[]
  const r = rows[0]
  if (!r?.was) throw notFound(`Note ${id} not found.`)
  if (!r.updated) throw conflict('already_resolved', `Note ${id} is already ${r.was}.`)
  refreshUi()
  return { id, status, reply }
}
