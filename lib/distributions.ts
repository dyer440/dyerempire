// lib/distributions.ts  (UPDATED — split is flip-aware: 50/50 after payback)
import sql from './db'
import { flipActiveForPeriod } from './payback'

export const RESERVED_CATEGORIES = ['Property Taxes', 'Insurance'] as const
const RESERVED_SET = new Set<string>(RESERVED_CATEGORIES)

export function quarterBounds(period: string) {
  const [ys, qs] = period.split('-Q')
  const y = Number(ys)
  const q = Number(qs)
  const starts = ['01-01', '04-01', '07-01', '10-01']
  const ends = ['03-31', '06-30', '09-30', '12-31']
  return { y, q, start: `${y}-${starts[q - 1]}`, end: `${y}-${ends[q - 1]}`, yearStart: `${y}-01-01`, label: `${y}-Q${q}` }
}

export function isValidPeriod(period: string): boolean {
  return /^\d{4}-Q[1-4]$/.test(period)
}

function perYear(frequency: string, monthsCsv: string | null): number {
  if (monthsCsv && monthsCsv.trim()) return monthsCsv.split(',').filter((x) => x.trim()).length
  return ({ monthly: 12, quarterly: 4, semiannual: 2, annual: 1 } as Record<string, number>)[frequency] ?? 1
}

export async function reserveTargetAnnual(propertyId: number): Promise<number> {
  const rows = (await sql`
    SELECT amount, frequency, months_csv FROM recurring_schedules
    WHERE property_id = ${propertyId} AND status = 'active' AND category IN ('Property Taxes', 'Insurance')
  `) as { amount: string; frequency: string; months_csv: string | null }[]
  let total = 0
  for (const r of rows) total += parseFloat(r.amount) * perYear(r.frequency, r.months_csv)
  return total
}

export type OwnerSplit = { owner_id: number; name: string; pct: number; amount: number }
export type QuarterComputation = {
  label: string; start: string; end: string; q: number
  income: number; opExpense: number; reservedExpense: number
  operatingNet: number; allInNet: number
  annualReserve: number; reserveTargetQuarter: number
  distributable: number
  reservedPaidYtd: number; reserveAccrued: number; reserveBalance: number
  split: OwnerSplit[]
  flipActive: boolean
}

export async function computeQuarter(propertyId: number, period: string): Promise<QuarterComputation> {
  const { q, start, end, yearStart, label } = quarterBounds(period)

  const rows = (await sql`
    SELECT type, category, COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions WHERE property_id = ${propertyId} AND status = 'actual'
      AND txn_date BETWEEN ${start} AND ${end}
    GROUP BY type, category
  `) as { type: string; category: string; total: number }[]

  let income = 0, opExpense = 0, reservedExpense = 0
  for (const r of rows) {
    if (r.type === 'income') income += r.total
    else if (RESERVED_SET.has(r.category)) reservedExpense += r.total
    else opExpense += r.total
  }

  const operatingNet = income - opExpense
  const allInNet = income - opExpense - reservedExpense

  const annualReserve = await reserveTargetAnnual(propertyId)
  const reserveTargetQuarter = annualReserve / 4
  const distributable = operatingNet - reserveTargetQuarter

  const paidRows = (await sql`
    SELECT COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions WHERE property_id = ${propertyId} AND status = 'actual'
      AND category IN ('Property Taxes', 'Insurance') AND txn_date BETWEEN ${yearStart} AND ${end}
  `) as { total: number }[]
  const reservedPaidYtd = paidRows[0]?.total || 0
  const reserveAccrued = q * reserveTargetQuarter
  const reserveBalance = reserveAccrued - reservedPaidYtd

  const owners = (await sql`
    SELECT o.id AS owner_id, o.name, po.ownership_pct
    FROM property_owners po JOIN owners o ON o.id = po.owner_id
    WHERE po.property_id = ${propertyId} ORDER BY po.ownership_pct DESC
  `) as { owner_id: number; name: string; ownership_pct: string }[]

  // After payback, distributions split evenly (50/50 for two owners); otherwise by ownership %.
  const flipActive = await flipActiveForPeriod(propertyId, period)
  const evenPct = owners.length > 0 ? 100 / owners.length : 0

  const split: OwnerSplit[] = owners.map((o) => {
    const pct = flipActive ? evenPct : parseFloat(o.ownership_pct)
    return { owner_id: o.owner_id, name: o.name, pct, amount: distributable > 0 ? (distributable * pct) / 100 : 0 }
  })

  return {
    label, start, end, q, income, opExpense, reservedExpense,
    operatingNet, allInNet, annualReserve, reserveTargetQuarter, distributable,
    reservedPaidYtd, reserveAccrued, reserveBalance, split, flipActive,
  }
}
