// lib/api/schema.ts
// Everything a bot needs before writing its own SQL: the live column list plus
// the house conventions that aren't visible in the schema itself. An LLM that
// reads these rules first writes correct P&L queries; one that doesn't will
// count security deposits as income and forecasts as cash.
import sql from '@/lib/db'

export const CONVENTIONS = [
  'transactions.amount is ALWAYS positive. Direction is transactions.type: income or expense. Net = SUM(CASE WHEN type=\'income\' THEN amount ELSE -amount END).',
  'Reported P&L uses status = \'actual\' only. status = \'forecast\' rows are scheduled/projected items, not cash.',
  'Security deposits are NOT income: every P&L aggregation must include COALESCE(is_deposit, FALSE) = FALSE. Deposit collections are income + is_deposit; returns are expense + is_deposit.',
  'Property books: transactions.property_id is set. Entity books (SLCM, holding cos): property_id IS NULL and entity_id is set. Don\'t add the two together or management fees count twice.',
  'rental_period (YYYY-MM) is the month a rent payment covers; txn_date is when cash moved. They can differ.',
  'Distributable / retained cash uses ALL-IN net (all expenses including Property Taxes and Insurance), never operating NOI.',
  'Property Taxes and Insurance are the reserved categories that fund the runway hold-back.',
  'period_closes rows soft-lock a property\'s date range. Bots cannot write into a closed range.',
  'DECIMAL columns: cast with ::float8 when you want numbers rather than strings.',
  'Ownership percentages live in property_owners.ownership_pct and can change across years; capital accounts are per-year (see get_capital_accounts).',
  'mutations_log records every bot write with before/after JSON.',
]

const HIDDEN_TABLES = new Set(['api_keys'])

export async function describeSchema() {
  const cols = (await sql`
    SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position
  `) as { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]

  const counts = (await sql`
    SELECT relname AS table_name, GREATEST(n_live_tup, 0)::int AS approx_rows
    FROM pg_stat_user_tables WHERE schemaname = 'public'
  `) as { table_name: string; approx_rows: number }[]
  const countOf = new Map(counts.map((c) => [c.table_name, c.approx_rows]))

  const tables: Record<string, { approx_rows: number | null; columns: { name: string; type: string; nullable: boolean }[] }> = {}
  for (const c of cols) {
    if (HIDDEN_TABLES.has(c.table_name)) continue
    const t = (tables[c.table_name] ||= { approx_rows: countOf.get(c.table_name) ?? null, columns: [] })
    t.columns.push({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES' })
  }
  return { conventions: CONVENTIONS, tables }
}
