// app/real-estate/companies/[slug]/page.tsx
// One company's own books (entity rows, not its properties): this year by
// category, then every entry.
import { notFound, redirect } from 'next/navigation'
import { getViewer } from '@/lib/viewer'
import { listCompanies, companyCategoryYear, activity, activityYears } from '@/lib/views'
import { money } from '@/lib/format'
import ActivityList from '../../_ui/ActivityList'
import Link from 'next/link'
import { MEDIA_ENTITY_SLUG, listProducts, productLedger } from '@/lib/media'

export default async function Company({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>; searchParams: Promise<{ year?: string; q?: string }>
}) {
  const v = await getViewer()
  if (!v.insider) redirect('/real-estate')
  const { slug } = await params
  const sp = await searchParams
  const c = (await listCompanies()).find((x) => x.slug === slug)
  if (!c) notFound()

  const years = await activityYears({ entityId: c.id })
  const thisYear = new Date().getFullYear()
  if (!years.includes(thisYear)) years.unshift(thisYear)
  const year = /^\d{4}$/.test(sp.year || '') && years.includes(Number(sp.year)) ? Number(sp.year) : years[0]
  const search = (sp.q || '').slice(0, 100)
  const [cats, rows] = await Promise.all([
    companyCategoryYear(c.id, year),
    activity({ entityId: c.id, year, search }),
  ])
  const publications = c.slug === MEDIA_ENTITY_SLUG
    ? await Promise.all((await listProducts()).map(async (p) => ({ p, L: (await productLedger(p.slug))!.ledger })))
    : []
  const income = cats.filter((r) => r.type === 'income')
  const expense = cats.filter((r) => r.type === 'expense')
  const tIn = income.reduce((t, r) => t + r.total, 0)
  const tOut = expense.reduce((t, r) => t + r.total, 0)

  return (
    <main className="space-y-10">
      <header>
        <h1 className="font-serif text-4xl font-medium tracking-tight">{c.name}</h1>
        {c.legal_name && c.legal_name !== c.name && <p className="mt-1 text-[15px] text-muted">{c.legal_name}</p>}
      </header>

      {publications.length > 0 && (
        <section aria-labelledby="pub-h">
          <h2 id="pub-h" className="font-serif text-2xl">Publications</h2>
          <ul className="mt-4 grid gap-4 md:grid-cols-2">
            {publications.map(({ p, L }) => (
              <li key={p.slug}>
                <Link href={`/media/${p.slug}`} className="block rounded-lg border border-rule bg-surface p-5 hover:border-ink/30">
                  <h3 className="font-serif text-2xl">{p.name}</h3>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-[14px]">
                    <div>
                      <dt className="text-muted">Latest month</dt>
                      <dd className="num mt-0.5 text-[15px] font-medium">{L.months[0] ? money(L.months[0].gross) : 'None'}</dd>
                    </div>
                    {p.owner_pct < 100 ? (
                      <div>
                        <dt className="text-muted">Owed to {p.partner_name?.replace(/\s*\(.*\)$/, '')}</dt>
                        <dd className={`num mt-0.5 text-[15px] font-medium ${L.totals.partnerDue > 0.004 ? 'text-due' : 'text-paid'}`}>{L.totals.partnerDue > 0.004 ? money(L.totals.partnerDue) : 'Paid up'}</dd>
                      </div>
                    ) : (
                      <div>
                        <dt className="text-muted">Received this year</dt>
                        <dd className="num mt-0.5 text-[15px] font-medium">{money(L.years.find((y) => y.year === new Date().getFullYear())?.received ?? 0)}</dd>
                      </div>
                    )}
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="cat-h">
        <h2 id="cat-h" className="font-serif text-2xl">{year === thisYear ? `${year} so far` : year}</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <CatList title="Money in" rows={income} total={tIn} />
          <CatList title="Money out" rows={expense} total={tOut} />
        </div>
        <p className="mt-3 text-[15px]">
          Net cash: <span className={`num font-medium ${tIn - tOut < 0 ? 'text-late' : ''}`}>{money(tIn - tOut)}</span>
        </p>
      </section>

      <section aria-labelledby="act-h">
        <h2 id="act-h" className="mb-4 font-serif text-2xl">Activity</h2>
        <ActivityList rows={rows} years={years} year={year} search={search} basePath={`/real-estate/companies/${c.slug}`} />
      </section>
    </main>
  )
}

function CatList({ title, rows, total }: { title: string; rows: { category: string; total: number }[]; total: number }) {
  return (
    <div className="rounded-lg border border-rule bg-surface">
      <h3 className="border-b border-rule px-4 py-2.5 text-[14px] font-medium text-muted">{title}</h3>
      <ul className="px-4 py-2 text-[15px]">
        {rows.length === 0 && <li className="py-1.5 text-faint">None</li>}
        {rows.map((r) => (
          <li key={r.category} className="flex justify-between gap-3 py-1.5">
            <span>{r.category}</span><span className="num">{money(r.total)}</span>
          </li>
        ))}
      </ul>
      <p className="flex justify-between border-t border-rule px-4 py-2.5 text-[15px] font-medium">
        <span>Total</span><span className="num">{money(total)}</span>
      </p>
    </div>
  )
}
