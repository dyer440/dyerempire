// lib/api/periods.ts
// Quarter-end actions for bots (the website no longer has its own close screen),
// with these rules:
//
// record_distribution
//   • $0 can always be recorded (the "nothing paid this quarter" record).
//   • A POSITIVE amount moves real cash, so it needs confirm_payout: true (the
//     owner said this exact amount in this conversation) AND it passes the same
//     lifetime over-distribution guard as the app; exceeding lifetime retained
//     cash additionally needs allow_over: true.
//   • Split by the quarter engine's owner percentages, rounded to cents with any
//     rounding cent on the largest owner so the rows sum exactly.
//   • Refused once the quarter is closed (record, then close).
//
// close_period
//   • Same lock as the app, but UNPAID RENT forecasts in the quarter are kept as
//     the arrears record (the app deletes all forecasts). They don't affect any
//     reported figure (P&L and past-quarter engines count actuals only) and they
//     keep late_rent accurate. Other forecasts in the quarter are removed.
//
// Every action is logged in mutations_log.
import sql from '@/lib/db'
import { computeQuarter, quarterBounds, lifetimeRetained } from '@/lib/distributions'
import { badRequest, conflict, notFound } from './errors'
import { type Actor, refreshUi } from './service'
import { type Input, reqInt, optBool, optString } from './validate'

type Row = Record<string, unknown>

function reqPeriod(input: Input): string {
  const p = optString(input, 'period', 7)
  if (!p || !/^\d{4}-Q[1-4]$/.test(p)) throw badRequest('period is required, e.g. 2026-Q3.')
  return p
}

async function reqProperty(id: number) {
  const p = (await sql`SELECT id, name FROM properties WHERE id = ${id}`) as { id: number; name: string }[]
  if (!p[0]) throw notFound(`Property ${id} not found.`)
  return p[0]
}

async function isClosed(propertyId: number, label: string) {
  const r = (await sql`SELECT 1 FROM period_closes WHERE property_id = ${propertyId} AND label = ${label}`) as Row[]
  return r.length > 0
}

const cents = (n: number) => Math.round(n * 100)

export async function recordDistribution(input: Input, who: Actor) {
  const propertyId = reqInt(input, 'property_id')
  const period = reqPeriod(input)
  const prop = await reqProperty(propertyId)
  const raw = input.amount
  const total = Number(typeof raw === 'string' ? raw.replace(/[$,\s]/g, '') : raw)
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(total) || total < 0) {
    throw badRequest('amount is required: 0 or a positive dollar amount for the whole property.')
  }
  if (await isClosed(propertyId, period)) {
    throw conflict('period_closed', `${period} is closed for ${prop.name}. Reopen it before changing its distribution.`)
  }

  const c = await computeQuarter(propertyId, period)
  if (!c.split.length) throw badRequest(`${prop.name} has no owners on record, so there is nothing to split.`)

  const prior = (await sql`
    SELECT COALESCE(SUM(amount), 0)::float8 AS total FROM distributions WHERE property_id = ${propertyId} AND period = ${period}
  `) as { total: number }[]
  const { retained } = await lifetimeRetained(propertyId)
  const available = Math.round((retained + (prior[0]?.total || 0)) * 100) / 100

  if (total > 0) {
    if (optBool(input, 'confirm_payout') !== true) {
      throw conflict('needs_confirmation',
        `A positive distribution of $${total.toFixed(2)} moves real cash. Confirm the exact amount with the owner, then resend with confirm_payout: true.`,
        { engine_runway_distributable: c.runwayDistributable, lifetime_retained_available: available })
    }
    if (total > available + 0.005 && optBool(input, 'allow_over') !== true) {
      throw conflict('over_distribution',
        `$${total.toFixed(2)} exceeds ${prop.name}'s lifetime retained cash ($${available.toFixed(2)}); it would return partner capital. Resend with allow_over: true only if that is intended.`,
        { lifetime_retained_available: available })
    }
  }

  // Exact-cent split, remainder on the largest owner.
  const totalC = cents(total)
  const parts = c.split.map((s) => ({ owner_id: s.owner_id, name: s.name, pct: s.pct, c: Math.floor((totalC * s.pct) / 100) }))
  const diff = totalC - parts.reduce((t, p) => t + p.c, 0)
  if (diff) parts.sort((a, b) => b.pct - a.pct)[0].c += diff

  const before = (await sql`
    SELECT owner_id, amount::float8 AS amount, status FROM distributions WHERE property_id = ${propertyId} AND period = ${period}
  `) as Row[]
  await sql.transaction((tx) => [
    tx`DELETE FROM distributions WHERE property_id = ${propertyId} AND period = ${period}`,
    ...parts.map((p) => tx`
      INSERT INTO distributions (period, property_id, owner_id, amount, status)
      VALUES (${period}, ${propertyId}, ${p.owner_id}, ${p.c / 100}, 'recorded')
    `),
    tx`
      INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after, note)
      VALUES (${who.actor}, ${who.keyId}, ${who.source}, 'distribution.record', 'properties', ${propertyId},
              ${JSON.stringify(before)}::jsonb,
              ${JSON.stringify({ period, total, split: parts.map((p) => ({ owner: p.name, pct: p.pct, amount: p.c / 100 })) })}::jsonb,
              ${period})
    `,
  ])
  refreshUi()
  return {
    property: prop.name, period, total,
    split: parts.map((p) => ({ owner: p.name, pct: p.pct, amount: p.c / 100 })),
    engine: { runway_distributable: c.runwayDistributable, retained_ytd: c.retainedCash, lifetime_retained_available: available },
  }
}

export async function closePeriod(input: Input, who: Actor) {
  const propertyId = reqInt(input, 'property_id')
  const period = reqPeriod(input)
  const prop = await reqProperty(propertyId)
  if (await isClosed(propertyId, period)) throw conflict('already_closed', `${period} is already closed for ${prop.name}.`)
  const { start, end } = quarterBounds(period)
  if (end >= new Date().toISOString().slice(0, 10)) throw badRequest(`${period} hasn't ended yet.`)

  const kept = (await sql`
    SELECT t.id, to_char(t.txn_date, 'YYYY-MM-DD') AS due, t.amount::float8 AS amount, u.label AS unit
    FROM transactions t LEFT JOIN units u ON u.id = t.unit_id
    WHERE t.property_id = ${propertyId} AND t.status = 'forecast' AND t.type = 'income'
      AND t.category ILIKE '%rent%' AND t.txn_date BETWEEN ${start}::date AND ${end}::date
    ORDER BY t.txn_date
  `) as Row[]
  const removed = (await sql`
    WITH del AS (
      DELETE FROM transactions
      WHERE property_id = ${propertyId} AND status = 'forecast'
        AND txn_date BETWEEN ${start}::date AND ${end}::date
        AND NOT (type = 'income' AND category ILIKE '%rent%')
      RETURNING id, category, amount
    ), ins AS (
      INSERT INTO period_closes (property_id, period_start, period_end, label, closed_by)
      VALUES (${propertyId}, ${start}::date, ${end}::date, ${period}, ${who.actor})
      RETURNING id
    ), log AS (
      INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after, note)
      SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'period.close', 'properties', ${propertyId},
             jsonb_build_object('period', ${period}::text,
                                'removed_forecasts', COALESCE((SELECT jsonb_agg(to_jsonb(del)) FROM del), '[]'::jsonb),
                                'kept_unpaid_rent', ${JSON.stringify(kept)}::jsonb),
             ${period}
      FROM ins
    )
    SELECT id, category, amount::float8 AS amount FROM del
  `) as Row[]
  refreshUi()
  const dist = (await sql`
    SELECT COALESCE(SUM(amount), 0)::float8 AS total, COUNT(*)::int AS n FROM distributions WHERE property_id = ${propertyId} AND period = ${period}
  `) as { total: number; n: number }[]
  return {
    property: prop.name, period, closed: true,
    removed_forecasts: removed,
    kept_unpaid_rent: kept,
    distribution_recorded: dist[0]?.n ? dist[0].total : null,
  }
}

export async function reopenPeriod(input: Input, who: Actor) {
  const propertyId = reqInt(input, 'property_id')
  const period = reqPeriod(input)
  const prop = await reqProperty(propertyId)
  const del = (await sql`
    WITH d AS (DELETE FROM period_closes WHERE property_id = ${propertyId} AND label = ${period} RETURNING *)
    INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, note)
    SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'period.reopen', 'properties', ${propertyId}, to_jsonb(d), ${period} FROM d
    RETURNING id
  `) as Row[]
  if (!del.length) throw conflict('not_closed', `${period} is not closed for ${prop.name}.`)
  refreshUi()
  return { property: prop.name, period, closed: false, note: 'Forecasts removed at close are not restored. Recreate them with update_schedule if needed.' }
}
