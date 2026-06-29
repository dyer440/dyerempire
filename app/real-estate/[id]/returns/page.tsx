// app/real-estate/[id]/returns/page.tsx  (NEW — IRR, projected payback, forecast)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getUserRole, canAccessProperty } from '@/lib/access'
import { computeReturns } from '@/lib/irr'

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (s: string | null) =>
  s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '—'

export default async function ReturnsPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fq?: string; hz?: string }>
}) {
  await auth.protect()
  await initDb()
  const { id } = await params
  const propertyId = Number(id)
  const sp = await searchParams

  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!(await canAccessProperty(email, role, propertyId))) redirect('/real-estate')

  const prop = (await sql`SELECT name, holding_entity FROM properties WHERE id = ${propertyId} LIMIT 1`) as
    { name: string; holding_entity: string }[]
  if (prop.length === 0) redirect('/real-estate')

  // Default forecast = average of the last up-to-4 quarterly distribution totals
  const recent = (await sql`
    SELECT COALESCE(SUM(amount), 0)::float8 AS t
    FROM distributions WHERE property_id = ${propertyId}
    GROUP BY period ORDER BY period DESC LIMIT 4
  `) as { t: number }[]
  const avg = recent.length ? recent.reduce((s, r) => s + r.t, 0) / recent.length : 3450
  const defaultFq = Math.round(avg)

  const forecastQuarterly = sp.fq !== undefined && sp.fq !== '' ? Math.max(parseFloat(sp.fq), 0) : defaultFq
  const horizonYears = sp.hz !== undefined && sp.hz !== '' ? Math.max(parseInt(sp.hz), 1) : 25

  const r = await computeReturns(propertyId, forecastQuarterly, horizonYears)

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl tracking-[0.3em] uppercase" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>Returns</h1>
          <p className="text-white/30 text-xs tracking-widest uppercase mt-1">{prop[0].name} · {prop[0].holding_entity}</p>
        </div>

        {/* Headline: projected payback */}
        <div className="border border-white/10 p-6 mb-5">
          <div className="text-white/30 text-xs tracking-widest uppercase mb-2">
            {r.alreadyPaidBack ? 'Capital Fully Returned' : 'Projected Payback'}
          </div>
          <div className="text-3xl mb-2" style={{ fontFamily: 'Georgia, serif' }}>
            {r.alreadyPaidBack ? 'Paid back' : fmtDate(r.paybackDate)}
          </div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-white/60">{fmt(r.distributedToDate)} returned of {fmt(r.contributed)}</span>
            <span className="text-white/80" style={{ fontFamily: 'Georgia, serif' }}>{r.pctReturned.toFixed(1)}%</span>
          </div>
          <div className="h-1 bg-white/10 w-full">
            <div className="h-1 bg-emerald-400" style={{ width: `${r.pctReturned}%` }} />
          </div>
        </div>

        {/* IRR */}
        <div className="border border-white/10 p-6 mb-5">
          <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Internal Rate of Return</div>
          <div className="text-3xl" style={{ fontFamily: 'Georgia, serif' }}>
            {r.irr === null ? '—' : `${(r.irr * 100).toFixed(2)}%`}
          </div>
          <p className="text-[11px] text-white/30 mt-3 max-w-xl">
            IRR is highly sensitive to the holding period because no sale is modeled — the longer you hold and collect
            distributions, the higher it climbs. At a {horizonYears}-year hold this is {r.irr === null ? '—' : `${(r.irr * 100).toFixed(2)}%`}.
            Adjust the assumptions below to test other scenarios.
          </p>
        </div>

        {/* Assumptions form (GET) */}
        <form method="get" className="border border-white/10 p-6 mb-5">
          <div className="text-white/30 text-xs tracking-widest uppercase mb-4">Assumptions</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-xs text-white/40 tracking-widest uppercase">Forecast distribution / quarter</span>
              <input name="fq" type="number" step="0.01" min="0" defaultValue={forecastQuarterly}
                className="mt-1 w-full bg-black border border-white/20 text-white px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="text-xs text-white/40 tracking-widest uppercase">Holding period (years)</span>
              <input name="hz" type="number" step="1" min="1" defaultValue={horizonYears}
                className="mt-1 w-full bg-black border border-white/20 text-white px-3 py-2 text-sm" />
            </label>
          </div>
          <button type="submit"
            className="mt-4 border border-white/30 hover:bg-white hover:text-black text-white px-5 py-2 text-xs tracking-widest uppercase transition-colors">
            Recompute
          </button>
          <p className="text-[11px] text-white/25 mt-3">
            Forecast defaults to the average of your last four quarterly distributions ({fmt(defaultFq)}). Contributions and
            recorded distributions are actual; only future quarters are projected.
          </p>
        </form>
      </div>
    </main>
  )
}
