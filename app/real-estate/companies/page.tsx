// app/real-estate/companies/page.tsx
// The non-property companies (SLCM, SL Trading, SL Media and so on).
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getViewer } from '@/lib/viewer'
import { listCompanies } from '@/lib/views'
import sql from '@/lib/db'
import { money0 } from '@/lib/format'

export default async function Companies() {
  const v = await getViewer()
  if (!v.insider) redirect('/real-estate')
  const companies = await listCompanies()
  const year = new Date().getFullYear()
  const nets = (await sql`
    SELECT entity_id, SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END)::float8 AS net
    FROM transactions
    WHERE property_id IS NULL AND status = 'actual' AND COALESCE(is_deposit, FALSE) = FALSE
      AND EXTRACT(YEAR FROM txn_date) = ${year}
    GROUP BY entity_id
  `) as { entity_id: number; net: number }[]
  const net = new Map(nets.map((n) => [n.entity_id, n.net]))

  return (
    <main>
      <h1 className="font-serif text-4xl font-medium tracking-tight">Companies</h1>
      <ul className="mt-6 grid gap-4 md:grid-cols-2">
        {companies.map((c) => (
          <li key={c.id}>
            <Link href={`/real-estate/companies/${c.slug}`} className="block rounded-lg border border-rule bg-surface p-5 hover:border-ink/30">
              <h2 className="font-serif text-2xl">{c.name}</h2>
              {c.legal_name && c.legal_name !== c.name && <p className="text-[14px] text-muted">{c.legal_name}</p>}
              <p className="mt-4 text-[14px] text-muted">
                Net cash in {year}: <span className={`num text-[15px] font-medium ${(net.get(c.id) ?? 0) < 0 ? 'text-late' : 'text-ink'}`}>{money0(net.get(c.id) ?? 0)}</span>
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
