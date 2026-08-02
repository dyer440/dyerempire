// lib/distributions.ts  (UPDATED — split is flip-aware: 50/50 after payback;
//                         quarter figures now INCLUDE scheduled items so the
//                         projected quarter reflects what's still to come.)
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
  upcomingReserve: number; distributableCash: number
  cumulativeActualNoi: number; distributedYtd: number; retainedCash: number
  forwardNoi: number; nextReserveBillDate: string | null
  reserveShortfall: number; projectedCashAfterBill: number; runwayDistributable: number
  reservedPaidYtd: number; reserveAccrued: number; reserveBalance: number
  split: OwnerSplit[]
  flipActive: boolean
  // Projected-quarter transparency: figures above include scheduled items.
  // `scheduledNet` is the net (income − expense) contributed by not-yet-confirmed
  // scheduled rows in this quarter, so the UI can footnote "incl. scheduled".
  scheduledIncluded: boolean
  scheduledNet: number
}

// Actuals always count; scheduled (forecast) rows count only from the start of
// the current month forward — the same boundary the ledger and the forecast
// generator use, so nothing is double-counted across the present moment. The
// condition is static SQL (no params), so it's inlined directly below.

export async function computeQuarter(propertyId: number, period: string): Promise<QuarterComputation> {
  const { q, start, end, yearStart, label } = quarterBounds(period)

  const rows = (await sql`
    SELECT type, category, COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions WHERE property_id = ${propertyId}
      AND (status = 'actual' OR (status = 'forecast' AND txn_date >= date_trunc('month', CURRENT_DATE)))
      AND txn_date BETWEEN ${start} AND ${end}
      AND COALESCE(is_deposit, FALSE) = FALSE
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

  // Net contributed by scheduled rows alone (for the "incl. scheduled" footnote).
  const schedRows = (await sql`
    SELECT type, COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions WHERE property_id = ${propertyId}
      AND status = 'forecast' AND txn_date >= date_trunc('month', CURRENT_DATE)
      AND txn_date BETWEEN ${start} AND ${end}
      AND COALESCE(is_deposit, FALSE) = FALSE
    GROUP BY type
  `) as { type: string; total: number }[]
  let scheduledNet = 0
  for (const r of schedRows) scheduledNet += r.type === 'income' ? r.total : -r.total
  const scheduledIncluded = scheduledNet !== 0

  const annualReserve = await reserveTargetAnnual(propertyId)
  const reserveTargetQuarter = annualReserve / 4
  const distributable = operatingNet - reserveTargetQuarter

  // Forward-looking CASH reserve: this property's own scheduled tax/insurance due
  // in the next 6 months. Since bills are paid lump-sum out of held cash (not
  // pre-accrued into a reserve account), THIS is what must actually stay put
  // before distributing — the real "hold the next bill" number, distinct from the
  // smoothed annual/4 above. distributableCash is the conservative, cash-true
  // recommendation; `distributable` (smoothed) is kept as an accrual-basis reference.
  const upcomingRows = (await sql`
    SELECT COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'forecast'
      AND category IN ('Property Taxes', 'Insurance')
      AND txn_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '6 months')
  `) as { total: number }[]
  const upcomingReserve = upcomingRows[0]?.total || 0
  const distributableCash = operatingNet - upcomingReserve

  // ---- Forward runway: "safe to distribute today" ----
  // The cash question at distribution time is a runway: retained cash you've
  // ALREADY earned, plus scheduled NOI arriving before the next reserve bill,
  // must cover that bill. Forward NOI RELIEVES how much of today's cash you must
  // hold — it never adds to what you can give (you can't distribute rent you
  // haven't collected). So the figure is capped at retained cash.
  //   retainedCash      = cumulative ACTUAL operating NOI (year→period end) − distributed YTD
  //   forwardNoi        = scheduled/booked operating NOI from period end → the next reserve bill
  //   reserveShortfall  = the part of the upcoming bill forward NOI WON'T cover
  //   runwayDistributable = retainedCash − reserveShortfall  (floored at 0)
  const ytdRows = (await sql`
    SELECT type, category, COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions WHERE property_id = ${propertyId} AND status = 'actual'
      AND txn_date BETWEEN ${yearStart} AND ${end}
      AND COALESCE(is_deposit, FALSE) = FALSE
    GROUP BY type, category
  `) as { type: string; category: string; total: number }[]
  let cumIncome = 0, cumOpEx = 0
  for (const r of ytdRows) {
    if (r.type === 'income') cumIncome += r.total
    else if (!RESERVED_SET.has(r.category)) cumOpEx += r.total
  }
  const cumulativeActualNoi = cumIncome - cumOpEx

  const distRows = (await sql`
    SELECT COALESCE(SUM(amount), 0)::float8 AS total FROM distributions
    WHERE property_id = ${propertyId} AND period LIKE ${period.slice(0, 4) + '-%'}
  `) as { total: number }[]
  const distributedYtd = distRows[0]?.total || 0
  const retainedCash = cumulativeActualNoi - distributedYtd

  const billDateRows = (await sql`
    SELECT to_char(MAX(txn_date), 'YYYY-MM-DD') AS d FROM transactions
    WHERE property_id = ${propertyId} AND status = 'forecast'
      AND category IN ('Property Taxes', 'Insurance')
      AND txn_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '6 months')
  `) as { d: string | null }[]
  const nextReserveBillDate = billDateRows[0]?.d || null

  let forwardNoi = 0
  if (nextReserveBillDate) {
    const fwd = (await sql`
      SELECT type, category, COALESCE(SUM(amount), 0)::float8 AS total
      FROM transactions WHERE property_id = ${propertyId}
        AND (status = 'actual' OR status = 'forecast')
        AND txn_date > ${end} AND txn_date <= ${nextReserveBillDate}
        AND COALESCE(is_deposit, FALSE) = FALSE
      GROUP BY type, category
    `) as { type: string; category: string; total: number }[]
    let fi = 0, fe = 0
    for (const r of fwd) {
      if (r.type === 'income') fi += r.total
      else if (!RESERVED_SET.has(r.category)) fe += r.total
    }
    forwardNoi = fi - fe
  }
  const reserveShortfall = Math.max(0, upcomingReserve - forwardNoi)
  const projectedCashAfterBill = retainedCash + forwardNoi - upcomingReserve
  const runwayDistributable = Math.max(0, retainedCash - reserveShortfall)

  // "Paid YTD" means actually paid — keep this actuals-only.
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
    return { owner_id: o.owner_id, name: o.name, pct, amount: runwayDistributable > 0 ? (runwayDistributable * pct) / 100 : 0 }
  })

  return {
    label, start, end, q, income, opExpense, reservedExpense,
    operatingNet, allInNet, annualReserve, reserveTargetQuarter, distributable,
    upcomingReserve, distributableCash,
    cumulativeActualNoi, distributedYtd, retainedCash, forwardNoi,
    nextReserveBillDate, reserveShortfall, projectedCashAfterBill, runwayDistributable,
    reservedPaidYtd, reserveAccrued, reserveBalance, split, flipActive,
    scheduledIncluded, scheduledNet,
  }
}
