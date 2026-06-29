// app/real-estate/[id]/capital/page.tsx  (NEW — member capital accounts, Real & Paper)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getUserRole, canAccessProperty } from '@/lib/access'
import { computeCapitalAccounts, type OwnerYear } from '@/lib/capital'

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function Block({ title, rows }: { title: string; rows: { name: string; v: OwnerYear }[] }) {
  const totals = rows.reduce(
    (a, r) => ({
      beginning: a.beginning + r.v.beginning, contributions: a.contributions + r.v.contributions,
      netIncome: a.netIncome + r.v.netIncome, distributions: a.distributions + r.v.distributions,
      ending: a.ending + r.v.ending,
    }),
    { beginning: 0, contributions: 0, netIncome: 0, distributions: 0, ending: 0 },
  )
  return (
    <div className="mb-4">
      <div className="text-[10px] tracking-widest uppercase text-white/40 mb-2">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" style={{ fontFamily: 'Georgia, serif' }}>
          <thead>
            <tr className="text-white/30 text-[10px] tracking-widest uppercase">
              <th className="text-left font-normal py-1 pr-3">Member</th>
              <th className="text-right font-normal py-1 px-2">Beginning</th>
              <th className="text-right font-normal py-1 px-2">Contrib.</th>
              <th className="text-right font-normal py-1 px-2">Net Income</th>
              <th className="text-right font-normal py-1 px-2">Distrib.</th>
              <th className="text-right font-normal py-1 pl-2">Ending</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="text-white/70 border-t border-white/5">
                <td className="text-left py-1.5 pr-3">{r.name}</td>
                <td className="text-right py-1.5 px-2">{fmt(r.v.beginning)}</td>
                <td className="text-right py-1.5 px-2">{r.v.contributions ? fmt(r.v.contributions) : '—'}</td>
                <td className="text-right py-1.5 px-2">{fmt(r.v.netIncome)}</td>
                <td className="text-right py-1.5 px-2">{r.v.distributions ? fmt(r.v.distributions) : '—'}</td>
                <td className="text-right py-1.5 pl-2 text-white/90">{fmt(r.v.ending)}</td>
              </tr>
            ))}
            <tr className="text-white/50 border-t border-white/15 text-[11px]">
              <td className="text-left py-1.5 pr-3 uppercase tracking-widest">Total</td>
              <td className="text-right py-1.5 px-2">{fmt(totals.beginning)}</td>
              <td className="text-right py-1.5 px-2">{totals.contributions ? fmt(totals.contributions) : '—'}</td>
              <td className="text-right py-1.5 px-2">{fmt(totals.netIncome)}</td>
              <td className="text-right py-1.5 px-2">{totals.distributions ? fmt(totals.distributions) : '—'}</td>
              <td className="text-right py-1.5 pl-2">{fmt(totals.ending)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default async function CapitalPage({ params }: { params: Promise<{ id: string }> }) {
  await auth.protect()
  await initDb()
  const { id } = await params
  const propertyId = Number(id)

  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!(await canAccessProperty(email, role, propertyId))) redirect('/real-estate')

  const prop = (await sql`SELECT id, name, holding_entity FROM properties WHERE id = ${propertyId} LIMIT 1`) as
    { id: number; name: string; holding_entity: string }[]
  if (prop.length === 0) redirect('/real-estate')

  const ca = await computeCapitalAccounts(propertyId)

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl tracking-[0.3em] uppercase" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
              Capital Accounts
            </h1>
            <p className="text-white/30 text-xs tracking-widest uppercase mt-1">{prop[0].name} · {prop[0].holding_entity}</p>
          </div>
          <Link href={`/real-estate/${propertyId}`} className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
            ← Property
          </Link>
        </div>

        <p className="text-[11px] text-white/30 mb-6 max-w-xl">
          Member capital on two bases. <span className="text-white/50">Real</span> tracks cash equity; <span className="text-white/50">Paper</span>
          {' '}reflects income after depreciation (the K-1 basis). Each year: Beginning + Contributions + Net Income (allocated by ownership %) − Distributions = Ending.
        </p>

        {ca.years.map((y) => (
          <div key={y.year} className="border border-white/10 p-5 mb-5">
            <div className="text-lg mb-3" style={{ fontFamily: 'Georgia, serif' }}>{y.year}</div>
            <Block title="Real (cash)" rows={y.rows.map((r) => ({ name: r.name, v: r.real }))} />
            <Block title="Paper (after depreciation · K-1)" rows={y.rows.map((r) => ({ name: r.name, v: r.paper }))} />
          </div>
        ))}
      </div>
    </main>
  )
}
