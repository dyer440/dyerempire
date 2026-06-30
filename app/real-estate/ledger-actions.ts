'use server'
// app/real-estate/ledger-actions.ts
// Shared server actions for the unified ledger (per-property + Southside).
// Every action re-checks the editor role server-side and refuses to write
// into a closed period. Amounts are always stored POSITIVE; `type` carries sign.
import sql from '@/lib/db'
import { getEditorEmail, isDateClosed } from '@/lib/ledger-guard'
import { revalidatePath } from 'next/cache'

type TxnDraft = {
  type: string // 'income' | 'expense'
  category: string
  amount: number // positive
  txnDate: string // 'YYYY-MM-DD'
  description?: string | null
}

function clean(draft: TxnDraft) {
  const type = draft.type === 'income' ? 'income' : 'expense'
  const category = (draft.category || '').trim()
  const amount = Math.abs(Number(draft.amount))
  const txnDate = (draft.txnDate || '').trim()
  const description = (draft.description || '').trim() || null
  if (!category) throw new Error('Category is required.')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) throw new Error('A valid date is required.')
  return { type, category, amount, txnDate, description }
}

function refresh() {
  // Revalidate the whole real-estate subtree (both ledger views + periods).
  revalidatePath('/real-estate', 'layout')
}

/** Add a brand-new actual transaction (manual entry, not tied to a schedule). */
export async function addTransaction(input: TxnDraft & { propertyId: number }) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')
  const propertyId = Number(input.propertyId)
  if (!Number.isInteger(propertyId)) throw new Error('Pick a property.')
  const d = clean(input)
  if (await isDateClosed(propertyId, d.txnDate)) {
    throw new Error('That date is in a closed period and is locked.')
  }
  await sql`
    INSERT INTO transactions
      (property_id, unit_id, type, category, amount, txn_date, description, method, created_by, status, schedule_id)
    VALUES (${propertyId}, ${null}, ${d.type}, ${d.category}, ${d.amount}, ${d.txnDate},
            ${d.description}, ${'manual'}, ${email}, ${'actual'}, ${null})
  `
  refresh()
}

/** Confirm a scheduled (forecast) row into an actual one, with edits applied. */
export async function confirmScheduled(id: number, input: TxnDraft) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')
  const rows = (await sql`
    SELECT property_id, status FROM transactions WHERE id = ${id} LIMIT 1
  `) as Record<string, any>[]
  const row = rows[0]
  if (!row) throw new Error('That item no longer exists.')
  if (row.status !== 'forecast') throw new Error('That item is already confirmed.')
  const d = clean(input)
  if (await isDateClosed(row.property_id, d.txnDate)) {
    throw new Error('That date is in a closed period and is locked.')
  }
  // Keep schedule_id intact so Regenerate knows this month is already done.
  await sql`
    UPDATE transactions
    SET status = 'actual', type = ${d.type}, category = ${d.category}, amount = ${d.amount},
        txn_date = ${d.txnDate}, description = ${d.description}, method = 'confirmed', created_by = ${email}
    WHERE id = ${id}
  `
  refresh()
}

/** Edit any existing row (actual OR scheduled). Status is left unchanged. */
export async function updateTransaction(id: number, input: TxnDraft) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')
  const rows = (await sql`
    SELECT property_id, to_char(txn_date, 'YYYY-MM-DD') AS old_date FROM transactions WHERE id = ${id} LIMIT 1
  `) as Record<string, any>[]
  const row = rows[0]
  if (!row) throw new Error('That item no longer exists.')
  const d = clean(input)
  // Block edits if either the original or the new date sits in a closed period.
  if ((await isDateClosed(row.property_id, row.old_date)) || (await isDateClosed(row.property_id, d.txnDate))) {
    throw new Error('That item is in a closed period and is locked.')
  }
  await sql`
    UPDATE transactions
    SET type = ${d.type}, category = ${d.category}, amount = ${d.amount},
        txn_date = ${d.txnDate}, description = ${d.description}
    WHERE id = ${id}
  `
  refresh()
}

/** Delete a row (actual or scheduled), unless it's in a closed period. */
export async function deleteTransaction(id: number) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')
  const rows = (await sql`
    SELECT property_id, to_char(txn_date, 'YYYY-MM-DD') AS d FROM transactions WHERE id = ${id} LIMIT 1
  `) as Record<string, any>[]
  const row = rows[0]
  if (!row) return
  if (await isDateClosed(row.property_id, row.d)) {
    throw new Error('That item is in a closed period and is locked.')
  }
  await sql`DELETE FROM transactions WHERE id = ${id}`
  refresh()
}
