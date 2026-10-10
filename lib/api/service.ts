// lib/api/service.ts
// The bot API's single service layer. REST routes (app/api/v1/*) and the MCP
// endpoint (app/api/mcp) both call these functions, so the rules below hold no
// matter how a bot connects.
//
// WRITE RULES (Betsy-level, same as the UI):
//   • Closed periods are locked, exactly as in the ledger UI.
//   • Categories must exist in the categories table; type is derived from them.
//   • Bots can delete SCHEDULED (forecast) rows only, never actuals.
//   • Amount/date of a bank-reconciled row can't be changed (would break the match).
//   • Exact duplicates, and payments that already have a matching forecast, are
//     refused unless allow_duplicate is sent (same warn-then-confirm pattern as
//     the over-distribution guard).
//   • Every write and its audit row are ONE SQL statement (data-modifying CTE),
//     so nothing can change without landing in mutations_log.
//   • Distributions and period closes live in lib/api/periods.ts: $0 records and
//     closes are routine; a positive payout needs the owner's explicit confirmation.
//
// ENTITY SCOPE: entity_id means that entity's OWN books (property_id IS NULL),
// matching /real-estate/entity/[slug] and /real-estate/slcm.
import sql from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { INCOME_CATEGORIES, EXPENSE_CATEGORIES } from '@/lib/categories'
import { lineForCategory } from '@/lib/form8825'
import { computeQuarter } from '@/lib/distributions'
import { computeCapitalAccounts } from '@/lib/capital'
import { generateForecasts, generateEntityForecasts } from '@/lib/recurring'
import { ApiError, badRequest, conflict, notFound, pgCode } from './errors'
import {
  type Input, optInt, reqInt, optDate, reqDate, optAmount, reqAmount, optString, optBool,
  optEnum, optRentalPeriod, clampInt,
} from './validate'

export type Actor = { actor: string; keyId: number | null; source: 'api' | 'mcp' }
// SQL rows are dynamic by nature; columns are typed at the point of use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export function refreshUi() {
  // Outside a Next request (tests, scripts) revalidatePath throws; that's fine.
  try { revalidatePath('/real-estate', 'layout') } catch { /* not in a request */ }
}

export async function isDateClosed(propertyId: number, date: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM period_closes
    WHERE property_id = ${propertyId} AND ${date}::date BETWEEN period_start AND period_end
    LIMIT 1
  `) as Row[]
  return rows.length > 0
}

export function closedError(date: string) {
  return conflict('period_closed', `${date} falls in a closed period for that property and is locked. Reopen the period in the app first.`)
}

// ─── Reference data ──────────────────────────────────────────────────────────

/** Category name → kind, from the categories table (falls back to lib/categories). */
async function categoryKinds(): Promise<Map<string, 'income' | 'expense'>> {
  const map = new Map<string, 'income' | 'expense'>()
  try {
    const rows = (await sql`
      SELECT name, kind FROM categories WHERE is_active = TRUE ORDER BY sort_order, name
    `) as { name: string; kind: string }[]
    for (const r of rows) map.set(r.name, r.kind === 'income' ? 'income' : 'expense')
  } catch { /* categories table not migrated */ }
  if (map.size === 0) {
    for (const c of INCOME_CATEGORIES) map.set(c, 'income')
    for (const c of EXPENSE_CATEGORIES) map.set(c, 'expense')
  }
  return map
}

/** Case-insensitive category resolution, so "property taxes" → "Property Taxes". */
export async function resolveCategory(raw: string): Promise<{ name: string; kind: 'income' | 'expense' }> {
  const kinds = await categoryKinds()
  for (const [name, kind] of kinds) {
    if (name.toLowerCase() === raw.trim().toLowerCase()) return { name, kind }
  }
  throw badRequest(`Unknown category "${raw}".`, { valid_categories: [...kinds.keys()] })
}

export async function listCategories() {
  const kinds = await categoryKinds()
  return [...kinds].map(([name, kind]) => ({
    name,
    kind,
    form_8825_line: kind === 'expense' ? lineForCategory(name) : null,
  }))
}

export async function listProperties() {
  return (await sql`
    SELECT p.id, p.name, p.slug, p.status, p.property_type, p.holding_entity,
           p.entity_id, e.name AS entity_name,
           p.address, p.city, p.state, p.zip,
           to_char(p.purchase_date, 'YYYY-MM-DD') AS purchase_date,
           p.purchase_price::float8 AS purchase_price, p.current_tenant,
           COALESCE((
             SELECT json_agg(json_build_object('owner_id', o.id, 'name', o.name,
                                               'pct', po.ownership_pct::float8)
                             ORDER BY po.ownership_pct DESC)
             FROM property_owners po JOIN owners o ON o.id = po.owner_id
             WHERE po.property_id = p.id), '[]'::json) AS owners,
           COALESCE((
             SELECT json_agg(json_build_object('id', u.id, 'label', u.label,
                                               'current_tenant', u.current_tenant)
                             ORDER BY u.label)
             FROM units u WHERE u.property_id = p.id), '[]'::json) AS units,
           EXISTS (SELECT 1 FROM period_closes pc WHERE pc.property_id = p.id) AS has_closed_periods
    FROM properties p
    LEFT JOIN entities e ON e.id = p.entity_id
    ORDER BY p.name
  `) as Row[]
}

export async function listEntities() {
  // tax_id deliberately omitted from the typed API.
  return (await sql`
    SELECT e.id, e.slug, e.name, e.legal_name, e.dba, e.type, e.status,
           (SELECT COUNT(*)::int FROM properties p WHERE p.entity_id = e.id) AS property_count
    FROM entities e
    ORDER BY e.type, e.name
  `) as Row[]
}

// ─── Transactions: read ──────────────────────────────────────────────────────

export async function listTransactions(input: Input) {
  const id = optInt(input, 'id')
  const propertyId = optInt(input, 'property_id')
  const entityId = optInt(input, 'entity_id')
  const status = optEnum(input, 'status', ['actual', 'forecast', 'all'] as const) ?? (id ? 'all' : 'actual')
  const type = optEnum(input, 'type', ['income', 'expense'] as const)
  const category = optString(input, 'category', 100)
  const from = optDate(input, 'from')
  const to = optDate(input, 'to')
  const q = optString(input, 'q', 100)
  const minAmount = optAmount(input, 'min_amount')
  const maxAmount = optAmount(input, 'max_amount')
  const deposits = optEnum(input, 'deposits', ['include', 'exclude', 'only'] as const) ?? 'include'
  const limit = clampInt(input, 'limit', 100, 1, 500)
  const offset = clampInt(input, 'offset', 0, 0, 1_000_000)

  const rows = (await sql`
    SELECT t.id, t.property_id, p.name AS property_name,
           COALESCE(t.entity_id, p.entity_id) AS entity_id, e.name AS entity_name,
           t.unit_id, u.label AS unit_label,
           t.type, t.category, t.amount::float8 AS amount,
           to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date, t.rental_period,
           t.description, t.method, t.status, COALESCE(t.is_deposit, FALSE) AS is_deposit,
           t.schedule_id, t.transfer_group, t.created_by,
           to_char(t.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
           EXISTS (SELECT 1 FROM bank_txn_legs l WHERE l.transaction_id = t.id) AS bank_linked,
           COUNT(*) OVER ()::int AS total_count
    FROM transactions t
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN entities e ON e.id = COALESCE(t.entity_id, p.entity_id)
    LEFT JOIN units u ON u.id = t.unit_id
    WHERE (${id}::int IS NULL OR t.id = ${id}::int)
      AND (${propertyId}::int IS NULL OR t.property_id = ${propertyId}::int)
      AND (${entityId}::int IS NULL OR (t.entity_id = ${entityId}::int AND t.property_id IS NULL))
      AND (${status}::text = 'all' OR t.status = ${status}::text)
      AND (${type}::text IS NULL OR t.type = ${type}::text)
      AND (${category}::text IS NULL OR lower(t.category) = lower(${category}::text))
      AND (${from}::date IS NULL OR t.txn_date >= ${from}::date)
      AND (${to}::date IS NULL OR t.txn_date <= ${to}::date)
      AND (${q}::text IS NULL OR t.description ILIKE '%' || ${q}::text || '%')
      AND (${minAmount}::numeric IS NULL OR t.amount >= ${minAmount}::numeric)
      AND (${maxAmount}::numeric IS NULL OR t.amount <= ${maxAmount}::numeric)
      AND (${deposits}::text = 'include'
           OR (${deposits}::text = 'exclude' AND COALESCE(t.is_deposit, FALSE) = FALSE)
           OR (${deposits}::text = 'only' AND COALESCE(t.is_deposit, FALSE) = TRUE))
    ORDER BY t.txn_date DESC, t.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as Row[]

  const total = rows[0]?.total_count ?? 0
  for (const r of rows) delete r.total_count
  return { total, limit, offset, has_more: offset + rows.length < total, transactions: rows }
}

export async function getTransaction(id: number) {
  const { transactions } = await listTransactions({ id, status: 'all', limit: 1 })
  const txn = transactions[0]
  if (!txn) throw notFound(`Transaction ${id} not found.`)
  const history = (await sql`
    SELECT id, to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS') AS at, actor, source, action
    FROM mutations_log
    WHERE target_table = 'transactions' AND target_id = ${id}
    ORDER BY id DESC LIMIT 20
  `) as Row[]
  return { ...txn, change_history: history }
}

// ─── Transactions: write ─────────────────────────────────────────────────────

async function priorIdempotent(who: Actor, key: string | null) {
  if (!key || who.keyId === null) return null
  const rows = (await sql`
    SELECT target_id FROM mutations_log
    WHERE api_key_id = ${who.keyId} AND idempotency_key = ${key}
    LIMIT 1
  `) as { target_id: number }[]
  if (!rows[0]) return null
  return { ...(await getTransaction(rows[0].target_id)), idempotent_replay: true }
}

function validIdemKey(key: string | null): string | null {
  if (!key) return null
  const k = key.trim()
  if (!k) return null
  if (k.length > 200) throw badRequest('Idempotency-Key must be 200 characters or fewer.')
  return k
}

export async function createTransaction(input: Input, who: Actor, idempotencyKey: string | null = null) {
  const idem = validIdemKey(idempotencyKey ?? optString(input, 'idempotency_key', 200))
  const replay = await priorIdempotent(who, idem)
  if (replay) return replay

  const propertyId = optInt(input, 'property_id')
  const entityId = optInt(input, 'entity_id')
  if (!!propertyId === !!entityId) {
    throw badRequest('Send exactly one of property_id (a property\'s books) or entity_id (an entity\'s own books, e.g. SLCM).')
  }
  const amount = reqAmount(input, 'amount')
  const txnDate = reqDate(input, 'txn_date')
  const description = optString(input, 'description')
  const rentalPeriod = optRentalPeriod(input)
  const isDeposit = optBool(input, 'is_deposit') ?? false
  const allowDuplicate = optBool(input, 'allow_duplicate') ?? false
  const unitId = optInt(input, 'unit_id')
  const requestedType = optEnum(input, 'type', ['income', 'expense'] as const)
  const rawCategory = optString(input, 'category', 100)

  let type: 'income' | 'expense'
  let category: string
  if (isDeposit) {
    // Mirrors the UI: a collection is income + is_deposit under Rental Income; a
    // return is expense + is_deposit under Security Deposit. Both are excluded from P&L.
    if (!propertyId) throw badRequest('Security deposits belong to a property, not an entity.')
    if (!requestedType) throw badRequest('For a deposit send type "income" (collected) or "expense" (returned).')
    type = requestedType
    category = type === 'income' ? 'Rental Income' : 'Security Deposit'
  } else {
    if (!rawCategory) throw badRequest('category is required. list_categories / GET /api/v1/categories has the valid names.')
    const c = await resolveCategory(rawCategory)
    if (c.name === 'Security Deposit') {
      throw badRequest('Record deposit activity with is_deposit: true instead of the Security Deposit category.')
    }
    if (requestedType && requestedType !== c.kind) {
      throw badRequest(`"${c.name}" is an ${c.kind} category but type was "${requestedType}".`)
    }
    type = c.kind
    category = c.name
  }
  if (rentalPeriod && type !== 'income') throw badRequest('rental_period only applies to income.')

  // Resolve the target books.
  let rowEntityId: number | null
  if (propertyId) {
    const p = (await sql`SELECT id, entity_id FROM properties WHERE id = ${propertyId}`) as Row[]
    if (!p[0]) throw notFound(`Property ${propertyId} not found.`)
    rowEntityId = p[0].entity_id ?? null
    if (unitId) {
      const u = (await sql`SELECT 1 FROM units WHERE id = ${unitId} AND property_id = ${propertyId}`) as Row[]
      if (!u[0]) throw badRequest(`Unit ${unitId} does not belong to property ${propertyId}.`)
    }
    if (await isDateClosed(propertyId, txnDate)) throw closedError(txnDate)
  } else {
    if (unitId) throw badRequest('unit_id only applies to property transactions.')
    const e = (await sql`SELECT id, type FROM entities WHERE id = ${entityId}`) as Row[]
    if (!e[0]) throw notFound(`Entity ${entityId} not found.`)
    if (e[0].type === 'property') throw badRequest('That entity is a property. Post to its property_id instead.')
    rowEntityId = entityId
  }

  // Duplicate / forecast check: same books, type and amount within ±5 days.
  const near = (await sql`
    SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS txn_date, amount::float8 AS amount,
           category, status, description
    FROM transactions
    WHERE type = ${type} AND amount = ${amount}::numeric
      AND ((${propertyId}::int IS NOT NULL AND property_id = ${propertyId}::int)
        OR (${propertyId}::int IS NULL AND property_id IS NULL AND entity_id = ${rowEntityId}::int))
      AND txn_date BETWEEN ${txnDate}::date - 5 AND ${txnDate}::date + 5
      AND status IN ('actual', 'forecast')
    ORDER BY ABS(txn_date - ${txnDate}::date), id
    LIMIT 10
  `) as Row[]
  const exact = near.filter((r) => r.status === 'actual' && r.txn_date === txnDate && r.category === category)
  const forecasts = near.filter((r) => r.status === 'forecast')
  if (!allowDuplicate && exact.length) {
    throw conflict('duplicate',
      'An identical actual transaction already exists. Send allow_duplicate: true if this really is a second one.',
      { matches: exact })
  }
  if (!allowDuplicate && forecasts.length) {
    throw conflict('forecast_exists',
      `This looks like scheduled item ${forecasts[0].id}. Confirm it with confirm_forecast instead of posting a new row, or send allow_duplicate: true.`,
      { matching_forecasts: forecasts })
  }

  let newId: number
  try {
    const rows = (await sql`
      WITH ins AS (
        INSERT INTO transactions
          (property_id, entity_id, unit_id, type, category, amount, txn_date, description,
           method, created_by, status, rental_period, is_deposit)
        VALUES
          (${propertyId}, ${rowEntityId}, ${unitId}, ${type}, ${category}, ${amount}, ${txnDate}::date,
           ${description}, 'api', ${who.actor}, 'actual', ${rentalPeriod}, ${isDeposit})
        RETURNING *
      ), log AS (
        INSERT INTO mutations_log
          (actor, api_key_id, source, action, target_table, target_id, after, idempotency_key)
        SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'transaction.create', 'transactions',
               ins.id, to_jsonb(ins), ${idem}
        FROM ins
      )
      SELECT id FROM ins
    `) as { id: number }[]
    newId = rows[0].id
  } catch (err) {
    if (pgCode(err) === '23505' && idem) {
      const again = await priorIdempotent(who, idem) // lost a race with our own retry
      if (again) return again
    }
    throw err
  }
  refreshUi()
  const created = await getTransaction(newId)
  return near.length ? { ...created, nearby_similar: near } : created
}

const EDITABLE = ['category', 'amount', 'txn_date', 'description', 'rental_period', 'unit_id'] as const

async function loadForEdit(id: number) {
  const rows = (await sql`
    SELECT t.id, t.property_id, t.entity_id, t.type, t.category, t.status,
           COALESCE(t.is_deposit, FALSE) AS is_deposit,
           to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date, t.amount::float8 AS amount,
           EXISTS (SELECT 1 FROM bank_txn_legs l WHERE l.transaction_id = t.id) AS bank_linked
    FROM transactions t WHERE t.id = ${id}
  `) as Row[]
  if (!rows[0]) throw notFound(`Transaction ${id} not found.`)
  return rows[0]
}

/** Shared validation for update + confirm. Returns the normalised patch. */
async function buildPatch(row: Row, input: Input, allowed: readonly string[]) {
  const provided = (k: string) => Object.prototype.hasOwnProperty.call(input, k)
  const unknown = Object.keys(input).filter((k) => !allowed.includes(k) && k !== 'id' && k !== 'idempotency_key')
  if (unknown.length) {
    throw badRequest(`These fields can't be changed by bots: ${unknown.join(', ')}. Editable: ${allowed.join(', ')}.`)
  }

  let category: string | null = null
  if (provided('category')) {
    if (row.is_deposit) throw conflict('deposit_row', 'Deposit rows keep their category. Edit deposits in the app.')
    const raw = optString(input, 'category', 100)
    if (!raw) throw badRequest('category cannot be blank.')
    const c = await resolveCategory(raw)
    if (c.name === 'Security Deposit') throw badRequest('Use the app to convert a row into deposit activity.')
    if (c.kind !== row.type) {
      throw badRequest(`This row is ${row.type}; "${c.name}" is an ${c.kind} category. Delete and re-enter to switch direction.`)
    }
    category = c.name
  }
  const amount = provided('amount') ? reqAmount(input, 'amount') : null
  const txnDate = provided('txn_date') ? reqDate(input, 'txn_date') : null
  const descSet = provided('description')
  const description = descSet ? optString(input, 'description') : null
  const rpSet = provided('rental_period')
  const rentalPeriod = rpSet ? optRentalPeriod(input) : null
  if (rentalPeriod && row.type !== 'income') throw badRequest('rental_period only applies to income.')
  const unitSet = provided('unit_id')
  const unitId = unitSet ? optInt(input, 'unit_id') : null
  if (unitSet && unitId !== null) {
    if (!row.property_id) throw badRequest('unit_id only applies to property transactions.')
    const u = (await sql`SELECT 1 FROM units WHERE id = ${unitId} AND property_id = ${row.property_id}`) as Row[]
    if (!u[0]) throw badRequest(`Unit ${unitId} does not belong to property ${row.property_id}.`)
  }

  if (row.bank_linked) {
    if (amount !== null && Math.round(amount * 100) !== Math.round(row.amount * 100)) {
      throw conflict('bank_reconciled', 'This row is matched to a bank transaction, so its amount is fixed. Revert the bank match in Import first.')
    }
    if (txnDate !== null && txnDate !== row.txn_date) {
      throw conflict('bank_reconciled', 'This row is matched to a bank transaction, so its date is fixed. Revert the bank match in Import first.')
    }
  }
  if (row.property_id) {
    if (await isDateClosed(row.property_id, row.txn_date)) throw closedError(row.txn_date)
    if (txnDate && (await isDateClosed(row.property_id, txnDate))) throw closedError(txnDate)
  }
  return { category, amount, txnDate, descSet, description, rpSet, rentalPeriod, unitSet, unitId }
}

export async function updateTransaction(id: number, input: Input, who: Actor) {
  const row = await loadForEdit(id)
  const changes = Object.keys(input).filter((k) => k !== 'id' && k !== 'idempotency_key')
  if (!changes.length) throw badRequest(`Nothing to change. Editable fields: ${EDITABLE.join(', ')}.`)
  const p = await buildPatch(row, input, EDITABLE)

  await sql`
    WITH prev AS (SELECT * FROM transactions WHERE id = ${id}),
    upd AS (
      UPDATE transactions SET
        category      = COALESCE(${p.category}::text, category),
        amount        = COALESCE(${p.amount}::numeric, amount),
        txn_date      = COALESCE(${p.txnDate}::date, txn_date),
        description   = CASE WHEN ${p.descSet}::boolean THEN ${p.description}::text ELSE description END,
        rental_period = CASE WHEN ${p.rpSet}::boolean THEN ${p.rentalPeriod}::text ELSE rental_period END,
        unit_id       = CASE WHEN ${p.unitSet}::boolean THEN ${p.unitId}::int ELSE unit_id END
      WHERE id = ${id}
      RETURNING *
    )
    INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after)
    SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'transaction.update', 'transactions',
           upd.id, to_jsonb(prev), to_jsonb(upd)
    FROM prev, upd
  `
  refreshUi()
  return getTransaction(id)
}

export async function confirmForecast(id: number, input: Input, who: Actor) {
  const row = await loadForEdit(id)
  if (row.status !== 'forecast') {
    throw conflict('not_forecast', `Transaction ${id} is already ${row.status}. Only scheduled (forecast) rows can be confirmed.`)
  }
  const p = await buildPatch(row, input, ['amount', 'txn_date', 'description', 'category'])

  await sql`
    WITH prev AS (SELECT * FROM transactions WHERE id = ${id}),
    upd AS (
      UPDATE transactions SET
        status      = 'actual',
        method      = 'confirmed',
        created_by  = ${who.actor},
        category    = COALESCE(${p.category}::text, category),
        amount      = COALESCE(${p.amount}::numeric, amount),
        txn_date    = COALESCE(${p.txnDate}::date, txn_date),
        description = CASE WHEN ${p.descSet}::boolean THEN ${p.description}::text ELSE description END
      WHERE id = ${id} AND status = 'forecast'
      RETURNING *
    )
    INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after)
    SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'transaction.confirm', 'transactions',
           upd.id, to_jsonb(prev), to_jsonb(upd)
    FROM prev, upd
  `
  refreshUi()
  return getTransaction(id)
}

export async function deleteForecast(id: number, who: Actor) {
  const row = await loadForEdit(id)
  if (row.status !== 'forecast') {
    throw conflict('not_forecast',
      `Transaction ${id} is an actual. Bots can only delete scheduled (forecast) rows; delete actuals in the app.`)
  }
  if (row.property_id && (await isDateClosed(row.property_id, row.txn_date))) throw closedError(row.txn_date)

  await sql`
    WITH del AS (
      DELETE FROM transactions WHERE id = ${id} AND status = 'forecast' RETURNING *
    )
    INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before)
    SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'transaction.delete_forecast', 'transactions',
           del.id, to_jsonb(del)
    FROM del
  `
  refreshUi()
  return { deleted: true, id }
}

export async function regenerateForecasts(input: Input, who: Actor) {
  const propertyId = optInt(input, 'property_id')
  const entityId = optInt(input, 'entity_id')
  if (!!propertyId === !!entityId) throw badRequest('Send exactly one of property_id or entity_id.')

  let created: number
  if (propertyId) {
    const p = (await sql`SELECT 1 FROM properties WHERE id = ${propertyId}`) as Row[]
    if (!p[0]) throw notFound(`Property ${propertyId} not found.`)
    created = await generateForecasts(propertyId)
  } else {
    const e = (await sql`SELECT type FROM entities WHERE id = ${entityId}`) as Row[]
    if (!e[0]) throw notFound(`Entity ${entityId} not found.`)
    created = await generateEntityForecasts(entityId!)
  }
  await sql`
    INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after)
    VALUES (${who.actor}, ${who.keyId}, ${who.source}, 'forecasts.regenerate',
            ${propertyId ? 'properties' : 'entities'}, ${propertyId ?? entityId},
            ${JSON.stringify({ forecasts_created: created })}::jsonb)
  `
  refreshUi()
  return { property_id: propertyId, entity_id: entityId, forecasts_created: created }
}

// ─── Property analytics (read-only wrappers over the validated engines) ──────

export async function getQuarter(input: Input) {
  const propertyId = reqInt(input, 'property_id')
  const period = optString(input, 'period', 7)
  if (!period || !/^\d{4}-Q[1-4]$/.test(period)) throw badRequest('period is required, e.g. 2026-Q3.')
  const p = (await sql`SELECT id, name FROM properties WHERE id = ${propertyId}`) as Row[]
  if (!p[0]) throw notFound(`Property ${propertyId} not found.`)
  const computation = await computeQuarter(propertyId, period)
  const recorded = (await sql`
    SELECT o.name AS owner, d.amount::float8 AS amount, d.status
    FROM distributions d JOIN owners o ON o.id = d.owner_id
    WHERE d.property_id = ${propertyId} AND d.period = ${period}
    ORDER BY d.amount DESC
  `) as Row[]
  const closed = (await sql`
    SELECT 1 FROM period_closes WHERE property_id = ${propertyId} AND label = ${period} LIMIT 1
  `) as Row[]
  return {
    property: p[0],
    period,
    is_closed: closed.length > 0,
    recorded_distributions: recorded,
    computation,
    note: 'runwayDistributable is a model recommendation. A positive payout is recorded only after the owner confirms the exact amount (record_distribution with confirm_payout).',
  }
}

export async function getCapital(input: Input) {
  const propertyId = reqInt(input, 'property_id')
  const p = (await sql`SELECT id, name FROM properties WHERE id = ${propertyId}`) as Row[]
  if (!p[0]) throw notFound(`Property ${propertyId} not found.`)
  return { property: p[0], ...(await computeCapitalAccounts(propertyId)) }
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export async function recentChanges(input: Input) {
  const limit = clampInt(input, 'limit', 50, 1, 500)
  const actor = optString(input, 'actor', 100)
  const since = optDate(input, 'since')
  const withDetail = optBool(input, 'detail') ?? false
  const rows = (await sql`
    SELECT id, to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS') AS at, actor, source, action,
           target_table, target_id, note,
           CASE WHEN ${withDetail}::boolean THEN before END AS before,
           CASE WHEN ${withDetail}::boolean THEN after END AS after
    FROM mutations_log
    WHERE (${actor}::text IS NULL OR actor = ${actor}::text)
      AND (${since}::date IS NULL OR at >= ${since}::date)
    ORDER BY id DESC
    LIMIT ${limit}
  `) as Row[]
  return { changes: rows }
}

export { ApiError }
