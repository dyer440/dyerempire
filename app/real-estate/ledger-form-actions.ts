'use server'
// app/real-estate/ledger-form-actions.ts
// FormData-based edit action for the property (Overview) page, which uses
// server-action <form> elements rather than the object-based actions in
// ledger-actions.ts. Type is derived from the category (matching the existing
// add-transaction behavior), so the edit form only needs a category picker.
import sql from '@/lib/db'
import { getEditorEmail, isDateClosed } from '@/lib/ledger-guard'
import { INCOME_CATEGORIES } from '@/lib/categories'
import { revalidatePath } from 'next/cache'

export async function editTransaction(formData: FormData) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')

  const id = Number(formData.get('id'))
  const propertyId = Number(formData.get('property_id'))
  const category = String(formData.get('category') || '').trim()
  const amount = Math.abs(Number(formData.get('amount')))
  const txnDate = String(formData.get('txn_date') || '').trim()
  const description = String(formData.get('description') || '').trim() || null
  const unitRaw = formData.get('unit_id')
  const unitId = unitRaw && String(unitRaw) !== '' ? Number(unitRaw) : null
  const isDeposit = formData.get('is_deposit') === 'on' || formData.get('is_deposit') === 'true'

  if (!Number.isInteger(id) || !Number.isInteger(propertyId)) throw new Error('Bad request.')
  if (!category) throw new Error('Category is required.')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) throw new Error('A valid date is required.')

  // A deposit is a liability, not P&L, so it's always income-typed and flagged.
  // (Deposit RETURNS are handled in the rent roll; the overview edit toggles the
  // common case — a collection that should have been flagged.)
  const type = isDeposit
    ? 'income'
    : (INCOME_CATEGORIES as readonly string[]).includes(category) ? 'income' : 'expense'
  const finalCategory = isDeposit ? 'Rental Income' : category

  // Block edits touching a closed period (either the original or the new date).
  const old = (await sql`
    SELECT to_char(txn_date, 'YYYY-MM-DD') AS d FROM transactions WHERE id = ${id} LIMIT 1
  `) as Record<string, any>[]
  if (!old[0]) throw new Error('That item no longer exists.')
  if ((await isDateClosed(propertyId, old[0].d)) || (await isDateClosed(propertyId, txnDate))) {
    throw new Error('That item is in a closed period and is locked.')
  }

  await sql`
    UPDATE transactions
    SET type = ${type}, category = ${finalCategory}, amount = ${amount},
        txn_date = ${txnDate}, description = ${description}, unit_id = ${unitId},
        is_deposit = ${isDeposit}
    WHERE id = ${id}
  `
  revalidatePath(`/real-estate/${propertyId}`)
}
