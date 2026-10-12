// lib/api/bank-post.ts
// Bot posting of bank rows: the same four outcomes the retired import screen had, with
// the same rules, but each one atomic and logged.
//
//   post   bank row → new ledger row(s) on property/entity books (1..N legs)
//   match  bank row → an existing ledger row: a scheduled item is confirmed at
//          the cleared amount and date; an existing actual is simply linked
//   exclude bank row → not business (personal, transfer between own accounts)
//   revert  any of the above back to pending (the undo)
//
// Rules carried over from the retired import screen:
//   • the bank row must be pending; legs must sum to the bank amount to the cent
//   • direction comes from the bank sign (credit = income, debit = expense)
//   • closed periods are refused; units must belong to the property
//   • entity legs only to non-property entities; deposits only on income legs
//   • ledger rows created here carry method='import' and a bank_txn_legs row
// Added for bots: categories must exist and match the direction, and a matched
// existing actual must equal the bank amount.
//
// Atomicity: each operation is ONE neon transaction. The first statement locks
// the bank row and aborts (division by zero, the divisor computed from the
// row's status so Postgres can't fold it at plan time) if it isn't in the expected state, so a race
// with the Import screen can never double-post. The last statement writes the
// mutations_log row.
import sql from '@/lib/db'
import { ensureMedia } from '@/lib/media'
import { badRequest, conflict, notFound, pgCode } from './errors'
import { type Actor, isDateClosed, closedError, resolveCategory, refreshUi } from './service'
import { type Input, reqInt, optInt, optString, optBool, optRentalPeriod, optAmount } from './validate'
import { inferRentPeriod } from '@/lib/rent-period'

type Row = Record<string, unknown>
const cents = (n: number) => Math.round(Math.abs(n) * 100)

type Bank = { id: number; txn_date: string; amount: number; name_norm: string; status: string }

async function loadBank(id: number): Promise<Bank> {
  const rows = (await sql`
    SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, amount::float8 AS amount, name_norm, status
    FROM bank_txns WHERE id = ${id}
  `) as Bank[]
  if (!rows[0]) throw notFound(`Bank row ${id} not found.`)
  return rows[0]
}

function requirePending(b: Bank) {
  if (b.status !== 'pending') {
    throw conflict('already_resolved', `Bank row ${b.id} is already ${b.status}. Use revert_bank_txn first if it needs redoing.`)
  }
}

/** Runs the statements atomically; maps the 1/0 state guard to a clean 409. */
async function atomic(id: number, build: (tx: typeof sql) => unknown[]) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sql.transaction((tx) => build(tx as any) as any)
  } catch (e) {
    if (pgCode(e) === '22012') throw conflict('already_resolved', `Bank row ${id} changed while posting. Nothing was written.`)
    throw e
  }
}

// ─── post ────────────────────────────────────────────────────────────────────

type Leg = {
  propertyId: number | null; entityId: number | null; unitId: number | null
  amount: number; category: string; description: string | null
  rentalPeriod: string | null; isDeposit: boolean
}

export async function postBankTxn(input: Input, who: Actor) {
  const bankId = reqInt(input, 'bank_txn_id')
  const bank = await loadBank(bankId)
  requirePending(bank)
  const type: 'income' | 'expense' = bank.amount > 0 ? 'income' : 'expense'
  const ruleId = optInt(input, 'rule_id')

  const rawLegs = Array.isArray(input.legs) ? (input.legs as Input[]) : null
  if (!rawLegs || rawLegs.length === 0) throw badRequest('legs is required: one or more { property_id | entity_id, category, amount }.')
  if (rawLegs.length > 20) throw badRequest('At most 20 legs.')

  const legs: Leg[] = []
  for (const [i, l] of rawLegs.entries()) {
    const at = `legs[${i}]`
    if (!l || typeof l !== 'object') throw badRequest(`${at} must be an object.`)
    const propertyId = optInt(l, 'property_id')
    const entityId = optInt(l, 'entity_id')
    if (!!propertyId === !!entityId) throw badRequest(`${at}: send exactly one of property_id or entity_id.`)
    // A single leg may omit amount: it takes the whole bank amount.
    const amount = optAmount(l, 'amount') ?? (rawLegs.length === 1 ? Math.abs(bank.amount) : null)
    if (amount === null) throw badRequest(`${at}: amount is required when splitting across legs.`)
    const isDeposit = optBool(l, 'is_deposit') ?? false
    const rentalPeriod = optRentalPeriod(l)
    const unitId = optInt(l, 'unit_id')
    const description = optString(l, 'description') ?? bank.name_norm

    let category: string
    if (isDeposit) {
      if (type !== 'income') throw badRequest(`${at}: a deposit leg must be on a credit (money in). Deposit returns are posted in the app.`)
      if (!propertyId) throw badRequest(`${at}: deposits belong to a property.`)
      category = 'Rental Income'
    } else {
      const raw = optString(l, 'category', 100)
      if (!raw) throw badRequest(`${at}: category is required.`)
      const c = await resolveCategory(raw)
      if (c.name === 'Security Deposit') throw badRequest(`${at}: use is_deposit: true for a deposit.`)
      if (c.kind !== type) {
        throw badRequest(
          `${at}: this bank row is a ${type === 'income' ? 'credit (income)' : 'debit (expense)'}, but "${c.name}" is an ${c.kind} category.` +
          (type === 'income' ? ' A refund or reimbursement usually goes to Other Income.' : ''),
        )
      }
      category = c.name
    }
    if (rentalPeriod && type !== 'income') throw badRequest(`${at}: rental_period only applies to income.`)

    if (propertyId) {
      const p = (await sql`SELECT entity_id FROM properties WHERE id = ${propertyId}`) as Row[]
      if (!p[0]) throw notFound(`${at}: property ${propertyId} not found.`)
      if (unitId) {
        const u = (await sql`SELECT 1 FROM units WHERE id = ${unitId} AND property_id = ${propertyId}`) as Row[]
        if (!u[0]) throw badRequest(`${at}: unit ${unitId} does not belong to property ${propertyId}.`)
      }
      if (await isDateClosed(propertyId, bank.txn_date)) throw closedError(bank.txn_date)
      const period = rentalPeriod ?? (!isDeposit && type === 'income' && category === 'Rental Income'
        ? await inferRentPeriod(propertyId, unitId, bank.txn_date, amount) : null)
      legs.push({ propertyId, entityId: (p[0].entity_id as number | null) ?? null, unitId, amount, category, description, rentalPeriod: period, isDeposit })
    } else {
      if (unitId) throw badRequest(`${at}: unit_id only applies to property legs.`)
      const e = (await sql`SELECT type FROM entities WHERE id = ${entityId}`) as Row[]
      if (!e[0]) throw notFound(`${at}: entity ${entityId} not found.`)
      if (e[0].type === 'property') throw badRequest(`${at}: that entity is a property; use its property_id.`)
      legs.push({ propertyId: null, entityId, unitId: null, amount, category, description, rentalPeriod: null, isDeposit: false })
    }
  }

  const legSum = legs.reduce((s, l) => s + cents(l.amount), 0)
  if (legSum !== cents(bank.amount)) {
    throw badRequest(`Legs must add up to the bank amount: legs $${(legSum / 100).toFixed(2)} vs bank $${Math.abs(bank.amount).toFixed(2)}.`)
  }

  await atomic(bankId, (tx) => [
    tx`SELECT 1 / (CASE WHEN status = 'pending' THEN 1 ELSE 0 END) FROM bank_txns WHERE id = ${bankId} FOR UPDATE`,
    ...legs.map((l) => tx`
      WITH ins AS (
        INSERT INTO transactions
          (type, amount, method, status, category, txn_date, entity_id, unit_id,
           rental_period, created_by, is_deposit, description, property_id)
        VALUES
          (${type}, ${l.amount}, 'import', 'actual', ${l.category}, ${bank.txn_date}::date,
           ${l.entityId}, ${l.unitId}, ${l.rentalPeriod}, ${who.actor}, ${l.isDeposit},
           ${l.description}, ${l.propertyId})
        RETURNING id, amount
      )
      INSERT INTO bank_txn_legs (bank_txn_id, transaction_id, link_type, amount)
      SELECT ${bankId}, id, 'created', amount FROM ins
    `),
    tx`UPDATE bank_txns SET status = 'posted', resolved_by = ${who.actor}, resolved_at = NOW() WHERE id = ${bankId}`,
    ...(ruleId ? [tx`UPDATE import_rules SET times_used = times_used + 1, last_used = NOW() WHERE id = ${ruleId}`] : []),
    tx`
      INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after)
      SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'bank.post', 'bank_txns', ${bankId},
             jsonb_build_object('legs', jsonb_agg(to_jsonb(t)))
      FROM bank_txn_legs l JOIN transactions t ON t.id = l.transaction_id
      WHERE l.bank_txn_id = ${bankId}
    `,
  ])
  refreshUi()
  return bankResult(bankId)
}

// ─── match ───────────────────────────────────────────────────────────────────

export async function matchBankTxn(input: Input, who: Actor) {
  const bankId = reqInt(input, 'bank_txn_id')
  const bank = await loadBank(bankId)
  requirePending(bank)
  const type = bank.amount > 0 ? 'income' : 'expense'

  const ids = Array.isArray(input.transaction_ids)
    ? (input.transaction_ids as unknown[]).map(Number)
    : [reqInt(input, 'transaction_id')]
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw badRequest('transaction_ids must be positive integers.')
  if (new Set(ids).size !== ids.length) throw badRequest('transaction_ids has a repeat.')

  const rows = (await sql`
    SELECT t.id, t.status, t.type, t.property_id, t.schedule_id, t.amount::float8 AS amount,
           EXISTS (SELECT 1 FROM bank_txn_legs l WHERE l.transaction_id = t.id) AS linked
    FROM transactions t WHERE t.id = ANY(${ids}::int[])
  `) as { id: number; status: string; type: string; property_id: number | null; schedule_id: number | null; amount: number; linked: boolean }[]
  for (const id of ids) {
    const r = rows.find((x) => x.id === id)
    if (!r) throw notFound(`Transaction ${id} not found.`)
    if (r.linked) throw conflict('already_linked', `Transaction ${id} is already tied to another bank row.`)
    if (r.type !== type) throw badRequest(`Transaction ${id} is ${r.type}, but the bank row is ${type}.`)
  }

  const forecasts = rows.filter((r) => r.status === 'forecast')
  if (forecasts.length) {
    // Confirm-and-link: one scheduled item, booked at what actually cleared.
    if (ids.length !== 1) throw badRequest('Match a scheduled item on its own (one transaction_id).')
    const f = forecasts[0]
    if (!f.schedule_id) throw badRequest(`Transaction ${f.id} is a forecast with no schedule. Use post_bank_txn instead.`)
    if (f.property_id && (await isDateClosed(f.property_id, bank.txn_date))) throw closedError(bank.txn_date)
    const amount = Math.abs(bank.amount)
    await atomic(bankId, (tx) => [
      tx`SELECT 1 / (CASE WHEN status = 'pending' THEN 1 ELSE 0 END) FROM bank_txns WHERE id = ${bankId} FOR UPDATE`,
      tx`SELECT 1 / (CASE WHEN status = 'forecast' THEN 1 ELSE 0 END) FROM transactions WHERE id = ${f.id} FOR UPDATE`,
      tx`
        WITH prev AS (SELECT * FROM transactions WHERE id = ${f.id}),
        upd AS (
          UPDATE transactions
          SET status = 'actual', method = 'import', created_by = ${who.actor},
              amount = ${amount}, txn_date = ${bank.txn_date}::date
          WHERE id = ${f.id}
          RETURNING *
        )
        INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after)
        SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'bank.match_forecast', 'transactions', upd.id,
               to_jsonb(prev), to_jsonb(upd) || jsonb_build_object('bank_txn_id', ${bankId}::int)
        FROM prev, upd
      `,
      tx`INSERT INTO bank_txn_legs (bank_txn_id, transaction_id, link_type, amount) VALUES (${bankId}, ${f.id}, 'confirmed', ${amount})`,
      tx`UPDATE bank_txns SET status = 'linked', resolved_by = ${who.actor}, resolved_at = NOW() WHERE id = ${bankId}`,
    ])
    refreshUi()
    const result = await bankResult(bankId)
    const diff = Math.round((amount - f.amount) * 100) / 100
    return diff ? { ...result, note: `Scheduled amount was ${f.amount.toFixed(2)}; booked at ${amount.toFixed(2)} as cleared.` } : result
  }

  // Link existing actual(s): the bank line is already in the ledger.
  const total = rows.reduce((s, r) => s + cents(r.amount), 0)
  if (total !== cents(bank.amount)) {
    throw badRequest(`Those transactions total $${(total / 100).toFixed(2)} but the bank row is $${Math.abs(bank.amount).toFixed(2)}.`)
  }
  await atomic(bankId, (tx) => [
    tx`SELECT 1 / (CASE WHEN status = 'pending' THEN 1 ELSE 0 END) FROM bank_txns WHERE id = ${bankId} FOR UPDATE`,
    ...rows.map((r) => tx`
      INSERT INTO bank_txn_legs (bank_txn_id, transaction_id, link_type, amount) VALUES (${bankId}, ${r.id}, 'linked', ${r.amount})
    `),
    tx`UPDATE bank_txns SET status = 'linked', resolved_by = ${who.actor}, resolved_at = NOW() WHERE id = ${bankId}`,
    tx`
      INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after)
      VALUES (${who.actor}, ${who.keyId}, ${who.source}, 'bank.link', 'bank_txns', ${bankId},
              ${JSON.stringify({ transaction_ids: ids })}::jsonb)
    `,
  ])
  refreshUi()
  return bankResult(bankId)
}

// ─── exclude ─────────────────────────────────────────────────────────────────

export async function excludeBankTxn(input: Input, who: Actor) {
  const bankId = reqInt(input, 'bank_txn_id')
  const bank = await loadBank(bankId)
  requirePending(bank)
  const reason = optString(input, 'reason', 200)
  if (!reason) throw badRequest('reason is required, e.g. "personal", "transfer between own accounts".')
  const ruleId = optInt(input, 'rule_id')
  await atomic(bankId, (tx) => [
    tx`SELECT 1 / (CASE WHEN status = 'pending' THEN 1 ELSE 0 END) FROM bank_txns WHERE id = ${bankId} FOR UPDATE`,
    tx`UPDATE bank_txns SET status = 'excluded', exclude_reason = ${reason}, resolved_by = ${who.actor}, resolved_at = NOW() WHERE id = ${bankId}`,
    ...(ruleId ? [tx`UPDATE import_rules SET times_used = times_used + 1, last_used = NOW() WHERE id = ${ruleId}`] : []),
    tx`
      INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after)
      VALUES (${who.actor}, ${who.keyId}, ${who.source}, 'bank.exclude', 'bank_txns', ${bankId},
              ${JSON.stringify({ reason })}::jsonb)
    `,
  ])
  refreshUi()
  return bankResult(bankId)
}

// ─── revert ──────────────────────────────────────────────────────────────────

export async function revertBankTxn(input: Input, who: Actor) {
  const bankId = reqInt(input, 'bank_txn_id')
  const bank = await loadBank(bankId)
  if (bank.status === 'pending') throw conflict('not_resolved', `Bank row ${bankId} is already pending.`)

  // Same lock rule as editing: never reach into a closed period.
  const touched = (await sql`
    SELECT DISTINCT t.property_id, to_char(t.txn_date, 'YYYY-MM-DD') AS d
    FROM bank_txn_legs l JOIN transactions t ON t.id = l.transaction_id
    WHERE l.bank_txn_id = ${bankId} AND t.property_id IS NOT NULL
  `) as { property_id: number; d: string }[]
  for (const t of touched) if (await isDateClosed(t.property_id, t.d)) throw closedError(t.d)

  const before = await bankResult(bankId)
  await ensureMedia()
  await atomic(bankId, (tx) => [
    tx`SELECT 1 / (CASE WHEN status <> 'pending' THEN 1 ELSE 0 END) FROM bank_txns WHERE id = ${bankId} FOR UPDATE`,
    tx`
      INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before)
      VALUES (${who.actor}, ${who.keyId}, ${who.source}, 'bank.revert', 'bank_txns', ${bankId}, ${JSON.stringify(before)}::jsonb)
    `,
    // Rows this bank line created are removed; confirmed forecasts go back to forecast; links are dropped.
    tx`
      DELETE FROM transactions
      WHERE method = 'import' AND id IN (
        SELECT transaction_id FROM bank_txn_legs WHERE bank_txn_id = ${bankId} AND link_type = 'created')
    `,
    tx`
      UPDATE transactions SET status = 'forecast', method = 'scheduled'
      WHERE status = 'actual' AND schedule_id IS NOT NULL AND id IN (
        SELECT transaction_id FROM bank_txn_legs WHERE bank_txn_id = ${bankId} AND link_type = 'confirmed')
    `,
    tx`DELETE FROM bank_txn_legs WHERE bank_txn_id = ${bankId}`,
    // SL Media's publication ledger (lib/media.ts): entries this bank line created
    // go; entries typed in from the spreadsheet and later tied to it are untied.
    tx`DELETE FROM media_receipts WHERE bank_txn_id = ${bankId} AND origin = 'bank'`,
    tx`DELETE FROM media_payouts WHERE bank_txn_id = ${bankId} AND origin = 'bank'`,
    tx`UPDATE media_receipts SET bank_txn_id = NULL WHERE bank_txn_id = ${bankId}`,
    tx`UPDATE media_payouts SET bank_txn_id = NULL WHERE bank_txn_id = ${bankId}`,
    tx`UPDATE bank_txns SET status = 'pending', exclude_reason = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = ${bankId}`,
  ])
  refreshUi()
  return bankResult(bankId)
}

// ─── shared result ───────────────────────────────────────────────────────────

export async function bankResult(bankId: number) {
  const b = (await sql`
    SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, amount::float8 AS amount, name_norm AS counterparty,
           status, exclude_reason, resolved_by
    FROM bank_txns WHERE id = ${bankId}
  `) as Row[]
  const legs = (await sql`
    SELECT l.link_type, l.transaction_id, l.amount::float8 AS amount, t.category, t.type, t.status,
           COALESCE(p.name, e.name) AS books, t.rental_period, COALESCE(t.is_deposit, FALSE) AS is_deposit
    FROM bank_txn_legs l
    LEFT JOIN transactions t ON t.id = l.transaction_id
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN entities e ON e.id = t.entity_id AND t.property_id IS NULL
    WHERE l.bank_txn_id = ${bankId}
    ORDER BY l.id
  `) as Row[]
  return { bank_txn: b[0], legs }
}
