// app/real-estate/[id]/partners/page.tsx
// What each owner has put in and taken out, and how the next distribution is
// figured, shown step by step so a partner can check the arithmetic.
import { requireProperty } from '@/lib/viewer'
import { computeQuarter } from '@/lib/distributions'
import { computeCapitalAccounts, type OwnerYear } from '@/lib/capital'
import { computePayback } from '@/lib/payback'
import { computeReturns } from '@/lib/irr'
import { distributionHistory, lastEndedQuarter } from '@/lib/views'
import { money, longDate, quarterName } from '@/lib/format'

export default async function Partners({
  params, searchParams,
}: {
  params: Promise<{ id: string }>; searchParams: Promise<{ fq?: string; hz?: string }>
}) {
  const { id } = await params
  const { property: p } = await requireProperty(Number(id))
  const period = lastEndedQuarter()

  const sp = await searchParams
  const [q, ca, pb, hist] = await Promise.all([
    computeQuarter(p.id, period),
    computeCapitalAccounts(p.id),
    computePayback(p.id),
    distributionHistory(p.id),
  ])
  const recorded = hist.periods.find((h) => h.period === period)

  // Returns: the average of the last four recorded quarters is the default
  // forecast; the viewer can try other amounts and holding periods.
  const recent = hist.periods.slice(0, 4)
  const defaultFq = recent.length ? Math.round(recent.reduce((t, h) => t + h.total, 0) / recent.length) : 0
  const fq = sp.fq !== undefined && sp.fq !== '' && Number.isFinite(Number(sp.fq)) ? Math.max(Number(sp.fq), 0) : defaultFq
  const hz = sp.hz !== undefined && sp.hz !== '' && Number.isFinite(Number(sp.hz)) ? Math.min(Math.max(Math.round(Number(sp.hz)), 1), 50) : 25
  const ret = pb.contributed > 0 ? await computeReturns(p.id, fq, hz) : null
  const qEnd = longDate(q.end)

  return (
    <div className="space-y-12">
      <section aria-labelledby="math-h">
        <h2 id="math-h" className="font-serif text-2xl">How the {quarterName(period)} distribution is figured</h2>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">
          The property keeps enough cash to pay its next tax and insurance bills. Whatever is left over can go to the owners.
        </p>
        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <ol className="divide-y divide-rule rounded-lg border border-rule bg-surface text-[15px]">
            <Step label={`Net cash this year through ${qEnd}`} note="Rent and other income, less every expense paid, including taxes and insurance." value={q.cumulativeActualNoi} />
            <Step label={`Less distributions already paid in ${period.slice(0, 4)}`} value={-q.distributedYtd} />
            <Step label="Cash held by the property" value={q.retainedCash} strong />
            <Step
              label="Less cash kept back for upcoming bills"
              note={`Taxes and insurance due in the next 6 months come to ${money(q.upcomingReserve)}${q.nextReserveBillDate ? ` (the last on ${longDate(q.nextReserveBillDate)})` : ''}. Rent expected before then, after running costs, covers ${money(Math.max(q.forwardNoi, 0))} of it.`}
              value={-q.reserveShortfall}
            />
            <Step label="Available to distribute" note={q.retainedCash - q.reserveShortfall < 0 ? 'The property needs all of its cash for upcoming bills, so nothing is available.' : undefined} value={q.runwayDistributable} strong final />
          </ol>

          <aside className="rounded-lg border border-rule bg-surface p-5">
            <h3 className="font-serif text-lg">Split</h3>
            <p className="mt-1 text-[14px] text-muted">
              {q.flipActive ? 'Capital has been paid back, so the split is even.' : 'By ownership percentage.'}
            </p>
            <ul className="mt-3 space-y-2 text-[15px]">
              {q.split.map((s) => (
                <li key={s.owner_id} className="flex justify-between gap-3">
                  <span>{s.name} <span className="text-muted">{trimPct(s.pct)}</span></span>
                  <span className="num">{money(s.amount)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-rule pt-3 text-[15px]">
              {recorded ? (
                <p>
                  Recorded for {quarterName(period)}: <span className="num font-medium">{money(recorded.total)}</span>
                  {recorded.total === 0 && <span className="text-muted">. Nothing was paid out.</span>}
                </p>
              ) : (
                <p className="text-muted">Nothing recorded for {quarterName(period)} yet.</p>
              )}
            </div>
          </aside>
        </div>
        <p className="mt-3 max-w-2xl text-[13px] text-muted">
          Bills and expected rent are as of today, so this figure moves as bills are paid and rent comes in.
        </p>
      </section>

      {pb.contributed > 0 && (
        <section aria-labelledby="payback-h">
          <h2 id="payback-h" className="font-serif text-2xl">Capital paid back</h2>
          <div className="mt-4 rounded-lg border border-rule bg-surface p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[15px]">
                <span className="num font-medium">{money(pb.distributed)}</span> returned of <span className="num">{money(pb.contributed)}</span> put in
              </p>
              <p className="num font-serif text-2xl">{pb.pctReturned.toFixed(1)}%</p>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-wash" role="img" aria-label={`${pb.pctReturned.toFixed(1)}% of capital returned`}>
              <div className="h-2 rounded-full bg-paid" style={{ width: `${Math.min(pb.pctReturned, 100)}%` }} />
            </div>
            <ul className="mt-4 grid gap-2 text-[14px] sm:grid-cols-2">
              {pb.owners.map((o) => (
                <li key={o.owner_id} className="flex justify-between gap-3">
                  <span>{o.name}</span>
                  <span className="num text-muted">{money(o.distributed)} of {money(o.contributed)}</span>
                </li>
              ))}
            </ul>
            {pb.flipEnabled && !pb.reached && (
              <p className="mt-3 text-[13px] text-muted">Once all capital is paid back, distributions split evenly.</p>
            )}
          </div>
        </section>
      )}

      {ret && (
        <section aria-labelledby="irr-h">
          <h2 id="irr-h" className="font-serif text-2xl">Return on investment</h2>
          <p className="mt-1 max-w-2xl text-[14px] text-muted">
            The internal rate of return on the money put in, counting every distribution so far plus future quarters at the
            amount below. No sale is assumed, so the longer the hold, the higher it climbs.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
            <div className="rounded-lg border border-rule bg-surface p-5">
              <p className="text-[15px] text-muted">Internal rate of return</p>
              <p className="num mt-1 font-serif text-4xl">{ret.irr === null ? 'Not enough yet' : `${(ret.irr * 100).toFixed(2)}%`}</p>
              <p className="mt-2 text-[14px] text-muted">Over a {hz}-year hold.</p>
            </div>
            <div className="rounded-lg border border-rule bg-surface p-5">
              <p className="text-[15px] text-muted">{ret.alreadyPaidBack ? 'Capital' : 'All capital paid back by'}</p>
              <p className="mt-1 font-serif text-3xl">{ret.alreadyPaidBack ? 'Paid back' : ret.paybackDate ? longDate(ret.paybackDate) : 'Not within the hold'}</p>
              <p className="mt-2 text-[14px] text-muted">At {money(fq)} a quarter.</p>
            </div>
            <form method="get" className="rounded-lg border border-rule bg-surface p-5">
              <p className="text-[15px] font-medium">Try other numbers</p>
              <div className="mt-3 grid grid-cols-2 gap-3 text-[14px]">
                <label className="block">
                  <span className="text-muted">Distribution per quarter</span>
                  <input name="fq" type="number" step="1" min="0" defaultValue={fq}
                    className="num mt-1 w-full rounded-md border border-rule bg-paper px-2 py-1.5 focus:border-brass focus:outline-none" />
                </label>
                <label className="block">
                  <span className="text-muted">Years held</span>
                  <input name="hz" type="number" step="1" min="1" max="50" defaultValue={hz}
                    className="num mt-1 w-full rounded-md border border-rule bg-paper px-2 py-1.5 focus:border-brass focus:outline-none" />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button type="submit" className="rounded-md bg-ink px-3 py-1.5 text-[14px] font-medium text-white hover:bg-ink/90">Recalculate</button>
                <span className="text-[13px] text-muted">Default is the average of the last four quarters, {money(defaultFq)}.</span>
              </div>
            </form>
          </div>
        </section>
      )}

      <section aria-labelledby="cap-h">
        <h2 id="cap-h" className="font-serif text-2xl">Capital accounts</h2>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">
          Each year, an owner&apos;s account starts where the last one ended, adds money put in and their share of the
          net income, and subtracts what they were paid.
        </p>
        <div className="mt-4 space-y-4">
          {[...ca.years].reverse().map((y) => (
            <div key={y.year} className="rounded-lg border border-rule bg-surface">
              <h3 className="border-b border-rule px-4 py-2.5 font-serif text-lg">{y.year}</h3>
              <CapTable rows={y.rows.map((r) => ({ name: r.name, v: r.real }))} />
              <details className="border-t border-rule">
                <summary className="cursor-pointer px-4 py-2.5 text-[14px] text-muted hover:text-ink">
                  Tax basis for {y.year} (after depreciation, matches the K-1)
                </summary>
                <CapTable rows={y.rows.map((r) => ({ name: r.name, v: r.paper }))} />
              </details>
            </div>
          ))}
          {ca.years.length === 0 && <p className="text-muted">No capital recorded yet.</p>}
        </div>
      </section>

      <section aria-labelledby="hist-h">
        <h2 id="hist-h" className="font-serif text-2xl">Distributions paid</h2>
        {hist.periods.length === 0 ? (
          <p className="mt-3 text-muted">None recorded yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-rule bg-surface">
            <table className="w-full min-w-[480px] text-[15px]">
              <thead>
                <tr className="border-b border-rule text-[13px] text-muted">
                  <th scope="col" className="px-4 py-2 text-left font-normal">Quarter</th>
                  {hist.owners.map((o) => <th key={o} scope="col" className="px-4 py-2 text-right font-normal">{o}</th>)}
                  <th scope="col" className="px-4 py-2 text-right font-normal">Total</th>
                </tr>
              </thead>
              <tbody>
                {hist.periods.map((h) => (
                  <tr key={h.period} className="border-b border-rule last:border-0">
                    <th scope="row" className="px-4 py-2 text-left font-normal">
                      {quarterName(h.period)}
                      {h.paidOn && <span className="block text-[13px] text-muted">Paid {longDate(h.paidOn)}</span>}
                    </th>
                    {hist.owners.map((o) => <td key={o} className="num px-4 py-2 text-right">{money(h.byOwner[o] ?? 0)}</td>)}
                    <td className="num px-4 py-2 text-right font-medium">{money(h.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Step({ label, note, value, strong, final }: { label: string; note?: string; value: number; strong?: boolean; final?: boolean }) {
  return (
    <li className={`flex items-start justify-between gap-4 px-4 py-3 ${final ? 'bg-paid-wash/50' : strong ? 'bg-wash/50' : ''}`}>
      <div className="min-w-0">
        <p className={strong ? 'font-medium' : ''}>{label}</p>
        {note && <p className="mt-0.5 text-[13px] text-muted">{note}</p>}
      </div>
      <p className={`num shrink-0 ${strong ? 'font-medium' : ''} ${final ? 'font-serif text-xl text-paid' : ''} ${value < 0 && !strong ? 'text-muted' : ''}`}>
        {money(value || 0)}
      </p>
    </li>
  )
}

function CapTable({ rows }: { rows: { name: string; v: OwnerYear }[] }) {
  const sum = (k: keyof OwnerYear) => rows.reduce((t, r) => t + r.v[k], 0)
  const cols: [keyof OwnerYear, string][] = [
    ['beginning', 'Start of year'], ['contributions', 'Put in'], ['netIncome', 'Share of net income'],
    ['distributions', 'Paid out'], ['ending', 'End of year'],
  ]
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-[14px]">
        <thead>
          <tr className="text-[13px] text-muted">
            <th scope="col" className="px-4 py-2 text-left font-normal">Owner</th>
            {cols.map(([k, l]) => <th key={k} scope="col" className="px-4 py-2 text-right font-normal">{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-rule">
              <th scope="row" className="px-4 py-2 text-left font-normal">{r.name}</th>
              {cols.map(([k]) => (
                <td key={k} className={`num px-4 py-2 text-right ${k === 'ending' ? 'font-medium' : ''}`}>{money(r.v[k])}</td>
              ))}
            </tr>
          ))}
          {rows.length > 1 && (
            <tr className="border-t border-rule bg-wash/40">
              <th scope="row" className="px-4 py-2 text-left font-medium">Total</th>
              {cols.map(([k]) => <td key={k} className="num px-4 py-2 text-right font-medium">{money(sum(k))}</td>)}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function trimPct(n: number) {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '')}%`
}
