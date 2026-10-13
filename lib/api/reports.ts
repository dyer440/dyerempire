// lib/api/reports.ts
// P&L for bots. Kept in its own file so test/source-invariants.test.ts can hold
// it to the same rule as lib/distributions.ts: every aggregation over
// transactions excludes security deposits. Definitions match the app:
//   • actuals only (forecasts never count toward reported P&L)
//   • deposits excluded
//   • net_all_in       = income − ALL expenses (what the bank account saw)
//   • net_operating    = income − expenses other than Property Taxes/Insurance
//   The all-in figure is the one that governs cash. See handoff v6 §over-distribution.
import sql from '@/lib/db'
import { RESERVED_CATEGORIES } from '@/lib/distributions'
import { lineForCategory } from '@/lib/form8825'
import { badRequest, notFound } from './errors'
import { type Input, optInt, optDate, optEnum } from './validate'

const RESERVED = new Set<string>(RESERVED_CATEGORIES)
const round = (n: number) => Math.round(n * 100) / 100

type Agg = { property_id: number | null; ym: string; type: string; category: string; total: number }

type Totals = { income: number; expense: number; reserved_expense: number; net_all_in: number; net_operating: number; owner_draws: number }

// Cash paid out to an owner is a use of the net, not an expense that reduces it.
const OWNER_DRAW = 'Owner Distribution'

function totalsOf(rows: Agg[]): Totals {
  let income = 0, expense = 0, reserved = 0, draws = 0
  for (const r of rows) {
    if (r.type === 'income') income += r.total
    else if (r.category === OWNER_DRAW) draws += r.total
    else {
      expense += r.total
      if (RESERVED.has(r.category)) reserved += r.total
    }
  }
  return {
    income: round(income),
    expense: round(expense),
    reserved_expense: round(reserved),
    net_all_in: round(income - expense),
    net_operating: round(income - (expense - reserved)),
    owner_draws: round(draws),
  }
}

export async function getPnl(input: Input) {
  const propertyId = optInt(input, 'property_id')
  const entityId = optInt(input, 'entity_id')
  if (propertyId && entityId) throw badRequest('Send property_id or entity_id, not both. Omit both for all properties combined.')
  const year = new Date().getUTCFullYear()
  const from = optDate(input, 'from') ?? `${year}-01-01`
  const to = optDate(input, 'to') ?? new Date().toISOString().slice(0, 10)
  if (from > to) throw badRequest('from must be on or before to.')
  const groupBy = optEnum(input, 'group_by', ['category', 'month', 'property', 'form8825'] as const) ?? 'category'

  if (propertyId) {
    const p = (await sql`SELECT 1 FROM properties WHERE id = ${propertyId}`) as unknown[]
    if (!p.length) throw notFound(`Property ${propertyId} not found.`)
  }
  if (entityId) {
    const e = (await sql`SELECT 1 FROM entities WHERE id = ${entityId}`) as unknown[]
    if (!e.length) throw notFound(`Entity ${entityId} not found.`)
  }

  // Scope: one property | one entity's own books | all property books (default).
  // The default deliberately leaves out entity books (SLCM etc.) so management
  // fees aren't counted on both sides.
  const rows = (await sql`
    SELECT t.property_id, to_char(t.txn_date, 'YYYY-MM') AS ym, t.type, t.category,
           SUM(t.amount)::float8 AS total
    FROM transactions t
    WHERE t.status = 'actual'
      AND COALESCE(is_deposit, FALSE) = FALSE
      AND t.txn_date BETWEEN ${from}::date AND ${to}::date
      AND (
        (${propertyId}::int IS NOT NULL AND t.property_id = ${propertyId}::int)
        OR (${entityId}::int IS NOT NULL AND t.entity_id = ${entityId}::int AND t.property_id IS NULL)
        OR (${propertyId}::int IS NULL AND ${entityId}::int IS NULL AND t.property_id IS NOT NULL)
      )
    GROUP BY t.property_id, ym, t.type, t.category
  `) as Agg[]

  const scope = propertyId ? { property_id: propertyId } : entityId ? { entity_id: entityId } : { all_properties: true }
  const out: Record<string, unknown> = {
    scope, from, to, group_by: groupBy,
    basis: 'actuals only, security deposits excluded',
    totals: totalsOf(rows),
  }

  if (groupBy === 'category') {
    const m = new Map<string, { category: string; type: string; total: number }>()
    for (const r of rows) {
      const k = `${r.type}|${r.category}`
      const cur = m.get(k) || { category: r.category, type: r.type, total: 0 }
      cur.total += r.total
      m.set(k, cur)
    }
    out.groups = [...m.values()]
      .map((g) => ({ ...g, total: round(g.total), reserved: RESERVED.has(g.category) }))
      .sort((a, b) => (a.type === b.type ? b.total - a.total : a.type === 'income' ? -1 : 1))
  } else if (groupBy === 'month') {
    const months = [...new Set(rows.map((r) => r.ym))].sort()
    out.groups = months.map((ym) => ({ month: ym, ...totalsOf(rows.filter((r) => r.ym === ym)) }))
  } else if (groupBy === 'property') {
    const names = (await sql`SELECT id, name FROM properties`) as { id: number; name: string }[]
    const nameOf = new Map(names.map((n) => [n.id, n.name]))
    const ids = [...new Set(rows.map((r) => r.property_id))]
    out.groups = ids
      .map((id) => ({
        property_id: id,
        property: id === null ? '(entity books)' : nameOf.get(id) ?? `#${id}`,
        ...totalsOf(rows.filter((r) => r.property_id === id)),
      }))
      .sort((a, b) => String(a.property).localeCompare(String(b.property)))
  } else {
    // Form 8825 expense lines. Income shown as one gross-rents line.
    const lines = new Map<string, { line: string; categories: Set<string>; total: number }>()
    let income = 0
    for (const r of rows) {
      if (r.type === 'income') { income += r.total; continue }
      const line = lineForCategory(r.category) ?? '(not deductible: loan principal, escrow funding, owner distributions, deposits)'
      const cur = lines.get(line) || { line, categories: new Set<string>(), total: 0 }
      cur.categories.add(r.category)
      cur.total += r.total
      lines.set(line, cur)
    }
    out.gross_rents = round(income)
    out.groups = [...lines.values()].map((l) => ({
      line: l.line === '__UNMAPPED__' ? 'UNMAPPED (fix lib/form8825.ts)' : l.line,
      categories: [...l.categories],
      total: round(l.total),
    }))
  }
  return out
}
