'use server'
// app/real-estate/southside/rent-actions.ts
// Actions for the rent roll. Rent and deposits both book as INCOME / 'Rental
// Income' in the shared transactions table (so they flow into Overviews,
// distributions, and IRR exactly as today); a deposit is just flagged with
// is_deposit. Every payment carries rental_period = the month it's FOR, set
// from the cell it's entered in, so split/late payments land in the right row.
import sql from '@/lib/db'
import { getEditorEmail, isDateClosed } from '@/lib/ledger-guard'
import { revalidatePath } from 'next/cache'

type PaymentInput = {
  propertyId: number
  unitId: number | null
  period: string // 'YYYY-MM' — the rental month this payment is for
  amount: number
  date: string // 'YYYY-MM-DD' — when it actually cleared
  isDeposit: boolean
}

function validate(p: PaymentInput) {
  const amount = Math.abs(Number(p.amount))
  if (!Number.isInteger(p.propertyId)) throw new Error('Pick a property.')
  if (!/^\d{4}-\d{2}$/.test(p.period)) throw new Error('Bad rental month.')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new Error('A valid payment date is required.')
  return amount
}

function refresh() {
  revalidatePath('/real-estate', 'layout')
}

export async function addRentPayment(input: PaymentInput) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')
  const amount = validate(input)
  if (await isDateClosed(input.propertyId, input.date)) throw new Error('That date is in a closed period and is locked.')
  await sql`
    INSERT INTO transactions
      (property_id, unit_id, type, category, amount, txn_date, description, method, created_by, status, rental_period, is_deposit)
    VALUES (${input.propertyId}, ${input.unitId}, 'income', 'Rental Income', ${amount}, ${input.date},
            ${input.isDeposit ? 'Security deposit' : null}, 'rent', ${email}, 'actual', ${input.period}, ${input.isDeposit})
  `
  refresh()
}

// Confirm a scheduled rent (forecast) into an actual, keeping the schedule link
// so Regenerate won't recreate it. Lets you adjust amount/date and pin the month.
export async function confirmRentPayment(id: number, input: Omit<PaymentInput, 'propertyId' | 'unitId'>) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')
  const rows = (await sql`SELECT property_id, status FROM transactions WHERE id = ${id} LIMIT 1`) as Record<string, any>[]
  const row = rows[0]
  if (!row) throw new Error('That item no longer exists.')
  if (row.status !== 'forecast') throw new Error('That item is already confirmed.')
  const amount = validate({ ...input, propertyId: row.property_id, unitId: null })
  if (await isDateClosed(row.property_id, input.date)) throw new Error('That date is in a closed period and is locked.')
  await sql`
    UPDATE transactions
    SET status = 'actual', amount = ${amount}, txn_date = ${input.date}, rental_period = ${input.period},
        is_deposit = ${input.isDeposit}, description = ${input.isDeposit ? 'Security deposit' : null},
        method = 'confirmed', created_by = ${email}
    WHERE id = ${id}
  `
  refresh()
}

export async function editRentPayment(id: number, input: Omit<PaymentInput, 'propertyId' | 'unitId'>) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')
  const rows = (await sql`
    SELECT property_id, to_char(txn_date, 'YYYY-MM-DD') AS old_date FROM transactions WHERE id = ${id} LIMIT 1
  `) as Record<string, any>[]
  const row = rows[0]
  if (!row) throw new Error('That item no longer exists.')
  const amount = validate({ ...input, propertyId: row.property_id, unitId: null })
  if ((await isDateClosed(row.property_id, row.old_date)) || (await isDateClosed(row.property_id, input.date))) {
    throw new Error('That item is in a closed period and is locked.')
  }
  await sql`
    UPDATE transactions
    SET amount = ${amount}, txn_date = ${input.date}, rental_period = ${input.period},
        is_deposit = ${input.isDeposit}, description = ${input.isDeposit ? 'Security deposit' : null}
    WHERE id = ${id}
  `
  refresh()
}

export async function deleteRentPayment(id: number) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')
  const rows = (await sql`
    SELECT property_id, to_char(txn_date, 'YYYY-MM-DD') AS d FROM transactions WHERE id = ${id} LIMIT 1
  `) as Record<string, any>[]
  const row = rows[0]
  if (!row) return
  if (await isDateClosed(row.property_id, row.d)) throw new Error('That item is in a closed period and is locked.')
  await sql`DELETE FROM transactions WHERE id = ${id}`
  refresh()
}

// Set the tenant name shown atop a rent column (a unit, or the property itself
// for single-family). Lightweight label only — full lease history comes later.
export async function setTenant(input: { propertyId: number; unitId: number | null; name: string }) {
  const email = await getEditorEmail()
  if (!email) throw new Error('You do not have permission to edit the books.')
  const name = (input.name || '').trim() || null
  if (input.unitId) {
    await sql`UPDATE units SET current_tenant = ${name} WHERE id = ${input.unitId}`
  } else {
    await sql`UPDATE properties SET current_tenant = ${name} WHERE id = ${input.propertyId}`
  }
  refresh()
}
