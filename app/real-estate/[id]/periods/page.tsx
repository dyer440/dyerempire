// app/real-estate/[id]/periods/page.tsx  (NEW — close/reopen calendar quarters)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getUserRole, canAccessProperty, canEdit } from '@/lib/access'
import { closePeriod, reopenPeriod } from '../../recurring/actions'

const pad = (n: number) => String(n).padStart(2, '0')

function quartersFor(years: number[]) {
  const out: { label: string; y: number; q: number; start: string; end: string }[] = []
  const ends = ['03-31', '06-30', '09-30', '12-31']
  const starts = ['01-01', '04-01', '07-01', '10-01']
  for (const y of years) {
    for (let q = 1; q <= 4; q++) {
      out.push({ label: `${y}-Q${q}`, y, q, start: `${y}-${starts[q - 1]}`, end: `${y}-${ends[q - 1]}` })
    }
  }
  return out
}

export default async function PeriodsPage({ params }: { params: Promise<{ id: string }> }) {
  await auth.protect()
  await initDb()
  const { id } = await params
  const propertyId = Number(id)

  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!(await canAccessProperty(email, role, propertyId))) redirect('/real-estate')
  if (!canEdit(role)) redirect(`/real-estate/${propertyId}`)

  const prop = (await sql`SELECT id, name FROM properties WHERE id = ${propertyId} LIMIT 1`) as
    { id: number; name: string }[]
  if (prop.length === 0) redirect('/real-estate')

  const thisYear = new Date().getFullYear()
  const years = [thisYear, thisYear - 1]
  const quarters = quartersFor(years)

  // Actual net per quarter (for context)
  const startBound = `${thisYear - 1}-01-01`
  const sums = (await sql`
    SELECT EXTRACT(YEAR FROM txn_date)::int AS y, EXTRACT(QUARTER FROM txn_date)::int AS q,
           type, COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'actual' AND txn_date >= ${startBound}
    GROUP BY y, q, type
  `) as { y: number; q: number; type: string; total: number }[]
  const net: Record<string, number> = {}
  for (const s of sums) {
    const k = `${s.y}-Q${s.q}`
    net[k] = (net[k] || 0) + (s.type === 'income' ? s.total : -s.total)
  }

  // Forecast count per quarter (what's still scheduled/unconfirmed there)
  const fc = (await sql`
    SELECT EXTRACT(YEAR FROM txn_date)::int AS y, EXTRACT(QUARTER FROM txn_date)::int AS q, COUNT(*)::int AS n
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'forecast' AND txn_date >= ${startBound}
    GROUP BY y, q
  `) as { y: number; q: number; n: number }[]
  const fcount: Record<string, number> = {}
  for (const r of fc) fcount[`${r.y}-Q${r.q}`] = r.n

  const closed = (await sql`SELECT label FROM period_closes WHERE property_id = ${propertyId}`) as { label: string }[]
  const closedSet = new Set(closed.map((c) => c.label))

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl tracking-[0.3em] uppercase" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
              Periods
            </h1>
            <p className="text-white/30 text-xs tracking-widest uppercase mt-1">{prop[0].name} · quarter close</p>
          </div>
          <Link href={`/real-estate/${propertyId}`} className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
            ← Property
          </Link>
        </div>

        <p className="text-[11px] text-white/30 mb-6 max-w-xl">
          Closing a quarter clears any unconfirmed scheduled items in it and stops the scheduler from
          regenerating forecasts there — a closed quarter holds only actuals. Reopen to unlock.
        </p>

        <div className="border border-white/10">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-6 py-3 border-b border-white/10 text-[10px] tracking-widest uppercase text-white/40">
            <span>Quarter</span><span className="text-right">Actual net</span><span className="text-right">Scheduled</span><span className="text-right">Status</span>
          </div>
          {quarters.map((qt) => {
            const isClosed = closedSet.has(qt.label)
            const n = net[qt.label] || 0
            const sched = fcount[qt.label] || 0
            return (
              <div key={qt.label} className="grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-6 py-4 border-b border-white/5">
                <div>
                  <div className="text-sm text-white/80" style={{ fontFamily: 'Georgia, serif' }}>{qt.label}</div>
                  <div className="text-[11px] text-white/30">{qt.start} → {qt.end}</div>
                </div>
                <div className={`text-right text-sm ${n >= 0 ? 'text-emerald-400' : 'text-amber-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
                  ${n.toFixed(2)}
                </div>
                <div className="text-right text-xs text-white/40">{sched ? `${sched} open` : '—'}</div>
                <div className="text-right">
                  {isClosed ? (
                    <form action={reopenPeriod} className="inline">
                      <input type="hidden" name="property_id" value={propertyId} />
                      <input type="hidden" name="label" value={qt.label} />
                      <span className="text-amber-400/70 text-xs tracking-widest uppercase mr-3">🔒 Closed</span>
                      <button type="submit" className="text-xs text-white/30 hover:text-white tracking-widest uppercase transition-colors">
                        Reopen
                      </button>
                    </form>
                  ) : (
                    <form action={closePeriod} className="inline">
                      <input type="hidden" name="property_id" value={propertyId} />
                      <input type="hidden" name="label" value={qt.label} />
                      <input type="hidden" name="period_start" value={qt.start} />
                      <input type="hidden" name="period_end" value={qt.end} />
                      <button type="submit" className="border border-white/30 px-4 py-1 text-xs tracking-widest uppercase hover:bg-white/10 transition-all">
                        Close
                      </button>
                    </form>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </main>
  )
}
