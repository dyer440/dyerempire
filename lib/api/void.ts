// lib/api/void.ts
// Removing an actual transaction that should never have been booked (a typo,
// a double entry). The website no longer has a delete button, so this is the
// only path, and it is deliberately narrow:
//   • actuals only (scheduled rows go through delete_forecast)
//   • confirm: true and a reason are required; the reason is logged
//   • refused inside a closed quarter (reopen it first)
//   • refused when a bank line is attached (revert_bank_txn instead, so the
//     bank row goes back to pending rather than silently losing its match)
// The full row is kept in mutations_log.before, so a void can be undone by hand.
import sql from '@/lib/db'
import { badRequest, conflict, notFound } from './errors'
import { type Actor, refreshUi, isDateClosed, closedError } from './service'
import { type Input, reqInt, optString, optBool } from './validate'

type Row = Record<string, unknown>

export async function voidTransaction(input: Input, who: Actor) {
  const id = reqInt(input, 'id')
  if (optBool(input, 'confirm') !== true) {
    throw conflict('needs_confirmation', 'Voiding removes a booked transaction. Resend with confirm: true once the owner agrees it should go.')
  }
  const reason = optString(input, 'reason', 300)
  if (!reason) throw badRequest('reason is required, e.g. "Duplicate of txn 2231 entered by hand".')

  const rows = (await sql`
    SELECT t.id, t.status, t.property_id, to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date,
           EXISTS (SELECT 1 FROM bank_txn_legs l WHERE l.transaction_id = t.id) AS bank_linked
    FROM transactions t WHERE t.id = ${id}
  `) as Row[]
  const row = rows[0]
  if (!row) throw notFound(`Transaction ${id} not found.`)
  if (row.status !== 'actual') throw conflict('not_actual', `Transaction ${id} is scheduled, not actual. Use delete_forecast.`)
  if (row.bank_linked) {
    throw conflict('bank_reconciled', `Transaction ${id} is attached to a bank line. Use revert_bank_txn on that bank row instead, then repost it.`)
  }
  if (row.property_id && (await isDateClosed(Number(row.property_id), String(row.txn_date)))) throw closedError(String(row.txn_date))

  const done = (await sql`
    WITH del AS (
      DELETE FROM transactions t
      WHERE t.id = ${id} AND t.status = 'actual'
        AND NOT EXISTS (SELECT 1 FROM bank_txn_legs l WHERE l.transaction_id = t.id)
      RETURNING t.*
    ), log AS (
      INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, note)
      SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'transaction.void', 'transactions', del.id, to_jsonb(del), ${reason}
      FROM del
    )
    SELECT id FROM del
  `) as Row[]
  if (!done.length) throw conflict('changed', `Transaction ${id} changed while voiding. Look it up again.`)
  refreshUi()
  return { voided: true, id, reason }
}
