// lib/api/schedules.ts
// Recurring schedules for bots: list, create, edit, pause. Every change is
// logged and then RESYNCS ONLY THAT SCHEDULE'S future forecasts:
//   • its forecasts from the start of the current month forward are removed
//     (never actuals, never anything inside a closed period)
//   • if the schedule is active, the next 12 months are re-created using the
//     same rules as lib/recurring.ts (months_csv or frequency defaults, day
//     capped at 28, start/end dates, closed periods and months already
//     confirmed for this schedule are skipped)
// Resyncing one schedule, not the whole property, means editing a fee schedule
// can't disturb unrelated forecasts that were hand-adjusted.
import sql from '@/lib/db'
import { badRequest, notFound } from './errors'
import { type Actor, resolveCategory, refreshUi } from './service'
import {
  type Input, optInt, reqInt, optString, reqAmount, optEnum, optDate,
} from './validate'

type Row = Record<string, unknown>

const FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual'] as const
type Frequency = (typeof FREQUENCIES)[number]
const DEFAULT_MONTHS: Record<Frequency, number[]> = {
  monthly: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  quarterly: [1, 4, 7, 10],
  semiannual: [3, 9],
  annual: [1],
}
const HORIZON_MONTHS = 12
const pad = (n: number) => String(n).padStart(2, '0')

function parseMonths(csv: string | null): number[] | null {
  if (!csv || !csv.trim()) return null
  const ms = csv.split(',').map((x) => Number(x.trim()))
  if (ms.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) throw badRequest('months_csv must be month numbers 1-12, e.g. "1,4,7,10".')
  return [...new Set(ms)].sort((a, b) => a - b)
}

type Sched = {
  id: number; property_id: number | null; entity_id: number | null; unit_id: number | null
  type: string; category: string; description: string | null; amount: number
  frequency: Frequency; months_csv: string | null; day_of_month: number | null
  start_date: string | null; end_date: string | null; status: string
}

async function loadSchedule(id: number): Promise<Sched> {
  const rows = (await sql`
    SELECT id, property_id, entity_id, unit_id, type, category, description, amount::float8 AS amount,
           frequency, months_csv, day_of_month,
           to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date, status
    FROM recurring_schedules WHERE id = ${id}
  `) as Sched[]
  if (!rows[0]) throw notFound(`Schedule ${id} not found.`)
  return rows[0]
}

/** Remove this schedule's future forecasts and, if active, re-create 12 months. */
async function resync(s: Sched): Promise<{ removed: number; created: number }> {
  const removed = (await sql`
    DELETE FROM transactions t
    WHERE t.schedule_id = ${s.id} AND t.status = 'forecast'
      AND t.txn_date >= date_trunc('month', CURRENT_DATE)
      AND NOT EXISTS (
        SELECT 1 FROM period_closes pc
        WHERE pc.property_id = t.property_id AND t.txn_date BETWEEN pc.period_start AND pc.period_end)
    RETURNING t.id
  `) as Row[]
  if (s.status !== 'active') return { removed: removed.length, created: 0 }

  const closes = s.property_id
    ? ((await sql`
        SELECT to_char(period_start, 'YYYY-MM-DD') AS ps, to_char(period_end, 'YYYY-MM-DD') AS pe
        FROM period_closes WHERE property_id = ${s.property_id}
      `) as { ps: string; pe: string }[])
    : []
  const taken = (await sql`
    SELECT DISTINCT to_char(txn_date, 'YYYY-MM') AS ym FROM transactions
    WHERE schedule_id = ${s.id} AND (status = 'actual' OR txn_date < date_trunc('month', CURRENT_DATE)
          OR EXISTS (SELECT 1 FROM period_closes pc WHERE pc.property_id = transactions.property_id
                     AND transactions.txn_date BETWEEN pc.period_start AND pc.period_end))
  `) as { ym: string }[]
  const takenSet = new Set(taken.map((t) => t.ym))
  const months = parseMonths(s.months_csv) ?? DEFAULT_MONTHS[s.frequency] ?? []
  const day = Math.min(s.day_of_month || 15, 28)
  const now = new Date()
  const y0 = now.getUTCFullYear(), m0 = now.getUTCMonth()

  let created = 0
  for (let i = 0; i < HORIZON_MONTHS; i++) {
    const y = y0 + Math.floor((m0 + i) / 12)
    const m = ((m0 + i) % 12) + 1
    if (!months.includes(m)) continue
    const d = `${y}-${pad(m)}-${pad(day)}`
    if (s.start_date && d < s.start_date) continue
    if (s.end_date && d > s.end_date) continue
    if (closes.some((c) => d >= c.ps && d <= c.pe)) continue
    if (takenSet.has(`${y}-${pad(m)}`)) continue
    await sql`
      INSERT INTO transactions
        (property_id, entity_id, unit_id, type, category, amount, txn_date, description, method, created_by, status, schedule_id)
      VALUES (${s.property_id}, ${s.entity_id}, ${s.unit_id}, ${s.type}, ${s.category}, ${s.amount}, ${d}::date,
              ${s.description}, 'scheduled', ${'schedule:' + s.id}, 'forecast', ${s.id})
    `
    created++
  }
  return { removed: removed.length, created }
}

export async function listSchedules(input: Input) {
  const propertyId = optInt(input, 'property_id')
  const entityId = optInt(input, 'entity_id')
  const status = optEnum(input, 'status', ['active', 'paused', 'all'] as const) ?? 'all'
  return (await sql`
    SELECT s.id, s.property_id, s.entity_id, COALESCE(p.name, e.name) AS books, s.unit_id, u.label AS unit,
           s.type, s.category, s.description, s.amount::float8 AS amount, s.frequency, s.months_csv,
           s.day_of_month, to_char(s.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(s.end_date, 'YYYY-MM-DD') AS end_date, s.status,
           (SELECT to_char(MIN(t.txn_date), 'YYYY-MM-DD') FROM transactions t
             WHERE t.schedule_id = s.id AND t.status = 'forecast' AND t.txn_date >= CURRENT_DATE) AS next_due,
           (SELECT to_char(MAX(t.txn_date), 'YYYY-MM-DD') FROM transactions t
             WHERE t.schedule_id = s.id AND t.status = 'actual') AS last_confirmed,
           (SELECT COUNT(*)::int FROM transactions t
             WHERE t.schedule_id = s.id AND t.status = 'forecast' AND t.txn_date < CURRENT_DATE) AS overdue_count
    FROM recurring_schedules s
    LEFT JOIN properties p ON p.id = s.property_id
    LEFT JOIN entities e ON e.id = s.entity_id AND s.property_id IS NULL
    LEFT JOIN units u ON u.id = s.unit_id
    WHERE (${propertyId}::int IS NULL OR s.property_id = ${propertyId}::int)
      AND (${entityId}::int IS NULL OR (s.entity_id = ${entityId}::int AND s.property_id IS NULL))
      AND (${status}::text = 'all' OR s.status = ${status}::text)
    ORDER BY books, s.type DESC, s.category, s.id
  `) as Row[]
}

async function logChange(who: Actor, action: string, id: number, before: unknown, after: unknown) {
  await sql`
    INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after)
    VALUES (${who.actor}, ${who.keyId}, ${who.source}, ${action}, 'recurring_schedules', ${id},
            ${before === null ? null : JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)
  `
}

const EDITABLE = ['amount', 'day_of_month', 'frequency', 'months_csv', 'description', 'category', 'status', 'end_date', 'start_date', 'unit_id'] as const

export async function updateSchedule(input: Input, who: Actor) {
  const id = reqInt(input, 'id')
  const before = await loadSchedule(id)
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k)
  const unknown = Object.keys(input).filter((k) => k !== 'id' && !(EDITABLE as readonly string[]).includes(k))
  if (unknown.length) throw badRequest(`Can't change: ${unknown.join(', ')}. Editable: ${EDITABLE.join(', ')}.`)
  if (Object.keys(input).length <= 1) throw badRequest(`Nothing to change. Editable: ${EDITABLE.join(', ')}.`)

  const next: Sched = { ...before }
  if (has('amount')) next.amount = reqAmount(input, 'amount')
  if (has('day_of_month')) {
    const d = reqInt(input, 'day_of_month')
    if (d > 31) throw badRequest('day_of_month must be 1-31 (forecasts use at most the 28th).')
    next.day_of_month = d
  }
  if (has('frequency')) next.frequency = optEnum(input, 'frequency', FREQUENCIES) ?? before.frequency
  if (has('months_csv')) {
    const csv = optString(input, 'months_csv', 40)
    next.months_csv = csv ? parseMonths(csv)!.join(',') : null
  }
  if (has('description')) next.description = optString(input, 'description')
  if (has('category')) {
    const c = await resolveCategory(optString(input, 'category', 100) ?? '')
    if (c.kind !== before.type) throw badRequest(`This schedule is ${before.type}; "${c.name}" is ${c.kind}.`)
    next.category = c.name
  }
  if (has('status')) next.status = optEnum(input, 'status', ['active', 'paused'] as const) ?? before.status
  if (has('end_date')) next.end_date = optDate(input, 'end_date')
  if (has('start_date')) next.start_date = optDate(input, 'start_date')
  if (has('unit_id')) {
    next.unit_id = optInt(input, 'unit_id')
    if (next.unit_id) {
      if (!before.property_id) throw badRequest('unit_id only applies to property schedules.')
      const u = (await sql`SELECT 1 FROM units WHERE id = ${next.unit_id} AND property_id = ${before.property_id}`) as Row[]
      if (!u[0]) throw badRequest(`Unit ${next.unit_id} does not belong to property ${before.property_id}.`)
    }
  }

  await sql`
    UPDATE recurring_schedules SET
      amount = ${next.amount}, day_of_month = ${next.day_of_month}, frequency = ${next.frequency},
      months_csv = ${next.months_csv}, description = ${next.description}, category = ${next.category},
      status = ${next.status}, end_date = ${next.end_date}::date, start_date = ${next.start_date}::date,
      unit_id = ${next.unit_id}
    WHERE id = ${id}
  `
  const after = await loadSchedule(id)
  const sync = await resync(after)
  await logChange(who, 'schedule.update', id, before, { ...after, forecasts: sync })
  refreshUi()
  return { schedule: after, forecasts: sync }
}

export async function createSchedule(input: Input, who: Actor) {
  const propertyId = optInt(input, 'property_id')
  const entityId = optInt(input, 'entity_id')
  if (!!propertyId === !!entityId) throw badRequest('Send exactly one of property_id or entity_id.')
  const c = await resolveCategory(optString(input, 'category', 100) ?? '')
  const amount = reqAmount(input, 'amount')
  const frequency = optEnum(input, 'frequency', FREQUENCIES) ?? 'monthly'
  const monthsRaw = optString(input, 'months_csv', 40)
  const monthsCsv = monthsRaw ? parseMonths(monthsRaw)!.join(',') : null
  const day = optInt(input, 'day_of_month') ?? 15
  if (day > 31) throw badRequest('day_of_month must be 1-31.')
  const unitId = optInt(input, 'unit_id')
  const description = optString(input, 'description')
  const startDate = optDate(input, 'start_date')
  const endDate = optDate(input, 'end_date')

  let rowEntity: number | null = null
  if (propertyId) {
    const p = (await sql`SELECT 1 FROM properties WHERE id = ${propertyId}`) as Row[]
    if (!p[0]) throw notFound(`Property ${propertyId} not found.`)
    if (unitId) {
      const u = (await sql`SELECT 1 FROM units WHERE id = ${unitId} AND property_id = ${propertyId}`) as Row[]
      if (!u[0]) throw badRequest(`Unit ${unitId} does not belong to property ${propertyId}.`)
    }
  } else {
    if (unitId) throw badRequest('unit_id only applies to property schedules.')
    const e = (await sql`SELECT type FROM entities WHERE id = ${entityId}`) as Row[]
    if (!e[0]) throw notFound(`Entity ${entityId} not found.`)
    rowEntity = entityId
  }

  const ins = (await sql`
    INSERT INTO recurring_schedules
      (property_id, entity_id, unit_id, type, category, description, amount, is_estimate,
       frequency, months_csv, day_of_month, growth_pct, start_date, end_date, status)
    VALUES (${propertyId}, ${rowEntity}, ${unitId}, ${c.kind}, ${c.name}, ${description}, ${amount}, FALSE,
            ${frequency}, ${monthsCsv}, ${day}, 0, ${startDate}::date, ${endDate}::date, 'active')
    RETURNING id
  `) as { id: number }[]
  const s = await loadSchedule(ins[0].id)
  const sync = await resync(s)
  await logChange(who, 'schedule.create', s.id, null, { ...s, forecasts: sync })
  refreshUi()
  return { schedule: s, forecasts: sync }
}
