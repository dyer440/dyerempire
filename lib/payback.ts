// lib/payback.ts  (NEW — capital payback tracking + the 50/50 distribution flip)
import sql from './db'

export type PaybackStatus = {
  flipEnabled: boolean
  contributed: number
  distributed: number
  remaining: number
  reached: boolean
  reachedPeriod: string | null
  pctReturned: number
  owners: { owner_id: number; name: string; contributed: number; distributed: number; remaining: number }[]
}

async function contributedTotal(propertyId: number): Promise<number> {
  const r = (await sql`SELECT COALESCE(SUM(amount), 0)::float8 AS t FROM capital_contributions WHERE property_id = ${propertyId}`) as { t: number }[]
  return r[0]?.t || 0
}

export async function computePayback(propertyId: number): Promise<PaybackStatus> {
  const flipRow = (await sql`SELECT COALESCE(payback_flip, false) AS f FROM properties WHERE id = ${propertyId}`) as { f: boolean }[]
  const flipEnabled = flipRow[0]?.f ?? false

  const contributed = await contributedTotal(propertyId)
  const dRow = (await sql`SELECT COALESCE(SUM(amount), 0)::float8 AS t FROM distributions WHERE property_id = ${propertyId}`) as { t: number }[]
  const distributed = dRow[0]?.t || 0

  const reached = contributed > 0 && distributed >= contributed
  const remaining = Math.max(contributed - distributed, 0)
  const pctReturned = contributed > 0 ? Math.min((distributed / contributed) * 100, 100) : 0

  // Period the cumulative distributions first crossed the threshold (periods sort lexically)
  let reachedPeriod: string | null = null
  if (contributed > 0) {
    const seq = (await sql`
      SELECT period, COALESCE(SUM(amount), 0)::float8 AS total
      FROM distributions WHERE property_id = ${propertyId}
      GROUP BY period ORDER BY period
    `) as { period: string; total: number }[]
    let run = 0
    for (const r of seq) { run += r.total; if (run >= contributed) { reachedPeriod = r.period; break } }
  }

  // Per-owner contributed vs distributed
  const oc = (await sql`
    SELECT o.id AS owner_id, o.name, COALESCE(SUM(cc.amount), 0)::float8 AS c
    FROM owners o
    JOIN property_owners po ON po.owner_id = o.id AND po.property_id = ${propertyId}
    LEFT JOIN capital_contributions cc ON cc.owner_id = o.id AND cc.property_id = ${propertyId}
    GROUP BY o.id, o.name
  `) as { owner_id: number; name: string; c: number }[]
  const od = (await sql`
    SELECT owner_id, COALESCE(SUM(amount), 0)::float8 AS d
    FROM distributions WHERE property_id = ${propertyId} GROUP BY owner_id
  `) as { owner_id: number; d: number }[]
  const dmap: Record<number, number> = {}
  for (const r of od) dmap[r.owner_id] = r.d

  const owners = oc.map((o) => {
    const dist = dmap[o.owner_id] || 0
    return { owner_id: o.owner_id, name: o.name, contributed: o.c, distributed: dist, remaining: Math.max(o.c - dist, 0) }
  })

  return { flipEnabled, contributed, distributed, remaining, reached, reachedPeriod, pctReturned, owners }
}

// Is the 50/50 flip active for distributions in `period`?
// True only if the property is flip-enabled AND cumulative distributions in periods
// strictly BEFORE this one already returned the full contributed capital.
export async function flipActiveForPeriod(propertyId: number, period: string): Promise<boolean> {
  const flipRow = (await sql`SELECT COALESCE(payback_flip, false) AS f FROM properties WHERE id = ${propertyId}`) as { f: boolean }[]
  if (!flipRow[0]?.f) return false
  const contributed = await contributedTotal(propertyId)
  if (contributed <= 0) return false
  const r = (await sql`
    SELECT COALESCE(SUM(amount), 0)::float8 AS t
    FROM distributions WHERE property_id = ${propertyId} AND period < ${period}
  `) as { t: number }[]
  return (r[0]?.t || 0) >= contributed
}
