// lib/rent-period.ts
// Which month a rent payment is for, when nobody said.
//
// Tenants often pay a few days early, so two payments can land in one calendar
// month. The rent roll groups by rental_period, so new rent rows get one at write
// time. The rule: a payment made late in a month (on or after EARLY_DAY) counts
// toward next month if this month's rent is already collected in full. A late
// payment that finishes off an unpaid month stays in that month.
// The books (P&L, fees) still go by txn_date, so this only affects the rent roll.

import sql from '@/lib/db'

export const EARLY_DAY = 24

function nextYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

export async function inferRentPeriod(propertyId: number, unitId: number | null, txnDate: string, amount: number): Promise<string> {
  const ym = txnDate.slice(0, 7)
  if (Number(txnDate.slice(8, 10)) < EARLY_DAY) return ym

  const [row] = (await sql`
    SELECT
      (SELECT SUM(l.monthly_rent)::float8 FROM leases l
        WHERE l.property_id = ${propertyId} AND l.status = 'active'
          AND (${unitId}::int IS NULL OR l.unit_id = ${unitId}::int)) AS expected,
      (SELECT COALESCE(SUM(t.amount), 0)::float8 FROM transactions t
        WHERE t.property_id = ${propertyId} AND t.status = 'actual' AND t.type = 'income'
          AND t.category ILIKE '%rent%' AND COALESCE(t.is_deposit, FALSE) = FALSE
          AND (${unitId}::int IS NULL OR t.unit_id = ${unitId}::int)
          AND COALESCE(t.rental_period, to_char(t.txn_date, 'YYYY-MM')) = ${ym}) AS collected
  `) as { expected: number | null; collected: number }[]

  const expected = row?.expected && row.expected > 0 ? row.expected : amount
  return row && row.collected >= expected * 0.95 ? nextYm(ym) : ym
}
