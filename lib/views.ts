// lib/views.ts
// Read-only queries behind the simplified site. Nothing here writes. All money
// figures follow the house conventions: actual rows only, security deposits
// excluded, amounts positive with direction from type.
import sql from './db'

const pad = (n: number) => String(n).padStart(2, '0')

export function ymNow(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** The `count` months ending with `endYm`, oldest first, as YYYY-MM. */
export function monthsEnding(endYm: string, count: number) {
  const [y, m] = endYm.split('-').map(Number)
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Rent roll
// ---------------------------------------------------------------------------

export type RentState = 'paid' | 'partial' | 'late' | 'due' | 'none'
export type RentCell = { ym: string; received: number; open: number; state: RentState }
export type RentLine = {
  key: string
  propertyId: number
  propertyName: string
  unitId: number | null
  unitLabel: string | null
  tenant: string | null
  cells: RentCell[]
}

/**
 * One line per rented unit (or per property when rent is booked to the whole
 * property), one cell per month. A month's rent is matched by
 * COALESCE(rental_period, month of the transaction), the same rule the bot API
 * uses, so a payment made on the 2nd for last month lands in last month.
 * Unpaid rent is an outstanding scheduled (forecast) rent row; it turns late
 * once it is 7 days past its due date, matching get_attention.
 */
export async function rentGrid(propertyIds: number[], months: string[]): Promise<RentLine[]> {
  if (!propertyIds.length || !months.length) return []
  const first = months[0], last = months[months.length - 1]

  const rows = (await sql`
    SELECT t.property_id, p.name AS property_name, t.unit_id, u.label AS unit_label,
           COALESCE(u.current_tenant, p.current_tenant) AS tenant,
           COALESCE(t.rental_period, to_char(t.txn_date, 'YYYY-MM')) AS ym,
           t.status,
           SUM(t.amount)::float8 AS amount,
           BOOL_OR(t.status = 'forecast' AND t.txn_date <= CURRENT_DATE - 7) AS overdue
    FROM transactions t
    JOIN properties p ON p.id = t.property_id
    LEFT JOIN units u ON u.id = t.unit_id
    WHERE t.property_id = ANY(${propertyIds}::int[])
      AND t.type = 'income' AND t.category ILIKE '%rent%'
      AND COALESCE(t.is_deposit, FALSE) = FALSE
      AND t.status IN ('actual', 'forecast')
      AND COALESCE(t.rental_period, to_char(t.txn_date, 'YYYY-MM')) BETWEEN ${first} AND ${last}
    GROUP BY t.property_id, p.name, t.unit_id, u.label, tenant, ym, t.status
  `) as {
    property_id: number; property_name: string; unit_id: number | null; unit_label: string | null
    tenant: string | null; ym: string; status: string; amount: number; overdue: boolean
  }[]

  // Properties whose rent is booked per unit get one line per unit; a property
  // whose rent is booked to the property (or to its single unit) gets one line.
  const unitsUsed = new Map<number, Set<number | null>>()
  for (const r of rows) {
    const s = unitsUsed.get(r.property_id) ?? new Set()
    s.add(r.unit_id)
    unitsUsed.set(r.property_id, s)
  }
  const perUnit = (pid: number) => {
    const s = unitsUsed.get(pid)
    if (!s) return false
    return [...s].filter((x) => x !== null).length > 1
  }

  const lines = new Map<string, RentLine & { byYm: Map<string, RentCell & { overdue: boolean }> }>()
  for (const r of rows) {
    const split = perUnit(r.property_id) && r.unit_id !== null
    const key = split ? `${r.property_id}:${r.unit_id}` : `${r.property_id}`
    let line = lines.get(key)
    if (!line) {
      line = {
        key, propertyId: r.property_id, propertyName: r.property_name,
        unitId: split ? r.unit_id : null, unitLabel: split ? r.unit_label : null,
        tenant: r.tenant, cells: [], byYm: new Map(),
      }
      lines.set(key, line)
    }
    if (!line.tenant && r.tenant) line.tenant = r.tenant
    const c = line.byYm.get(r.ym) ?? { ym: r.ym, received: 0, open: 0, state: 'none' as RentState, overdue: false }
    if (r.status === 'actual') c.received += r.amount
    else { c.open += r.amount; c.overdue = c.overdue || r.overdue }
    line.byYm.set(r.ym, c)
  }

  const out: RentLine[] = []
  for (const line of lines.values()) {
    const cells = months.map((ym) => {
      const c = line.byYm.get(ym)
      if (!c) return { ym, received: 0, open: 0, state: 'none' as RentState }
      const state: RentState =
        c.open > 0 ? (c.overdue ? 'late' : c.received > 0 ? 'partial' : 'due')
        : c.received > 0 ? 'paid' : 'none'
      return { ym, received: round(c.received), open: round(c.open), state }
    })
    out.push({
      key: line.key, propertyId: line.propertyId, propertyName: line.propertyName,
      unitId: line.unitId, unitLabel: line.unitLabel, tenant: line.tenant, cells,
    })
  }
  // Properties in the order the caller listed them, units by label.
  const order = new Map(propertyIds.map((id, i) => [id, i]))
  return out.sort((a, b) =>
    (order.get(a.propertyId)! - order.get(b.propertyId)!) ||
    (a.unitLabel || '').localeCompare(b.unitLabel || ''))
}

const round = (n: number) => Math.round(n * 100) / 100

// ---------------------------------------------------------------------------
// Property headline figures
// ---------------------------------------------------------------------------

export type PropertyHeadline = {
  propertyId: number
  incomeYtd: number
  expenseYtd: number
  netYtd: number
  lastDistribution: { period: string; total: number } | null
}

export async function propertyHeadlines(propertyIds: number[], year: number): Promise<Map<number, PropertyHeadline>> {
  const out = new Map<number, PropertyHeadline>()
  if (!propertyIds.length) return out
  for (const id of propertyIds) out.set(id, { propertyId: id, incomeYtd: 0, expenseYtd: 0, netYtd: 0, lastDistribution: null })

  const sums = (await sql`
    SELECT property_id, type, SUM(amount)::float8 AS total
    FROM transactions
    WHERE property_id = ANY(${propertyIds}::int[]) AND status = 'actual'
      AND EXTRACT(YEAR FROM txn_date) = ${year}
      AND COALESCE(is_deposit, FALSE) = FALSE
    GROUP BY property_id, type
  `) as { property_id: number; type: string; total: number }[]
  for (const s of sums) {
    const h = out.get(s.property_id)!
    if (s.type === 'income') h.incomeYtd = round(s.total)
    else h.expenseYtd = round(s.total)
    h.netYtd = round(h.incomeYtd - h.expenseYtd)
  }

  const dist = (await sql`
    SELECT DISTINCT ON (property_id) property_id, period, total
    FROM (
      SELECT property_id, period, SUM(amount)::float8 AS total
      FROM distributions WHERE property_id = ANY(${propertyIds}::int[])
      GROUP BY property_id, period
    ) d
    ORDER BY property_id, period DESC
  `) as { property_id: number; period: string; total: number }[]
  for (const d of dist) out.get(d.property_id)!.lastDistribution = { period: d.period, total: round(d.total) }
  return out
}

// ---------------------------------------------------------------------------
// Property overview
// ---------------------------------------------------------------------------

export type CategoryYears = {
  years: number[]
  income: { category: string; byYear: Record<number, number> }[]
  expense: { category: string; byYear: Record<number, number> }[]
  totals: Record<number, { income: number; expense: number; net: number }>
}

/** Cash in and out by category for the given years (actuals, deposits excluded). */
export async function categoryYears(propertyId: number, years: number[]): Promise<CategoryYears> {
  const rows = (await sql`
    SELECT EXTRACT(YEAR FROM txn_date)::int AS yr, type, category, SUM(amount)::float8 AS total
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'actual'
      AND COALESCE(is_deposit, FALSE) = FALSE
      AND EXTRACT(YEAR FROM txn_date) = ANY(${years}::int[])
    GROUP BY yr, type, category
  `) as { yr: number; type: string; category: string; total: number }[]

  const inc = new Map<string, Record<number, number>>()
  const exp = new Map<string, Record<number, number>>()
  const totals: CategoryYears['totals'] = {}
  for (const y of years) totals[y] = { income: 0, expense: 0, net: 0 }
  for (const r of rows) {
    const m = r.type === 'income' ? inc : exp
    const rec = m.get(r.category) ?? {}
    rec[r.yr] = round((rec[r.yr] || 0) + r.total)
    m.set(r.category, rec)
    if (r.type === 'income') totals[r.yr].income += r.total
    else totals[r.yr].expense += r.total
  }
  for (const y of years) {
    totals[y].income = round(totals[y].income)
    totals[y].expense = round(totals[y].expense)
    totals[y].net = round(totals[y].income - totals[y].expense)
  }
  const latest = years[years.length - 1]
  const sortCats = (m: Map<string, Record<number, number>>) =>
    [...m.entries()]
      .map(([category, byYear]) => ({ category, byYear }))
      .sort((a, b) => (b.byYear[latest] || 0) - (a.byYear[latest] || 0) || a.category.localeCompare(b.category))
  return { years, income: sortCats(inc), expense: sortCats(exp), totals }
}

export type UpcomingBill = { date: string; category: string; amount: number; description: string | null }

/** Scheduled expenses in the next `days` days (taxes, insurance, utilities, loan payments). */
export async function upcomingBills(propertyId: number, days = 90): Promise<UpcomingBill[]> {
  return (await sql`
    SELECT to_char(txn_date, 'YYYY-MM-DD') AS date, category, amount::float8 AS amount, description
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'forecast' AND type = 'expense'
      AND COALESCE(is_deposit, FALSE) = FALSE
      AND txn_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ${days}::int
    ORDER BY txn_date, category
    LIMIT 20
  `) as UpcomingBill[]
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export type ActivityRow = {
  id: number; date: string; type: 'income' | 'expense'; category: string
  amount: number; description: string | null; unit: string | null; deposit: boolean
}

export async function activity(opts: {
  propertyId?: number; entityId?: number; year: number; search?: string; limit?: number
}): Promise<ActivityRow[]> {
  const q = opts.search?.trim() ? `%${opts.search.trim()}%` : null
  const limit = opts.limit ?? 400
  return (await sql`
    SELECT t.id, to_char(t.txn_date, 'YYYY-MM-DD') AS date, t.type, t.category,
           t.amount::float8 AS amount, t.description, u.label AS unit,
           COALESCE(t.is_deposit, FALSE) AS deposit
    FROM transactions t -- lists deposits, flagged; totals in the UI skip them
    LEFT JOIN units u ON u.id = t.unit_id
    WHERE t.status = 'actual'
      AND (${opts.propertyId ?? null}::int IS NULL OR t.property_id = ${opts.propertyId ?? null}::int)
      AND (${opts.entityId ?? null}::int IS NULL OR (t.entity_id = ${opts.entityId ?? null}::int AND t.property_id IS NULL))
      AND EXTRACT(YEAR FROM t.txn_date) = ${opts.year}
      AND (${q}::text IS NULL OR t.description ILIKE ${q} OR t.category ILIKE ${q}
           OR u.label ILIKE ${q} OR t.amount::text = ${opts.search?.trim().replace(/[$,]/g, '') ?? ''})
    ORDER BY t.txn_date DESC, t.id DESC
    LIMIT ${limit}
  `) as ActivityRow[]
}

/** Years that have any actual activity, newest first. */
export async function activityYears(opts: { propertyId?: number; entityId?: number }): Promise<number[]> {
  const rows = (await sql`
    SELECT DISTINCT EXTRACT(YEAR FROM txn_date)::int AS yr
    FROM transactions -- lists deposits: years only, no sums
    WHERE status = 'actual'
      AND (${opts.propertyId ?? null}::int IS NULL OR property_id = ${opts.propertyId ?? null}::int)
      AND (${opts.entityId ?? null}::int IS NULL OR (entity_id = ${opts.entityId ?? null}::int AND property_id IS NULL))
    ORDER BY yr DESC
  `) as { yr: number }[]
  return rows.map((r) => r.yr)
}

// ---------------------------------------------------------------------------
// Partners
// ---------------------------------------------------------------------------

export type DistributionPeriod = {
  period: string; paidOn: string | null; total: number; byOwner: Record<string, number>
}

export async function distributionHistory(propertyId: number): Promise<{ owners: string[]; periods: DistributionPeriod[] }> {
  const rows = (await sql`
    SELECT d.period, o.name AS owner, to_char(MAX(d.distributed_on), 'YYYY-MM-DD') AS paid_on,
           SUM(d.amount)::float8 AS amount
    FROM distributions d JOIN owners o ON o.id = d.owner_id
    WHERE d.property_id = ${propertyId}
    GROUP BY d.period, o.name
    ORDER BY d.period DESC
  `) as { period: string; owner: string; paid_on: string | null; amount: number }[]
  const owners: string[] = []
  const map = new Map<string, DistributionPeriod>()
  for (const r of rows) {
    if (!owners.includes(r.owner)) owners.push(r.owner)
    const p = map.get(r.period) ?? { period: r.period, paidOn: null, total: 0, byOwner: {} }
    p.byOwner[r.owner] = round((p.byOwner[r.owner] || 0) + r.amount)
    p.total = round(p.total + r.amount)
    if (r.paid_on && (!p.paidOn || r.paid_on > p.paidOn)) p.paidOn = r.paid_on
    map.set(r.period, p)
  }
  return { owners, periods: [...map.values()] }
}

/** The most recent quarter that has ended, e.g. 2026-Q3 on Oct 10 2026. */
export function lastEndedQuarter(d = new Date()) {
  const q = Math.floor(d.getMonth() / 3) // 0..3, the current quarter index
  return q === 0 ? `${d.getFullYear() - 1}-Q4` : `${d.getFullYear()}-Q${q}`
}

// ---------------------------------------------------------------------------
// Companies (entity books: property_id NULL)
// ---------------------------------------------------------------------------

export type Company = { id: number; slug: string; name: string; legal_name: string | null; type: string; notes: string | null }

export async function listCompanies(): Promise<Company[]> {
  return (await sql`
    SELECT id, slug, name, legal_name, type, notes FROM entities
    WHERE type <> 'property' AND status = 'active' AND slug IS NOT NULL
    ORDER BY name
  `) as Company[]
}

export async function companyCategoryYear(entityId: number, year: number) {
  return (await sql`
    SELECT type, category, SUM(amount)::float8 AS total
    FROM transactions
    WHERE entity_id = ${entityId} AND property_id IS NULL AND status = 'actual'
      AND COALESCE(is_deposit, FALSE) = FALSE AND EXTRACT(YEAR FROM txn_date) = ${year}
    GROUP BY type, category
    ORDER BY type DESC, total DESC
  `) as { type: string; category: string; total: number }[]
}

// ---------------------------------------------------------------------------
// Late rent (same rule as get_attention: scheduled rent 7+ days past due)
// ---------------------------------------------------------------------------

export type LateRent = {
  propertyId: number; propertyName: string; unitLabel: string | null; tenant: string | null
  months: string[]; total: number
}

export async function lateRent(propertyIds: number[]): Promise<LateRent[]> {
  if (!propertyIds.length) return []
  const rows = (await sql`
    SELECT t.property_id, p.name AS property_name, t.unit_id, u.label AS unit_label,
           COALESCE(u.current_tenant, p.current_tenant) AS tenant,
           COALESCE(t.rental_period, to_char(t.txn_date, 'YYYY-MM')) AS ym,
           t.amount::float8 AS amount
    FROM transactions t
    JOIN properties p ON p.id = t.property_id
    LEFT JOIN units u ON u.id = t.unit_id
    WHERE t.property_id = ANY(${propertyIds}::int[])
      AND t.status = 'forecast' AND t.type = 'income' AND t.category ILIKE '%rent%'
      AND COALESCE(t.is_deposit, FALSE) = FALSE
      AND t.txn_date <= CURRENT_DATE - 7
    ORDER BY p.name, u.label NULLS FIRST, t.txn_date
  `) as { property_id: number; property_name: string; unit_id: number | null; unit_label: string | null; tenant: string | null; ym: string; amount: number }[]
  const map = new Map<string, LateRent>()
  for (const r of rows) {
    const k = `${r.property_id}:${r.unit_id ?? 0}`
    const cur = map.get(k) ?? {
      propertyId: r.property_id, propertyName: r.property_name, unitLabel: r.unit_label,
      tenant: r.tenant, months: [], total: 0,
    }
    if (!cur.months.includes(r.ym)) cur.months.push(r.ym)
    cur.total = round(cur.total + r.amount)
    map.set(k, cur)
  }
  return [...map.values()]
}

/** Rent received and still expected for one calendar month across properties. */
export async function rentMonth(propertyIds: number[], ym: string) {
  if (!propertyIds.length) return { received: 0, open: 0 }
  const r = (await sql`
    SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'actual'), 0)::float8 AS received,
           COALESCE(SUM(amount) FILTER (WHERE status = 'forecast'), 0)::float8 AS open
    FROM transactions
    WHERE property_id = ANY(${propertyIds}::int[])
      AND type = 'income' AND category ILIKE '%rent%' AND COALESCE(is_deposit, FALSE) = FALSE
      AND COALESCE(rental_period, to_char(txn_date, 'YYYY-MM')) = ${ym}
  `) as { received: number; open: number }[]
  return { received: round(r[0]?.received || 0), open: round(r[0]?.open || 0) }
}
