// lib/recurring.ts  (NEW — forecast generator for recurring schedules)
import sql from './db'

export type Frequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual'

export const FREQUENCIES: Frequency[] = ['monthly', 'quarterly', 'semiannual', 'annual']

// Default month sets per frequency when months_csv is blank.
const DEFAULT_MONTHS: Record<Frequency, number[]> = {
  monthly: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  quarterly: [1, 4, 7, 10],
  semiannual: [3, 9],
  annual: [1],
}

// How far ahead to project forecasts.
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
    return s.months_csv
      .split(',')
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => n >= 1 && n <= 12)
  }
  return DEFAULT_MONTHS[s.frequency] || []
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Regenerate forward forecast transactions for a property.
 * - Deletes existing forecast rows dated on/after the first of the current month
 *   (idempotent regeneration). NEVER touches status='actual' rows.
 * - Re-creates forecasts for every active schedule across the horizon.
 */
export async function generateForecasts(propertyId: number): Promise<number> {
  await sql`
    DELETE FROM transactions
    WHERE property_id = ${propertyId}
      AND status = 'forecast'
      AND txn_date >= date_trunc('month', CURRENT_DATE)
  `

  const schedules = (await sql`
    SELECT * FROM recurring_schedules
    WHERE property_id = ${propertyId} AND status = 'active'
  `) as ScheduleRow[]

  const today = new Date()
  const startYear = today.getFullYear()
  const startMonthIdx = today.getMonth() // 0-indexed
  const firstOfMonth = `${startYear}-${pad(startMonthIdx + 1)}-01`

  let created = 0

  for (const s of schedules) {
    const months = monthsFor(s)
    if (months.length === 0) continue
    const day = Math.min(s.day_of_month || 15, 28)
    const amount = parseFloat(s.amount)

    for (let i = 0; i < HORIZON_MONTHS; i++) {
      const y = startYear + Math.floor((startMonthIdx + i) / 12)
      const m = ((startMonthIdx + i) % 12) + 1 // 1-indexed
      if (!months.includes(m)) continue

      const dateStr = `${y}-${pad(m)}-${pad(day)}`
      if (dateStr < firstOfMonth) continue
      if (s.start_date && dateStr < s.start_date) continue
      if (s.end_date && dateStr > s.end_date) continue

      await sql`
        INSERT INTO transactions
          (property_id, unit_id, type, category, amount, txn_date, description, method, created_by, status)
        VALUES (${propertyId}, ${s.unit_id}, ${s.type}, ${s.category}, ${amount}, ${dateStr},
                ${s.description}, ${'scheduled'}, ${'schedule:' + s.id}, ${'forecast'})
      `
      created++
    }
  }

  return created
}
