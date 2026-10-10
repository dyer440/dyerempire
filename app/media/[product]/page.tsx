// app/media/[product]/page.tsx
// One SL Media publication: what came in each month, the split, and what has
// been paid out. Matt Warder (page_access media-tct) sees the same math as
// David, except where SL Media's own share went afterwards.
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getSiteUser, canSee, landingFor } from '@/lib/viewer'
import { productLedger, SOURCE_LABEL, PAYMENT_LIMIT, type Month } from '@/lib/media'
import { money, longDate, shortDate, monthName } from '@/lib/format'

/** Differences under a dollar are cents of rounding from the old spreadsheet, not money owed. */
const ROUNDING = 1

export default async function MediaProduct({ params }: { params: Promise<{ product: string }> }) {
  const { product: slug } = await params
  const u = await getSiteUser()
  if (!canSee(u, `media-${slug}`)) redirect(landingFor(u))
  const r = await productLedger(slug)
  if (!r) notFound()
  const { product: p, ledger: L } = r
  const insider = u.insider
  const hasPartner = p.owner_pct < 100
  const partnerPct = 100 - p.owner_pct
  const partnerShort = p.partner_name?.replace(/\s*\(.*\)$/, '').replace(/,?\s+LLC$/, '') || 'Partner'
  const current = L.months[0]

  return (
    <main className="space-y-12">
      <header>
        {insider && <Link href="/real-estate/companies/sl-media" className="text-[14px] text-muted hover:text-ink">SL Media</Link>}
        <h1 className="mt-1 font-serif text-4xl font-medium tracking-tight sm:text-5xl">{p.name}</h1>
        <p className="mt-3 max-w-2xl text-[15px] text-muted">
          {hasPartner
            ? <>Subscriber money from {p.sources.map((s) => SOURCE_LABEL[s] ?? s).join(' and ')} lands in SL Media&apos;s account. {p.partner_name} receives {fmtPct(partnerPct)} and SL Media keeps {fmtPct(p.owner_pct)}. Payments go out by Zelle, at most {money(PAYMENT_LIMIT).replace('.00', '')} at a time.</>
            : <>Payments from {SOURCE_LABEL[p.sources[0]] ?? p.sources[0]} to SL Media. All of it belongs to SL Media.</>}
        </p>
      </header>

      <section aria-labelledby="now-h" className="grid gap-4 md:grid-cols-2">
        <h2 id="now-h" className="sr-only">Where things stand</h2>
        {hasPartner && (
          <div className={`rounded-lg border p-5 ${L.totals.partnerDue >= ROUNDING ? 'border-due/40 bg-due-wash/40' : 'border-rule bg-surface'}`}>
            <p className="text-[15px] text-muted">Owed to {partnerShort} now</p>
            <p className="num mt-1 font-serif text-4xl">{money(L.totals.partnerDue >= ROUNDING ? L.totals.partnerDue : 0)}</p>
            <p className="mt-2 text-[14px] text-ink/80">
              {L.totals.partnerDue >= ROUNDING
                ? <>Next payments: {L.nextPartnerPayments.map((x) => money(x)).join(', ')}.</>
                : L.partnerCredit > 0.004
                  ? <>Paid {money(L.partnerCredit)} ahead. That goes toward next month.</>
                  : <>Paid in full{current ? ` through ${monthName(current.period, true)}` : ''}{Math.abs(L.totals.partnerDue) >= 0.005 ? `, give or take ${money(Math.abs(L.totals.partnerDue))} of rounding` : ''}.</>}
            </p>
          </div>
        )}
        {insider && (
          <div className={`rounded-lg border p-5 ${L.totals.ownerDue > 0.004 ? 'border-due/40 bg-due-wash/40' : 'border-rule bg-surface'}`}>
            <p className="text-[15px] text-muted">SL Media&apos;s share not yet moved to {p.owner_destination}</p>
            <p className="num mt-1 font-serif text-4xl">{money(Math.max(L.totals.ownerDue, 0))}</p>
            <p className="mt-2 text-[14px] text-ink/80">
              {L.ownerCredit > 0.004 ? <>Moved {money(L.ownerCredit)} more than the {fmtPct(p.owner_pct)} so far.</> : L.totals.ownerDue > 0.004 ? 'Move it when convenient.' : 'All moved.'}
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="months-h">
        <h2 id="months-h" className="font-serif text-2xl">Month by month</h2>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">
          Payments are applied to the oldest month still owed. Open a month to see each deposit and payment.
        </p>
        <div className="mt-4 overflow-hidden rounded-lg border border-rule bg-surface">
          <div className={`hidden gap-3 border-b border-rule px-4 py-2 text-[13px] text-muted md:grid ${gridCols(hasPartner, insider)}`} aria-hidden>
            <span>Month</span><span className="text-right">Revenue</span>
            {hasPartner && <><span className="text-right">{partnerShort} {fmtPct(partnerPct)}</span><span className="text-right">Paid</span><span className="text-right">Still owed</span></>}
            {insider && <><span className="text-right">SL Media {fmtPct(p.owner_pct)}</span><span className="text-right">Moved</span></>}
          </div>
          {L.months.length === 0 && <p className="px-4 py-6 text-muted">Nothing recorded yet.</p>}
          {L.months.map((m) => <MonthRow key={m.period} m={m} hasPartner={hasPartner} insider={insider} partnerShort={partnerShort} sources={p.sources} />)}
        </div>
      </section>

      <section aria-labelledby="years-h">
        <h2 id="years-h" className="font-serif text-2xl">By calendar year</h2>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">
          Counted by the date money moved, which is how taxes see it.{hasPartner && ` The amount paid to ${partnerShort} is the 1099-NEC figure.`}
        </p>
        <div className="mt-4 overflow-x-auto rounded-lg border border-rule bg-surface">
          <table className="w-full min-w-[480px] text-[15px]">
            <thead>
              <tr className="border-b border-rule text-[13px] text-muted">
                <th scope="col" className="px-4 py-2 text-left font-normal">Year</th>
                {p.sources.map((s) => <th key={s} scope="col" className="px-4 py-2 text-right font-normal">{SOURCE_LABEL[s] ?? s}</th>)}
                <th scope="col" className="px-4 py-2 text-right font-normal">Received</th>
                {hasPartner && <th scope="col" className="px-4 py-2 text-right font-normal">Paid to {partnerShort}</th>}
                {insider && <th scope="col" className="px-4 py-2 text-right font-normal">Moved to {p.owner_destination}</th>}
              </tr>
            </thead>
            <tbody>
              {L.years.map((y) => (
                <tr key={y.year} className="border-b border-rule last:border-0">
                  <th scope="row" className="px-4 py-2 text-left font-normal">{y.year}</th>
                  {p.sources.map((s) => <td key={s} className="num px-4 py-2 text-right">{money(y.receiptsBySource[s] ?? 0)}</td>)}
                  <td className="num px-4 py-2 text-right font-medium">{money(y.received)}</td>
                  {hasPartner && <td className="num px-4 py-2 text-right font-medium">{money(y.partnerPaid)}</td>}
                  {insider && <td className="num px-4 py-2 text-right">{money(y.ownerPaid)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {insider && (L.unlinked.receipts + L.unlinked.payouts > 0) && (
          <p className="mt-3 text-[13px] text-muted">
            {L.unlinked.receipts + L.unlinked.payouts} entries came from the old spreadsheet or were typed in, and are not yet matched to a bank line.
          </p>
        )}
      </section>
    </main>
  )
}

function gridCols(hasPartner: boolean, insider: boolean) {
  if (hasPartner && insider) return 'md:grid-cols-[1.3fr_1fr_1fr_1fr_1fr_1fr_1fr]'
  if (hasPartner) return 'md:grid-cols-[1.3fr_1fr_1fr_1fr_1fr]'
  return 'md:grid-cols-[1.3fr_1fr_1fr_1fr]'
}

function MonthRow({ m, hasPartner, insider, partnerShort, sources }: {
  m: Month; hasPartner: boolean; insider: boolean; partnerShort: string; sources: string[]
}) {
  const owes = hasPartner && m.partner.due >= ROUNDING
  return (
    <details className="group border-b border-rule last:border-0 open:bg-paper/60">
      <summary className={`grid cursor-pointer list-none grid-cols-1 gap-x-6 sm:grid-cols-2 gap-y-1 px-4 py-3 text-[15px] hover:bg-wash/40 md:items-baseline ${gridCols(hasPartner, insider)}`}>
        <span className="font-medium sm:col-span-2 md:col-span-1">
          <span aria-hidden className="mr-1.5 inline-block text-faint transition-transform group-open:rotate-90">&#9656;</span>
          {monthName(m.period, true)}
        </span>
        <Cell label="Revenue" v={money(m.gross)} />
        {hasPartner && <>
          <Cell label={`${partnerShort} share`} v={money(m.partner.share)} />
          <Cell label="Paid" v={money(m.partner.paid)} />
          <Cell label="Still owed" v={owes ? money(m.partner.due) : 'Paid'} tone={owes ? 'text-due font-medium' : 'text-paid'} />
        </>}
        {insider && <>
          <Cell label="SL Media share" v={money(m.owner.share)} />
          <Cell label="Moved" v={m.owner.due > 0.004 ? `${money(m.owner.paid)}` : 'All'} tone={m.owner.due > 0.004 ? 'text-due' : 'text-paid'} />
        </>}
      </summary>
      <div className="grid gap-6 px-4 pb-5 pt-1 text-[14px] md:grid-cols-2">
        <div>
          <h3 className="mb-1.5 font-medium">Deposits</h3>
          <ul className="space-y-1">
            {m.receipts.map((r) => (
              <li key={r.id} className="flex justify-between gap-3">
                <span>{shortDate(r.date)}, {SOURCE_LABEL[r.source] ?? r.source}{r.note && insider ? <span className="text-muted">, {r.note}</span> : null}</span>
                <span className="num">{money(r.amount)}</span>
              </li>
            ))}
          </ul>
          {sources.length > 1 && (
            <p className="mt-2 text-muted">{sources.map((s) => `${SOURCE_LABEL[s] ?? s} ${money(m.bySource[s] ?? 0)}`).join(', ')}.</p>
          )}
          <p className="mt-2 text-muted">
            {money(m.gross)} total{hasPartner ? `, of which ${money(m.partner.share)} for ${partnerShort} and ${money(m.owner.share)} for SL Media` : ''}.
          </p>
        </div>
        <div className="space-y-4">
          {hasPartner && (
            <div>
              <h3 className="mb-1.5 font-medium">Paid to {partnerShort} for this month</h3>
              {m.partner.payments.length === 0 ? <p className="text-muted">Nothing yet.</p> : (
                <ul className="space-y-1">
                  {m.partner.payments.map((a, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span>{longDate(a.date)}{a.applied < a.amount - 0.004 ? <span className="text-muted">, part of {money(a.amount)}</span> : null}</span>
                      <span className="num">{money(a.applied)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {insider && (
            <div>
              <h3 className="mb-1.5 font-medium">SL Media&apos;s share moved</h3>
              {m.owner.payments.length === 0 ? <p className="text-muted">Nothing yet.</p> : (
                <ul className="space-y-1">
                  {m.owner.payments.map((a, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span>{longDate(a.date)}{a.destination ? `, ${a.destination}` : ''}{a.applied < a.amount - 0.004 ? <span className="text-muted">, part of {money(a.amount)}</span> : null}</span>
                      <span className="num">{money(a.applied)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </details>
  )
}

function Cell({ label, v, tone = '' }: { label: string; v: string; tone?: string }) {
  return (
    <span className={`num flex justify-between gap-2 md:block md:text-right ${tone}`}>
      <span className="text-[13px] text-muted md:hidden">{label}</span>
      <span>{v}</span>
    </span>
  )
}

function fmtPct(n: number) {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '')}%`
}
