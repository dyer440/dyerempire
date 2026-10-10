// app/real-estate/page.tsx
// Home: this month's rent at a glance, anything late, and one card per property.
import Link from 'next/link'
import { getViewer } from '@/lib/viewer'
import { rentGrid, propertyHeadlines, lateRent, rentMonth, monthsEnding, ymNow } from '@/lib/views'
import { money, money0, monthName, quarterName } from '@/lib/format'
import RentStrip, { RentLegend } from './_ui/RentStrip'
import NoteBox from './_ui/NoteBox'
import { listNotes } from '@/lib/notes'

export default async function Home() {
  const v = await getViewer()
  const ids = v.properties.map((p) => p.id)
  const now = ymNow()
  const months = monthsEnding(now, 6)
  const year = new Date().getFullYear()

  const [lines, heads, late, month, waiting] = await Promise.all([
    rentGrid(ids, months), propertyHeadlines(ids, year), lateRent(ids), rentMonth(ids, now),
    v.insider ? listNotes({ status: 'open', limit: 50 }) : Promise.resolve([]),
  ])
  const expected = month.received + month.open
  const lateTotal = late.reduce((t, l) => t + l.total, 0)

  return (
    <main className="space-y-10">
      <section>
        <h1 className="font-serif text-4xl font-medium tracking-tight sm:text-5xl">{monthName(now, true)}</h1>
        <p className="mt-3 max-w-2xl text-lg text-muted">
          {expected > 0
            ? <>Rent received so far is <strong className="num font-semibold text-ink">{money0(month.received)}</strong> of <span className="num">{money0(expected)}</span> due this month.</>
            : <>No rent has been scheduled for this month yet.</>}
          {late.length === 0 && ' Nobody is behind.'}
        </p>
      </section>

      {late.length > 0 && (
        <section aria-labelledby="late-h" className="rounded-lg border border-late/30 bg-late-wash/60 p-5">
          <h2 id="late-h" className="font-serif text-xl text-late">
            Late rent, <span className="num">{money(lateTotal)}</span>
          </h2>
          <ul className="mt-3 space-y-2">
            {late.map((l) => (
              <li key={`${l.propertyId}-${l.unitLabel}`} className="text-[15px]">
                <Link href={`/real-estate/${l.propertyId}`} className="font-medium underline decoration-late/40 underline-offset-2 hover:decoration-late">
                  {l.propertyName}{l.unitLabel ? `, ${l.unitLabel}` : ''}
                </Link>
                <span className="text-ink/80">
                  {'. '}{l.tenant || 'Tenant'} owes <span className="num font-medium">{money(l.total)}</span> for{' '}
                  {l.months.map((m) => monthName(m)).join(', ')}.
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="props-h">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="props-h" className="font-serif text-2xl">Properties</h2>
          <RentLegend />
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {v.properties.map((p) => {
            const h = heads.get(p.id)
            const pl = lines.filter((l) => l.propertyId === p.id)
            return (
              <Link
                key={p.id}
                href={`/real-estate/${p.id}`}
                className="group block rounded-lg border border-rule bg-surface p-5 transition-colors hover:border-ink/30"
              >
                <h3 className="font-serif text-2xl leading-tight group-hover:underline group-hover:decoration-rule group-hover:underline-offset-4">{p.name}</h3>
                <p className="mt-0.5 text-[14px] text-muted">{p.address}, {p.city}. {p.holding_entity}</p>

                <div className="mt-4 space-y-2.5">
                  {pl.length === 0 && <p className="text-[14px] text-faint">No rent recorded in the last six months.</p>}
                  {pl.map((l) => (
                    <div key={l.key}>
                      <div className="mb-1 flex justify-between gap-2 text-[13px]">
                        <span className="truncate text-ink/80">{l.tenant || 'Vacant'}{l.unitLabel ? <span className="text-muted">, {l.unitLabel}</span> : null}</span>
                      </div>
                      <RentStrip cells={l.cells} showMonths />
                    </div>
                  ))}
                </div>

                <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-rule pt-4 text-[14px]">
                  <div>
                    <dt className="text-muted">Net cash this year</dt>
                    <dd className={`num mt-0.5 text-lg font-medium ${h && h.netYtd < 0 ? 'text-late' : 'text-ink'}`}>{money0(h?.netYtd ?? 0)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Last distribution</dt>
                    <dd className="num mt-0.5 text-lg font-medium">
                      {h?.lastDistribution
                        ? <>{money0(h.lastDistribution.total)} <span className="text-[13px] font-normal text-muted">{quarterName(h.lastDistribution.period)}</span></>
                        : <span className="text-[15px] font-normal text-faint">None recorded</span>}
                    </dd>
                  </div>
                </dl>
              </Link>
            )
          })}
        </div>
      </section>

      {v.insider && (
        <section className="space-y-2">
          <NoteBox properties={v.properties.map((p) => ({ id: p.id, name: p.name }))} />
          <p className="text-[14px] text-muted">
            {waiting.length === 0 ? 'Every note has been handled. ' : `${waiting.length} ${waiting.length === 1 ? 'note is' : 'notes are'} waiting to be posted. `}
            <Link href="/real-estate/notes" className="text-ink underline underline-offset-2">See all notes</Link>
          </p>
        </section>
      )}
    </main>
  )
}
