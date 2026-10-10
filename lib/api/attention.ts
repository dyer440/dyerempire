// lib/api/attention.ts
// The maintenance checklist a daily/weekly bot runs. One call returns
// everything that needs a human (or a bot write) right now:
//   overdue_forecasts           scheduled items past their date, never confirmed
//   pending_bank                bank rows imported but not yet posted
//   rent_gaps                   recent months with no rent at a property that normally collects it
//   possible_duplicates         same amount + type booked twice within 10 days (unreviewed)
//   upcoming_reserve_bills      tax/insurance due in the next 60 days
//   unclosed_quarters           co-owned properties whose last quarter isn't closed
//   schedules_without_forecasts active schedules with nothing in the future (needs regenerate)
// Each section degrades to an error note rather than failing the whole call.
import sql from '@/lib/db'

// SQL rows are dynamic by nature; columns are typed at the point of use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

async function section<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn() } catch (e) { return { error: (e as Error).message } }
}

const count = (v: unknown) => (Array.isArray(v) ? v.length : 0)

function lastCompletedQuarter(today = new Date()) {
  const y = today.getUTCFullYear()
  const q = Math.floor(today.getUTCMonth() / 3) + 1 // current quarter
  return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`
}

export async function getAttention() {
  const overdue = await section(async () => (await sql`
    SELECT t.id, COALESCE(p.name, e.name) AS books, t.property_id, t.entity_id,
           t.type, t.category, t.amount::float8 AS amount,
           to_char(t.txn_date, 'YYYY-MM-DD') AS due, (CURRENT_DATE - t.txn_date) AS days_overdue,
           t.description, t.schedule_id
    FROM transactions t
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN entities e ON e.id = t.entity_id AND t.property_id IS NULL
    WHERE t.status = 'forecast' AND t.txn_date < CURRENT_DATE
    ORDER BY t.txn_date, t.id
    LIMIT 100
  `) as Row[])

  const pendingBank = await section(async () => {
    const rows = (await sql`
      SELECT COUNT(*)::int AS count,
             to_char(MIN(txn_date), 'YYYY-MM-DD') AS oldest,
             COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0)::float8 AS credits,
             COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0)::float8 AS debits
      FROM bank_txns WHERE status = 'pending'
    `) as Row[]
    return rows[0]
  })

  const rentGaps = await section(async () => (await sql`
    WITH months AS (
      SELECT to_char(m, 'YYYY-MM') AS ym
      FROM generate_series(date_trunc('month', CURRENT_DATE) - INTERVAL '3 months',
                           date_trunc('month', CURRENT_DATE) - INTERVAL '1 month',
                           INTERVAL '1 month') AS m
    ),
    rent AS (
      SELECT t.property_id, to_char(t.txn_date, 'YYYY-MM') AS paid_ym, t.rental_period, t.txn_date
      FROM transactions t
      WHERE t.status = 'actual' AND t.type = 'income' AND t.category ILIKE '%rent%'
        AND COALESCE(is_deposit, FALSE) = FALSE
        AND t.txn_date >= CURRENT_DATE - INTERVAL '15 months'
    ),
    renters AS (
      SELECT DISTINCT p.id, p.name
      FROM properties p JOIN rent r ON r.property_id = p.id
      WHERE COALESCE(p.status, 'active') = 'active'
        AND r.txn_date >= CURRENT_DATE - INTERVAL '12 months'
    )
    SELECT r.id AS property_id, r.name AS property, m.ym AS month
    FROM renters r CROSS JOIN months m
    WHERE NOT EXISTS (
      SELECT 1 FROM rent x
      WHERE x.property_id = r.id AND (x.paid_ym = m.ym OR x.rental_period = m.ym)
    )
    ORDER BY r.name, m.ym
  `) as Row[])

  const dupes = await section(async () => (await sql`
    SELECT a.id AS id_a, b.id AS id_b, p.name AS property, a.type, a.category,
           a.amount::float8 AS amount,
           to_char(a.txn_date, 'YYYY-MM-DD') AS date_a, to_char(b.txn_date, 'YYYY-MM-DD') AS date_b,
           a.description AS desc_a, b.description AS desc_b
    FROM transactions a
    JOIN transactions b
      ON b.property_id = a.property_id AND b.id > a.id
     AND b.amount = a.amount AND b.type = a.type
     AND ABS(b.txn_date - a.txn_date) <= 10
    JOIN properties p ON p.id = a.property_id
    WHERE a.status = 'actual' AND b.status = 'actual'
      AND a.txn_date >= CURRENT_DATE - 120
      AND COALESCE(a.is_deposit, FALSE) = FALSE AND COALESCE(b.is_deposit, FALSE) = FALSE
      AND NOT EXISTS (
        SELECT 1 FROM reviewed_pairs rp
        WHERE rp.txn_id_a = LEAST(a.id, b.id) AND rp.txn_id_b = GREATEST(a.id, b.id)
      )
    ORDER BY a.txn_date DESC
    LIMIT 50
  `) as Row[])

  const reserveBills = await section(async () => (await sql`
    SELECT t.id, p.name AS property, t.category, t.amount::float8 AS amount,
           to_char(t.txn_date, 'YYYY-MM-DD') AS due
    FROM transactions t JOIN properties p ON p.id = t.property_id
    WHERE t.status = 'forecast'
      AND t.category IN ('Property Taxes', 'Insurance')
      AND t.txn_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60
    ORDER BY t.txn_date, p.name
  `) as Row[])

  const quarter = lastCompletedQuarter()
  const unclosed = await section(async () => (await sql`
    SELECT p.id AS property_id, p.name AS property, ${quarter}::text AS period
    FROM properties p
    WHERE COALESCE(p.status, 'active') = 'active'
      AND (SELECT COUNT(*) FROM property_owners po WHERE po.property_id = p.id) > 1
      AND NOT EXISTS (SELECT 1 FROM period_closes pc WHERE pc.property_id = p.id AND pc.label = ${quarter})
    ORDER BY p.name
  `) as Row[])

  const stale = await section(async () => (await sql`
    SELECT s.id AS schedule_id, s.property_id, s.entity_id,
           COALESCE(p.name, e.name) AS books, s.category, s.amount::float8 AS amount, s.frequency
    FROM recurring_schedules s
    LEFT JOIN properties p ON p.id = s.property_id
    LEFT JOIN entities e ON e.id = s.entity_id AND s.property_id IS NULL
    WHERE s.status = 'active'
      AND (s.end_date IS NULL OR s.end_date > CURRENT_DATE)
      AND NOT EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.schedule_id = s.id AND t.txn_date >= CURRENT_DATE
      )
    ORDER BY books, s.category
  `) as Row[])

  const pendingCount =
    pendingBank && typeof pendingBank === 'object' && 'count' in pendingBank ? Number(pendingBank.count) : 0

  return {
    as_of: new Date().toISOString().slice(0, 10),
    summary: {
      overdue_forecasts: count(overdue),
      pending_bank_rows: pendingCount,
      rent_gaps: count(rentGaps),
      possible_duplicates: count(dupes),
      upcoming_reserve_bills: count(reserveBills),
      unclosed_quarters: count(unclosed),
      schedules_without_forecasts: count(stale),
    },
    overdue_forecasts: overdue,
    pending_bank: pendingBank,
    rent_gaps: rentGaps,
    possible_duplicates: dupes,
    upcoming_reserve_bills: reserveBills,
    unclosed_quarters: { period: quarter, properties: unclosed },
    schedules_without_forecasts: stale,
    hints: {
      overdue_forecasts: 'confirm_forecast if it was paid (check the bank), delete_forecast if it will not happen.',
      schedules_without_forecasts: 'regenerate_forecasts for that property_id / entity_id.',
      possible_duplicates: 'A person reviews these in /real-estate/close. Bots should report, not delete.',
      rent_gaps: 'Property-level only. Multi-unit properties (Southside) can show a month as paid while one unit is short.',
    },
  }
}
