// app/real-estate/[id]/page.tsx
// Property overview: rent this year by unit, money in and out by category
// (this year beside last year), and bills coming up.
import Link from 'next/link'
import { requireProperty } from '@/lib/viewer'
import { rentGrid, categoryYears, upcomingBills } from '@/lib/views'
import { money, shortDate } from '@/lib/format'
import { RentLegend } from '../_ui/RentStrip'
import RentTable from '../_ui/RentTable'
import LeaseCard from '../_ui/LeaseCard'
import { listLeases } from '@/lib/leases'

export default async function Overview({
  params, searchParams,
}: {
  params: Promise<{ id: string }>; searchParams: Promise<{ year?: string }>
}) {
  const { id } = await params
  const { property: p, viewer } = await requireProperty(Number(id))
  const sp = await searchParams
  const thisYear = new Date().getFullYear()
  const year = /^\d{4}$/.test(sp.year || '') ? Math.min(Number(sp.year), thisYear) : thisYear
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)

  const [lines, cats, bills, leases] = await Promise.all([
    rentGrid([p.id], months),
    categoryYears(p.id, [year - 1, year]),
    upcomingBills(p.id, 90),
    listLeases({ propertyIds: [p.id] }),
  ])
  const yearLabel = (y: number) => (y === thisYear ? `${y} so far` : String(y))

  return (
    <div className="space-y-12">
      <section aria-labelledby="lease-h">
        <h2 id="lease-h" className="font-serif text-2xl">{leases.length > 1 ? 'Leases' : 'Lease'}</h2>
        {leases.length === 0
          ? <p className="mt-2 text-muted">No lease on file yet.</p>
          : <div className="mt-4 grid gap-4 lg:grid-cols-2">{leases.map((l) => <LeaseCard key={l.id} l={l} showContact={viewer.insider} />)}</div>}
      </section>

      <section aria-labelledby="rent-h">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="rent-h" className="font-serif text-2xl">Rent in {year}</h2>
          <div className="flex gap-4 text-[14px]">
            <Link href={`?year=${year - 1}`} className="text-muted hover:text-ink">{year - 1}</Link>
            {year < thisYear && <Link href={`?year=${year + 1}`} className="text-muted hover:text-ink">{year + 1}</Link>}
          </div>
        </div>
        {lines.length === 0 ? (
          <p className="mt-3 text-muted">No rent recorded in {year}.</p>
        ) : (
          <div className="mt-4"><RentTable lines={lines} months={months} /></div>
        )}
        <div className="mt-3"><RentLegend /></div>
      </section>

      <section aria-labelledby="money-h">
        <h2 id="money-h" className="font-serif text-2xl">Money in and out</h2>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">
          Cash actually received and paid. Security deposits are left out because they belong to the tenant.
        </p>
        <div className="mt-4 overflow-x-auto rounded-lg border border-rule bg-surface">
          <table className="w-full min-w-[420px] text-[15px]">
            <thead>
              <tr className="border-b border-rule text-[13px] text-muted">
                <th scope="col" className="px-4 py-2 text-left font-normal">Category</th>
                {cats.years.map((y) => <th key={y} scope="col" className="px-4 py-2 text-right font-normal">{yearLabel(y)}</th>)}
              </tr>
            </thead>
            <tbody>
              <GroupRows title="Money in" rows={cats.income} years={cats.years} total={(y) => cats.totals[y].income} />
              <GroupRows title="Money out" rows={cats.expense} years={cats.years} total={(y) => cats.totals[y].expense} />
              <tr className="bg-wash/60">
                <th scope="row" className="px-4 py-3 text-left font-serif text-lg font-medium">Net cash</th>
                {cats.years.map((y) => (
                  <td key={y} className={`num px-4 py-3 text-right text-lg font-medium ${cats.totals[y].net < 0 ? 'text-late' : ''}`}>
                    {money(cats.totals[y].net)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {cats.expense.some((e) => e.category === 'Loan Principal') && (
          <p className="mt-2 text-[13px] text-muted">
            Loan principal is cash out but not a tax deduction. Only the interest part is deducted on the return.
          </p>
        )}
      </section>

      <section aria-labelledby="bills-h">
        <h2 id="bills-h" className="font-serif text-2xl">Coming up in the next 90 days</h2>
        {bills.length === 0 ? (
          <p className="mt-3 text-muted">Nothing scheduled.</p>
        ) : (
          <ul className="mt-4 divide-y divide-rule rounded-lg border border-rule bg-surface">
            {bills.map((b, i) => (
              <li key={i} className="flex items-baseline gap-4 px-4 py-3 text-[15px]">
                <span className="w-16 shrink-0 text-muted">{shortDate(b.date)}</span>
                <span className="min-w-0 flex-1">{b.category}</span>
                <span className="num shrink-0">{money(b.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function GroupRows({ title, rows, years, total }: {
  title: string
  rows: { category: string; byYear: Record<number, number> }[]
  years: number[]
  total: (y: number) => number
}) {
  return (
    <>
      <tr>
        <th scope="rowgroup" colSpan={years.length + 1} className="px-4 pb-1 pt-4 text-left text-[13px] font-medium text-muted">{title}</th>
      </tr>
      {rows.length === 0 && (
        <tr><td colSpan={years.length + 1} className="px-4 py-1.5 text-faint">None</td></tr>
      )}
      {rows.map((r) => (
        <tr key={r.category}>
          <th scope="row" className="px-4 py-1.5 text-left font-normal">{r.category}</th>
          {years.map((y) => (
            <td key={y} className="num px-4 py-1.5 text-right">{r.byYear[y] ? money(r.byYear[y]) : <span className="text-faint">0</span>}</td>
          ))}
        </tr>
      ))}
      <tr className="border-b border-rule">
        <th scope="row" className="px-4 pb-3 pt-1.5 text-left font-medium">Total {title.toLowerCase()}</th>
        {years.map((y) => <td key={y} className="num px-4 pb-3 pt-1.5 text-right font-medium">{money(total(y))}</td>)}
      </tr>
    </>
  )
}
