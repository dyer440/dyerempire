// app/real-estate/import/actions.ts
'use server'
// Server actions for the bank-CSV import screen (Phase A).
// Every action re-checks the editor role server-side. Ledger rows created here
// carry method='import' and a bank_txn_legs row, so every booked transaction
// traces to a bank line and every post is reversible.
import sql from '@/lib/db'
import { getEditorEmail, isDateClosed } from '@/lib/ledger-guard'
import { parseUsBankCsv, withOccurrences, importHash } from '@/lib/bank-import'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'

const cents = (n: number) => Math.round(n * 100)

function refresh() {
  revalidatePath('/real-estate/import')
  revalidatePath('/real-estate', 'layout')
}

// ── Upload ────────────────────────────────────────────────────────────────────

// Form action: must return void. The upload summary is stashed in a short-lived
// cookie and rendered once on the next page load (see page.tsx).
export async function uploadBankCsv(formData: FormData): Promise<void> {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized to import.')

  const accountId = Number(formData.get('accountId'))
  if (!Number.isInteger(accountId) || accountId <= 0) throw new Error('Pick an account.')
  const file = formData.get('file') as File | null
  if (!file || typeof file.text !== 'function') throw new Error('Attach a CSV file.')

  const parsed = withOccurrences(parseUsBankCsv(await file.text()))
  if (parsed.length === 0) throw new Error('No transactions found in that file.')

  let inserted = 0
  for (const r of parsed) {
    const hash = importHash(accountId, r)
    const res = (await sql`
      INSERT INTO bank_txns
        (account_id, txn_date, amount, name_raw, memo, check_number,
         name_norm, occurrence, import_hash)
      VALUES
        (${accountId}, ${r.txnDate}::date, ${r.amount}, ${r.nameRaw}, ${r.memo},
         ${r.checkNumber}, ${r.nameNorm}, ${r.occurrence}, ${hash})
      ON CONFLICT (import_hash) DO NOTHING
      RETURNING id
    `) as Record<string, any>[]
    if (res.length > 0) inserted++
  }

  const store = await cookies()
  store.set(
    'import_summary',
    JSON.stringify({ parsed: parsed.length, inserted, duplicates: parsed.length - inserted }),
    { path: '/real-estate/import', maxAge: 30, httpOnly: false },
  )
  refresh()
}

// ── Post (single target or splits — same action, 1..N legs) ──────────────────

export type PostLeg = {
  target: string          // 'property:<id>' | 'entity:<id>' (SL Cap Mgmt)
  amount: number          // positive dollars; legs must sum to |bank amount|
  category: string
  description?: string
  unitId?: number         // rent legs only
  rentalPeriod?: string   // 'YYYY-MM', rent legs only
  isDeposit?: boolean     // security-deposit credits
}

export async function postBankTxn(bankTxnId: number, legs: PostLeg[]) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized to post.')
  if (!legs || legs.length === 0) throw new Error('At least one leg is required.')

  const bankRows = (await sql`
    SELECT id, txn_date::text AS txn_date, amount::float8 AS amount, name_norm, status
    FROM bank_txns WHERE id = ${bankTxnId}
  `) as Record<string, any>[]
  const bank = bankRows[0]
  if (!bank) throw new Error('Bank row not found.')
  if (bank.status !== 'pending') throw new Error('That row is already resolved — revert it first.')

  const type = bank.amount > 0 ? 'income' : 'expense'
  const txnDate = String(bank.txn_date).slice(0, 10)

  const legSum = legs.reduce((s, l) => s + cents(Math.abs(Number(l.amount))), 0)
  if (legSum !== cents(Math.abs(bank.amount))) {
    throw new Error(
      `Legs must sum to the bank amount: legs $${(legSum / 100).toFixed(2)} vs bank $${Math.abs(bank.amount).toFixed(2)}.`,
    )
  }

  // Resolve + validate every leg BEFORE writing anything.
  const resolved: {
    propertyId: number | null
    entityId: number | null
    amount: number
    category: string
    description: string | null
    unitId: number | null
    rentalPeriod: string | null
    isDeposit: boolean
  }[] = []

  for (const leg of legs) {
    const amount = Math.abs(Number(leg.amount))
    const category = (leg.category || '').trim()
    if (!category) throw new Error('Every leg needs a category.')
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Leg amounts must be greater than zero.')
    const description = (leg.description || '').trim() || bank.name_norm
    const rentalPeriod = (leg.rentalPeriod || '').trim() || null
    if (rentalPeriod && !/^\d{4}-\d{2}$/.test(rentalPeriod)) throw new Error('Rental period must be YYYY-MM.')

    const m = /^(property|entity):(\d+)$/.exec(leg.target || '')
    if (!m) throw new Error('Every leg needs a destination.')

    if (m[1] === 'property') {
      const propertyId = Number(m[2])
      const pRows = (await sql`
        SELECT id, entity_id FROM properties WHERE id = ${propertyId}
      `) as Record<string, any>[]
      if (!pRows[0]) throw new Error(`Unknown property id ${propertyId}.`)
      if (await isDateClosed(propertyId, txnDate)) {
        throw new Error(`${txnDate} falls in a closed period for that property.`)
      }
      if (leg.unitId) {
        const uRows = (await sql`
          SELECT id FROM units WHERE id = ${Number(leg.unitId)} AND property_id = ${propertyId}
        `) as Record<string, any>[]
        if (!uRows[0]) throw new Error('That unit does not belong to the selected property.')
      }
      resolved.push({
        propertyId, entityId: pRows[0].entity_id ?? null, amount, category, description,
        unitId: leg.unitId ? Number(leg.unitId) : null, rentalPeriod,
        isDeposit: !!leg.isDeposit && type === 'income',
      })
    } else {
      const entityId = Number(m[2])
      const eRows = (await sql`
        SELECT id FROM entities WHERE id = ${entityId} AND type <> 'property'
      `) as Record<string, any>[]
      if (!eRows[0]) throw new Error(`Unknown entity id ${entityId}.`)
      resolved.push({
        propertyId: null, entityId, amount, category, description,
        unitId: null, rentalPeriod: null, isDeposit: false,
      })
    }
  }

  for (const leg of resolved) {
    const ins = (await sql`
      INSERT INTO transactions
        (type, amount, method, status, category, txn_date, entity_id, unit_id,
         rental_period, created_by, is_deposit, description, property_id)
      VALUES
        (${type}, ${leg.amount}, 'import', 'actual', ${leg.category}, ${txnDate}::date,
         ${leg.entityId}, ${leg.unitId}, ${leg.rentalPeriod}, ${editor},
         ${leg.isDeposit}, ${leg.description}, ${leg.propertyId})
      RETURNING id
    `) as Record<string, any>[]
    await sql`
      INSERT INTO bank_txn_legs (bank_txn_id, transaction_id, link_type, amount)
      VALUES (${bankTxnId}, ${ins[0].id}, 'created', ${leg.amount})
    `
  }

  await sql`
    UPDATE bank_txns
    SET status = 'posted', resolved_by = ${editor}, resolved_at = NOW()
    WHERE id = ${bankTxnId}
  `
  refresh()
}

// ── Link to pre-existing ledger rows (the "In the ledger? Yes" path) ─────────

export async function linkBankTxn(bankTxnId: number, transactionIds: number[]) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized.')
  if (!transactionIds || transactionIds.length === 0) throw new Error('Pick at least one existing transaction.')

  const bankRows = (await sql`
    SELECT id, status FROM bank_txns WHERE id = ${bankTxnId}
  `) as Record<string, any>[]
  if (!bankRows[0]) throw new Error('Bank row not found.')
  if (bankRows[0].status !== 'pending') throw new Error('That row is already resolved.')

  for (const rawId of transactionIds) {
    const txnId = Number(rawId)
    const tRows = (await sql`
      SELECT id, amount::float8 AS amount FROM transactions WHERE id = ${txnId}
    `) as Record<string, any>[]
    if (!tRows[0]) throw new Error(`Transaction ${txnId} not found.`)
    const already = (await sql`
      SELECT 1 FROM bank_txn_legs WHERE transaction_id = ${txnId} LIMIT 1
    `) as Record<string, any>[]
    if (already.length > 0) throw new Error(`Transaction ${txnId} is already tied to another bank row.`)
    await sql`
      INSERT INTO bank_txn_legs (bank_txn_id, transaction_id, link_type, amount)
      VALUES (${bankTxnId}, ${txnId}, 'linked', ${tRows[0].amount})
    `
  }
  await sql`
    UPDATE bank_txns
    SET status = 'linked', resolved_by = ${editor}, resolved_at = NOW()
    WHERE id = ${bankTxnId}
  `
  refresh()
}

// ── Exclude (personal / not business) ────────────────────────────────────────

export async function excludeBankTxn(bankTxnId: number, reason: string) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized.')
  const r = (reason || '').trim() || 'personal / not business'
  await sql`
    UPDATE bank_txns
    SET status = 'excluded', exclude_reason = ${r},
        resolved_by = ${editor}, resolved_at = NOW()
    WHERE id = ${bankTxnId} AND status = 'pending'
  `
  refresh()
}

// ── Revert (safety valve: any resolution back to pending) ───────────────────

export async function revertBankTxn(bankTxnId: number) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized.')

  // Delete ledger rows this bank row CREATED; merely unlink pre-existing ones.
  const created = (await sql`
    SELECT transaction_id FROM bank_txn_legs
    WHERE bank_txn_id = ${bankTxnId} AND link_type = 'created' AND transaction_id IS NOT NULL
  `) as Record<string, any>[]
  for (const row of created) {
    await sql`DELETE FROM transactions WHERE id = ${row.transaction_id} AND method = 'import'`
  }
  await sql`DELETE FROM bank_txn_legs WHERE bank_txn_id = ${bankTxnId}`
  await sql`
    UPDATE bank_txns
    SET status = 'pending', exclude_reason = NULL, resolved_by = NULL, resolved_at = NULL
    WHERE id = ${bankTxnId}
  `
  refresh()
}
