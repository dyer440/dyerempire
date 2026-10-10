// The record of what actually happened, newest first, with a year picker and
// a search box. Read-only: corrections go through Claude or a note.
import Link from 'next/link'
import type { ActivityRow } from '@/lib/views'
import { money, shortDate } from '@/lib/format'

export default function ActivityList({ rows, years, year, search, basePath }: {
  rows: ActivityRow[]; years: number[]; year: number; search: string; basePath: string
}) {
  const inflow = rows.filter((r) => r.type === 'income' && !r.deposit).reduce((t, r) => t + r.amount, 0)
  const outflow = rows.filter((r) => r.type === 'expense' && !r.deposit).reduce((t, r) => t + r.amount, 0)
  const qs = (y: number) => `${basePath}?year=${y}${search ? `&q=${encodeURIComponent(search)}` : ''}`

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <form method="get" action={basePath} className="flex w-full max-w-md gap-2" role="search">
          <input type="hidden" name="year" value={year} />
          <label htmlFor="q" className="sr-only">Search</label>
          <input
            id="q" name="q" defaultValue={search} placeholder="Search a name, category or amount"
            className="min-w-0 flex-1 rounded-md border border-rule bg-surface px-3 py-2 text-[15px] placeholder:text-faint focus:border-brass focus:outline-none"
          />
          <button className="rounded-md border border-rule bg-surface px-3 py-2 text-[14px] hover:border-ink/30">Search</button>
        </form>
        <nav aria-label="Year" className="flex flex-wrap gap-1 text-[14px]">
          {years.map((y) => (
            <Link key={y} href={qs(y)} aria-current={y === year ? 'page' : undefined}
              className={`rounded-md px-2.5 py-1 ${y === year ? 'bg-wash font-medium text-ink' : 'text-muted hover:text-ink'}`}>
              {y}
            </Link>
          ))}
        </nav>
      </div>

      <p className="mt-4 text-[15px] text-muted">
        {rows.length} {rows.length === 1 ? 'entry' : 'entries'}{search && <> matching &ldquo;{search}&rdquo;</>} in {year}.
        {' '}In <span className="num text-paid">{money(inflow)}</span>, out <span className="num text-ink">{money(outflow)}</span>.
        {search && <> <Link href={`${basePath}?year=${year}`} className="text-ink underline underline-offset-2">Clear search</Link></>}
      </p>

      {rows.length > 0 && (
        <ul className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-baseline gap-x-4 px-4 py-2.5 text-[15px]">
              <span className="text-[14px] text-muted">{shortDate(r.date)}</span>
              <span className="min-w-0">
                <span className="block truncate">{r.description || r.category}</span>
                <span className="block truncate text-[13px] text-muted">
                  {r.category}{r.unit ? `, ${r.unit}` : ''}{r.deposit ? ', security deposit' : ''}
                </span>
              </span>
              <span className={`num text-right ${r.type === 'income' ? 'text-paid' : ''}`}>
                {r.type === 'income' ? '+' : '−'}{money(r.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length >= 400 && <p className="mt-2 text-[13px] text-muted">Showing the latest 400. Search to narrow it down.</p>}
    </div>
  )
}
