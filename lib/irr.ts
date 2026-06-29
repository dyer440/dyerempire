// lib/irr.ts  (NEW — XIRR + projected payback over the dated contribution/distribution stream)
import sql from './db'

export type ReturnsResult = {
  contributed: number
  distributedToDate: number
  pctReturned: number
  irr: number | null
  paybackDate: string | null
  alreadyPaidBack: boolean
  forecastQuarterly: number
  horizonYears: number
}

type Flow = { d: Date; cf: number }

function xirr(flows: Flow[]): number | null {
  if (flows.length < 2) return null
  const sorted = [...flows].sort((a, b) => a.d.getTime() - b.d.getTime())
  const d0 = sorted[0].d.getTime()
  const yearsFrom = (t: number) => (t - d0) / (365 * 24 * 3600 * 1000)
  const xnpv = (r: number) => sorted.reduce((s, f) => s + f.cf / Math.pow(1 + r, yearsFrom(f.d.getTime())), 0)
  let lo = -0.9999, hi = 2
  if (xnpv(lo) * xnpv(hi) > 0) return null // no sign change → undefined
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (xnpv(mid) > 0) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function quarterEndUTC(y: number, q: number): Date {
  return new Date(Date.UTC(y, q * 3, 0)) // day 0 of month after quarter = last day of quarter
}
function periodToDate(period: string): Date {
  const [ys, qs] = period.split('-Q')
  return quarterEndUTC(Number(ys), Number(qs))
}

export async function computeReturns(
  propertyId: number,
  forecastQuarterly: number,
  horizonYears: number,
): Promise<ReturnsResult> {
  const cons = (await sql`
    SELECT to_char(contributed_on, 'YYYY-MM-DD') AS d, amount::float8 AS a
    FROM capital_contributions WHERE property_id = ${propertyId} ORDER BY contributed_on
  `) as { d: string; a: number }[]
  const contributed = cons.reduce((s, c) => s + c.a, 0)

  const dist = (await sql`
    SELECT to_char(distributed_on, 'YYYY-MM-DD') AS dd, period, amount::float8 AS a
    FROM distributions WHERE property_id = ${propertyId}
  `) as { dd: string | null; period: string; a: number }[]

  const flows: Flow[] = []
  for (const c of cons) flows.push({ d: new Date(c.d + 'T00:00:00Z'), cf: -c.a })
  let distributedToDate = 0
  for (const r of dist) {
    const dateStr = r.dd || periodToDate(r.period).toISOString().slice(0, 10)
    flows.push({ d: new Date(dateStr + 'T00:00:00Z'), cf: r.a })
    distributedToDate += r.a
  }

  // Forecast: future quarters (strictly after today) at the assumed amount, through the horizon
  const now = new Date()
  let y = now.getUTCFullYear()
  let q = Math.floor(now.getUTCMonth() / 3) + 1
  const advance = () => { q++; if (q > 4) { q = 1; y++ } }
  while (quarterEndUTC(y, q) <= now) advance()
  const forecast: Flow[] = []
  for (let i = 0; i < horizonYears * 4; i++) {
    forecast.push({ d: quarterEndUTC(y, q), cf: forecastQuarterly })
    advance()
  }

  const all = [...flows, ...forecast]
  const irr = xirr(all)

  // Projected payback: cumulative positive cash flows cross contributed capital
  const alreadyPaidBack = contributed > 0 && distributedToDate >= contributed
  const pos = all.filter((f) => f.cf > 0).sort((a, b) => a.d.getTime() - b.d.getTime())
  let run = 0
  let prev: Date | null = null
  let paybackDate: string | null = null
  if (contributed > 0) {
    for (const f of pos) {
      if (run + f.cf >= contributed) {
        const need = contributed - run
        const frac = f.cf > 0 ? need / f.cf : 0
        let dt = f.d
        if (prev) dt = new Date(prev.getTime() + (f.d.getTime() - prev.getTime()) * frac)
        paybackDate = dt.toISOString().slice(0, 10)
        break
      }
      run += f.cf
      prev = f.d
    }
  }

  const pctReturned = contributed > 0 ? Math.min((distributedToDate / contributed) * 100, 100) : 0
  return { contributed, distributedToDate, pctReturned, irr, paybackDate, alreadyPaidBack, forecastQuarterly, horizonYears }
}
