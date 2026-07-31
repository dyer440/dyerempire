// app/real-estate/slcm/actions.ts
'use server'
// Server actions for the SL Cap Mgmt entity ledger (entity-level rows:
// entity_id = management_co, property_id NULL). Follows the same rules as the
// property ledgers: role re-checked server-side via getEditorEmail(), amounts
// stored POSITIVE with `type` carrying sign. No closed-period check here —
// period_closes is keyed to property_id and doesn't yet cover entities.
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { revalidatePath } from 'next/cache'

async function slcmEntityId(): Promise<number> {
  const rows = (await sql`
    SELECT id FROM entities WHERE type = 'management_co' LIMIT 1
  `) as Record<string, any>[]
  if (!rows[0]) throw new Error('No management_co entity found. Run migrations/2026-07_entity_slcm.sql first.')
  return rows[0].id as number
}

export async function addSlcmTransaction(formData: FormData) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized to edit the books.')

  const type = formData.get('type') === 'income' ? 'income' : 'expense'
  const category = String(formData.get('category') || '').trim()
  const amount = Math.abs(Number(formData.get('amount')))
  const txnDate = String(formData.get('txnDate') || '').trim()
  const description = String(formData.get('description') || '').trim() || null

  if (!category) throw new Error('Category is required.')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) throw new Error('A valid date is required.')

  const entityId = await slcmEntityId()
  await sql`
    INSERT INTO transactions
      (type, amount, method, status, category, txn_date, entity_id,
       created_by, is_deposit, description, property_id)
    VALUES
      (${type}, ${amount}, 'manual', 'actual', ${category}, ${txnDate}::date,
       ${entityId}, ${editor}, FALSE, ${description}, NULL)
  `
  revalidatePath('/real-estate/slcm')
}

export async function deleteSlcmTransaction(formData: FormData) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized to edit the books.')

  const id = Number(formData.get('id'))
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid transaction id.')

  const entityId = await slcmEntityId()
  // Scoped delete: only entity-level SLCM rows can be removed from this page.
  await sql`
    DELETE FROM transactions
    WHERE id = ${id} AND entity_id = ${entityId} AND property_id IS NULL
  `
  revalidatePath('/real-estate/slcm')
}
