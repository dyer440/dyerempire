// lib/recurring.ts  (UPDATED — generator skips closed periods AND any month that
//                    already has a CONFIRMED actual for the same schedule, so a
//                    confirmed item is never re-created as a duplicate forecast.)
import sql from './db'

export type Frequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual'

export const FREQUENCIES: Frequency[] = ['monthly', 'quarterly', 'semiannual', 'annual']

const DEFAULT_MONTHS: Record<Frequency, number[]> = {
  monthly: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  quarterly: [1, 4, 7, 10],
  semiannual: [3, 9],
  annual: [1],
}

const HORIZON_MONTHS = 12

type ScheduleRow = {
  id: number
  property_id: number
  unit_id: number | null
  type: string
  category: string
  description: string | null
  amount: string
  is_estimate: boolean
  frequency: Frequency
  months_csv: string | null
  day_of_month: number | null
  start_date: string | null
  end_date: string | null
  status: string
}

function monthsFor(s: ScheduleRow): number[] {
  if (s.months_csv && s.months_csv.trim()) {
    return s.months_csv.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n >= 1 && n <= 12)
  }
  return DEFAULT_MONTHS[s.frequency] || []
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Regenerate forward forecast transactions for a property.
 * - Deletes future forecasts EXCEPT those inside a closed period.
 * - Re-creates forecasts for every active schedule across the horizon, skipping
 *   any date in a closed period AND any month that already has a confirmed
 *   actual for that schedule (so confirming a scheduled item is permanent).
 * - Stamps schedule_id on each forecast so confirm-in-place keeps the linkage.
 * - NEVER touches status='actual' rows.
 */
export async function generateForecasts(propertyId: number): Promise<number> {
  // Wipe future forecasts, but leave closed periods alone.
  await sql`
    DELETE FROM transactions
    WHERE property_id = ${propertyId}
      AND status = 'forecast'
      AND txn_date >= date_trunc('month', CURRENT_DATE)
      AND NOT EXISTS (
        SELECT 1 FROM period_closes pc
        WHERE pc.property_id = ${propertyId}
          AND transactions.txn_date BETWEEN pc.period_start AND pc.period_end
      )
  `

  // Closed ranges (as YYYY-MM-DD strings for safe string comparison).
  const closes = (await sql`
    SELECT to_char(period_start, 'YYYY-MM-DD') AS ps, to_char(period_end, 'YYYY-MM-DD') AS pe
    FROM period_closes WHERE property_id = ${propertyId}
  `) as { ps: string; pe: string }[]
  const isClosed = (d: string) => closes.some((c) => d >= c.ps && d <= c.pe)

  // Months already settled as ACTUAL for a given schedule — never re-forecast these.
  const confirmed = (await sql`
    SELECT schedule_id, to_char(txn_date, 'YYYY-MM') AS ym
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'actual' AND schedule_id IS NOT NULL
  `) as { schedule_id: number; ym: string }[]
  const confirmedSet = new Set(confirmed.map((c) => `${c.schedule_id}:${c.ym}`))

  const schedules = (await sql`
    SELECT * FROM recurring_schedules
    WHERE property_id = ${propertyId} AND status = 'active'
  `) as ScheduleRow[]

  const today = new Date()
  const startYear = today.getFullYear()
  const startMonthIdx = today.getMonth()
  const firstOfMonth = `${startYear}-${pad(startMonthIdx + 1)}-01`

  let created = 0

  for (const s of schedules) {
    const months = monthsFor(s)
    if (months.length === 0) continue
    const day = Math.min(s.day_of_month || 15, 28)
    const amount = parseFloat(s.amount)

    for (let i = 0; i < HORIZON_MONTHS; i++) {
      const y = startYear + Math.floor((startMonthIdx + i) / 12)
      const m = ((startMonthIdx + i) % 12) + 1
      if (!months.includes(m)) continue

      const dateStr = `${y}-${pad(m)}-${pad(day)}`
      if (dateStr < firstOfMonth) continue
      if (s.start_date && dateStr < s.start_date) continue
      if (s.end_date && dateStr > s.end_date) continue
      if (isClosed(dateStr)) continue
      // Already confirmed this month for this schedule → don't re-create it.
      if (confirmedSet.has(`${s.id}:${y}-${pad(m)}`)) continue

      await sql`
        INSERT INTO transactions
          (property_id, unit_id, type, category, amount, txn_date, description, method, created_by, status, schedule_id)
        VALUES (${propertyId}, ${s.unit_id}, ${s.type}, ${s.category}, ${amount}, ${dateStr},
                ${s.description}, ${'scheduled'}, ${'schedule:' + s.id}, ${'forecast'}, ${s.id})
      `
      created++
    }
  }

  return created
}
