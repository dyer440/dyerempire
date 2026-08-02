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

// Record a deposit FORFEITURE (tenant's deposit is kept). Written as a two-leg
// event linked by transfer_group — the double-entry-ready shape (Option A → B in
// ARCHITECTURE): one journal entry, two balanced sides.
//   Leg 1 — release liability: expense + is_deposit=TRUE. Excluded from P&L (all
//           aggregations skip deposits), so it only DROPS "Deposits held".
//   Leg 2 — recognize income: normal Rental Income, hits P&L.
// Dated in the present (move-out month), so a closed prior period stays untouched.
export async function forfeitDeposit(formData: FormData) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')

  const propertyId = Number(formData.get('property_id'))
  const amount = Math.abs(Number(formData.get('amount')))
  const txnDate = String(formData.get('txn_date') || '').trim()
  const incomeCategory = String(formData.get('income_category') || 'Rental Income').trim() || 'Rental Income'
  const note = String(formData.get('description') || '').trim()

  if (!Number.isInteger(propertyId)) throw new Error('Bad request.')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) throw new Error('A valid date is required.')
  if (await isDateClosed(propertyId, txnDate)) throw new Error('That date is in a closed period and is locked.')

  // Can't forfeit more than is currently held.
  const heldRows = (await sql`
    SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0)::float8 AS held
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'actual' AND COALESCE(is_deposit, FALSE) = TRUE
  `) as { held: number }[]
  const held = heldRows[0]?.held ?? 0
  if (amount > held + 0.005) {
    throw new Error(`Only $${held.toFixed(2)} in deposits is held for this property — can't forfeit more than that.`)
  }

  const group = `deposit-forfeit-${propertyId}-${Date.now()}`
  const incomeDesc = note || 'Forfeited deposit — recognized as income'

  // Leg 1 — release the held liability (invisible to P&L, reduces Deposits held).
  await sql`
    INSERT INTO transactions
      (property_id, type, category, amount, txn_date, description, method, created_by, status, is_deposit, transfer_group)
    VALUES (${propertyId}, 'expense', 'Security Deposit', ${amount}, ${txnDate},
            'Deposit forfeiture — release of held liability', 'forfeiture', ${email}, 'actual', TRUE, ${group})
  `
  // Leg 2 — recognize the income (hits P&L).
  await sql`
    INSERT INTO transactions
      (property_id, type, category, amount, txn_date, description, method, created_by, status, is_deposit, transfer_group)
    VALUES (${propertyId}, 'income', ${incomeCategory}, ${amount}, ${txnDate},
            ${incomeDesc}, 'forfeiture', ${email}, 'actual', FALSE, ${group})
  `
  revalidatePath(`/real-estate/${propertyId}`)
}
