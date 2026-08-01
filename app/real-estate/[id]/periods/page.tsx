// app/real-estate/[id]/periods/page.tsx  (UPDATED — quarter range starts at the property's first transaction)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getUserRole, canAccessProperty, canEdit } from '@/lib/access'

const STARTS = ['01-01', '04-01', '07-01', '10-01']
const ENDS = ['03-31', '06-30', '09-30', '12-31']

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

  // Earliest actual transaction → first quarter to show
  const firstRow = (await sql`
    SELECT to_char(MIN(txn_date), 'YYYY-MM-DD') AS first
    FROM transactions WHERE property_id = ${propertyId} AND status = 'actual'
  `) as { first: string | null }[]
  const first = firstRow[0]?.first
  const earliestYear = first ? Number(first.slice(0, 4)) : thisYear
  const earliestMonth = first ? Number(first.slice(5, 7)) : 1
  const earliestQuarter = Math.floor((earliestMonth - 1) / 3) + 1

  // Build quarters from earliest (inclusive) through current year, most-recent-first
  const quarters: { label: string; y: number; q: number; start: string; end: string }[] = []
  for (let y = thisYear; y >= earliestYear; y--) {
    for (let q = 4; q >= 1; q--) {
      if (y === earliestYear && q < earliestQuarter) continue
      quarters.push({ label: `${y}-Q${q}`, y, q, start: `${y}-${STARTS[q - 1]}`, end: `${y}-${ENDS[q - 1]}` })
    }
  }

  const startBound = `${earliestYear}-01-01`
  const sums = (await sql`
    SELECT EXTRACT(YEAR FROM txn_date)::int AS y, EXTRACT(QUARTER FROM txn_date)::int AS q,
           type, COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'actual' AND txn_date >= ${startBound}
      AND COALESCE(is_deposit, FALSE) = FALSE
    GROUP BY y, q, type
  `) as { y: number; q: number; type: string; total: number }[]
  const net: Record<string, number> = {}
  for (const s of sums) {
    const k = `${s.y}-Q${s.q}`
    net[k] = (net[k] || 0) + (s.type === 'income' ? s.total : -s.total)
  }

  const closed = (await sql`SELECT label FROM period_closes WHERE property_id = ${propertyId}`) as { label: string }[]
  const closedSet = new Set(closed.map((c) => c.label))
  const dist = (await sql`SELECT DISTINCT period FROM distributions WHERE property_id = ${propertyId}`) as { period: string }[]
  const distSet = new Set(dist.map((d) => d.period))

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl tracking-[0.3em] uppercase" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
              Periods
            </h1>
            <p className="text-white/30 text-xs tracking-widest uppercase mt-1">{prop[0].name} · quarters</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Link href={`/real-estate/${propertyId}`} className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
              ← Property
            </Link>
            <Link href={`/real-estate/${propertyId}/capital`} className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
              Capital →
            </Link>
          </div>
        </div>

        <p className="text-[11px] text-white/30 mb-6 max-w-xl">
          Open a quarter to see its P&amp;L, the tax/insurance reserve, the distributable split by ownership, and to
          record the distribution or close the quarter.
        </p>

        <div className="border border-white/10">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-6 py-3 border-b border-white/10 text-[10px] tracking-widest uppercase text-white/40">
            <span>Quarter</span><span className="text-right">Actual net</span><span className="text-right">State</span><span className="text-right"></span>
          </div>
          {quarters.map((qt) => {
            const isClosed = closedSet.has(qt.label)
            const isDist = distSet.has(qt.label)
            const n = net[qt.label] || 0
            return (
              <Link
                key={qt.label}
                href={`/real-estate/${propertyId}/periods/${qt.label}`}
                className="grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-6 py-4 border-b border-white/5 hover:bg-white/5 transition-colors"
              >
                <div>
                  <div className="text-sm text-white/80" style={{ fontFamily: 'Georgia, serif' }}>{qt.label}</div>
                  <div className="text-[11px] text-white/30">{qt.start} → {qt.end}</div>
                </div>
                <div className={`text-right text-sm ${n >= 0 ? 'text-emerald-400' : 'text-amber-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
                  ${n.toFixed(2)}
                </div>
                <div className="text-right text-xs tracking-widest uppercase">
                  {isClosed ? <span className="text-amber-400/70">🔒 closed</span> : <span className="text-white/30">open</span>}
                  {isDist ? <span className="text-emerald-400/60 ml-2">dist’d</span> : null}
                </div>
                <div className="text-right text-white/30 text-xs tracking-widest uppercase">Open →</div>
              </Link>
            )
          })}
        </div>
      </div>
    </main>
  )
}
