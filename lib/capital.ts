// lib/capital.ts  (v3 — per-year allocation ratio so mid-life contributions re-strike ownership)
// Net income for year Y is allocated by each owner's CUMULATIVE contribution ratio
// through the end of Y. For a property whose contributions all land in one year
// (e.g. 500 West) the ratio is constant; for one with later contributions (e.g. 1219)
// the split shifts the year the new capital goes in — matching the filed sheets.
import sql from './db'

export type OwnerYear = {
  beginning: number; contributions: number; netIncome: number; distributions: number; ending: number
}
export type CapitalRow = {
  owner_id: number; name: string; pct: number
  real: OwnerYear; paper: OwnerYear
}
export type CapitalYear = { year: number; rows: CapitalRow[]; ratioPct: Record<number, number> }
export type CapitalAccounts = {
  years: CapitalYear[]
  owners: { owner_id: number; name: string; pct: number }[]
}

export async function computeCapitalAccounts(propertyId: number): Promise<CapitalAccounts> {
  const owners = (await sql`
    SELECT o.id AS owner_id, o.name, po.ownership_pct
    FROM property_owners po JOIN owners o ON o.id = po.owner_id
    WHERE po.property_id = ${propertyId}
    ORDER BY po.ownership_pct DESC
  `) as { owner_id: number; name: string; ownership_pct: string }[]
  const ownerList = owners.map((o) => ({ owner_id: o.owner_id, name: o.name, pct: parseFloat(o.ownership_pct) }))

  const contribRows = (await sql`
    SELECT owner_id, EXTRACT(YEAR FROM contributed_on)::int AS yr, COALESCE(SUM(amount), 0)::float8 AS total
    FROM capital_contributions WHERE property_id = ${propertyId}
    GROUP BY owner_id, yr
  `) as { owner_id: number; yr: number; total: number }[]
  const contrib: Record<string, number> = {}
  for (const r of contribRows) contrib[`${r.owner_id}:${r.yr}`] = r.total

  const distRows = (await sql`
    SELECT owner_id, LEFT(period, 4) AS yr, COALESCE(SUM(amount), 0)::float8 AS total
    FROM distributions WHERE property_id = ${propertyId}
    GROUP BY owner_id, LEFT(period, 4)
  `) as { owner_id: number; yr: string; total: number }[]
  const dist: Record<string, number> = {}
  for (const r of distRows) dist[`${r.owner_id}:${r.yr}`] = r.total

  const depRows = (await sql`SELECT year, amount::float8 AS amt FROM depreciation_schedule WHERE property_id = ${propertyId}`) as
    { year: number; amt: number }[]
  const dep: Record<number, number> = {}
  for (const r of depRows) dep[r.year] = r.amt

  const ai = (await sql`SELECT year, real_net_income::float8 AS ni FROM annual_income WHERE property_id = ${propertyId}`) as
    { year: number; ni: number }[]
  const realNI: Record<number, number> = {}
  for (const r of ai) realNI[r.year] = r.ni
  const ledger = (await sql`
    SELECT EXTRACT(YEAR FROM txn_date)::int AS yr,
           COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0)::float8 AS net
    FROM transactions WHERE property_id = ${propertyId} AND status = 'actual'
    GROUP BY yr
  `) as { yr: number; net: number }[]
  for (const r of ledger) if (realNI[r.yr] === undefined) realNI[r.yr] = r.net

  const contribYears = contribRows.map((r) => r.yr)
  const earliest = contribYears.length ? Math.min(...contribYears) : new Date().getFullYear()
  const current = new Date().getFullYear()

  const prevReal: Record<number, number> = {}
  const prevPaper: Record<number, number> = {}
  const cumContrib: Record<number, number> = {} // running cumulative contributions per owner
  const years: CapitalYear[] = []

  for (let y = earliest; y <= current; y++) {
    // Roll cumulative contributions forward to include this year's
    for (const o of ownerList) cumContrib[o.owner_id] = (cumContrib[o.owner_id] || 0) + (contrib[`${o.owner_id}:${y}`] || 0)
    const totalCum = ownerList.reduce((s, o) => s + (cumContrib[o.owner_id] || 0), 0)
    const fracFor = (o: { owner_id: number; pct: number }) =>
      totalCum > 0 ? (cumContrib[o.owner_id] || 0) / totalCum : o.pct / 100

    const rNI = realNI[y] || 0
    const pNI = rNI - (dep[y] || 0)
    const ratioPct: Record<number, number> = {}

    const rows: CapitalRow[] = ownerList.map((o) => {
      const f = fracFor(o)
      ratioPct[o.owner_id] = f * 100
      const c = contrib[`${o.owner_id}:${y}`] || 0
      const d = dist[`${o.owner_id}:${y}`] || 0
      const rBeg = prevReal[o.owner_id] || 0
      const pBeg = prevPaper[o.owner_id] || 0
      const rEnd = rBeg + c + rNI * f - d
      const pEnd = pBeg + c + pNI * f - d
      prevReal[o.owner_id] = rEnd
      prevPaper[o.owner_id] = pEnd
      return {
        owner_id: o.owner_id, name: o.name, pct: o.pct,
        real: { beginning: rBeg, contributions: c, netIncome: rNI * f, distributions: d, ending: rEnd },
        paper: { beginning: pBeg, contributions: c, netIncome: pNI * f, distributions: d, ending: pEnd },
      }
    })
    years.push({ year: y, rows, ratioPct })
  }

  return { years, owners: ownerList }
}
