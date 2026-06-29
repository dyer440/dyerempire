// app/real-estate/page.tsx  (UPDATED — list-page Net YTD now counts actuals only, not forecasts)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { seedRealEstate } from '@/lib/seed'
import { getUserRole, canAccessRealEstate, getAccessibleProperties } from '@/lib/access'

export default async function RealEstatePage() {
  await auth.protect()
  await initDb()
  await seedRealEstate()

  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!canAccessRealEstate(role)) redirect('/not-authorized')

  const properties = (await getAccessibleProperties(email, role)) as {
    id: number; name: string; holding_entity: string; property_type: string
    address: string; city: string; state: string; zip: string
  }[]

  // YTD net per property — ACTUALS ONLY (exclude forecast rows), current year
  const year = new Date().getFullYear()
  const sums = (await sql`
    SELECT property_id, type, SUM(amount) AS total
    FROM transactions
    WHERE status = 'actual' AND EXTRACT(YEAR FROM txn_date) = ${year}
    GROUP BY property_id, type
  `) as { property_id: number; type: string; total: string }[]

  const net: Record<number, number> = {}
  for (const s of sums) {
    const amt = parseFloat(s.total)
    net[s.property_id] = (net[s.property_id] || 0) + (s.type === 'income' ? amt : -amt)
  }

  return (
    <main className="re-light min-h-screen text-white p-6 md:p-10">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-2xl tracking-[0.3em] uppercase" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
              Real Estate
            </h1>
            <p className="text-white/30 text-xs tracking-widest uppercase mt-1">
              Southside Properties · {properties.length} {properties.length === 1 ? 'property' : 'properties'}
            </p>
          </div>
          <Link href="/" className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
            ← Home
          </Link>
        </div>

        {properties.length === 0 && (
          <div className="border border-white/10 px-6 py-10 text-center text-white/30 text-sm tracking-widest uppercase">
            No properties assigned to you
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-4">
          {properties.map((p) => {
            const n = net[p.id] || 0
            return (
              <Link
                key={p.id}
                href={`/real-estate/${p.id}`}
                className="border border-white/10 p-6 hover:bg-white/5 transition-colors block"
              >
                <div className="text-lg" style={{ fontFamily: 'Georgia, serif' }}>{p.name}</div>
                <div className="text-white/30 text-xs tracking-widest uppercase mt-1">
                  {p.holding_entity} · {p.property_type?.replace('_', ' ')}
                </div>
                <div className="text-white/40 text-xs mt-2">{p.address}, {p.city} {p.state} {p.zip}</div>
                <div className="flex justify-between items-end mt-6">
                  <span className="text-white/30 text-xs tracking-widest uppercase">Net YTD</span>
                  <span className={`text-lg ${n >= 0 ? 'text-emerald-400' : 'text-amber-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
                    ${n.toFixed(2)}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      </div>
    </main>
  )
}
