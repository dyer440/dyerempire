// app/real-estate/[id]/periods/[period]/page.tsx  (UPDATED — editable distribution total on Record)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getUserRole, canAccessProperty, canEdit } from '@/lib/access'
import { computeQuarter, quarterBounds, isValidPeriod } from '@/lib/distributions'
import { closePeriod, reopenPeriod } from '../../../recurring/actions'
import { recordDistribution, clearDistribution } from '../../../distributions/actions'

export default async function PeriodDetailPage({
  params,
}: {
  params: Promise<{ id: string; period: string }>
}) {
  await auth.protect()
  await initDb()
  const { id, period } = await params
  const propertyId = Number(id)
  if (!isValidPeriod(period)) redirect(`/real-estate/${propertyId}/periods`)

  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!(await canAccessProperty(email, role, propertyId))) redirect('/real-estate')
  if (!canEdit(role)) redirect(`/real-estate/${propertyId}`)

  const prop = (await sql`SELECT id, name, holding_entity FROM properties WHERE id = ${propertyId} LIMIT 1`) as
    { id: number; name: string; holding_entity: string }[]
  if (prop.length === 0) redirect('/real-estate')

  const c = await computeQuarter(propertyId, period)
  const { start, end, label } = quarterBounds(period)

  const closedRow = (await sql`SELECT label FROM period_closes WHERE property_id = ${propertyId} AND label = ${period}`) as { label: string }[]
  const isClosed = closedRow.length > 0

  const recorded = (await sql`
    SELECT d.amount, d.owner_id, o.name FROM distributions d JOIN owners o ON o.id = d.owner_id
    WHERE d.property_id = ${propertyId} AND d.period = ${period}
    ORDER BY d.amount DESC
  `) as { amount: string; owner_id: number; name: string }[]
  const isRecorded = recorded.length > 0
  const recordedTotal = recorded.reduce((s, r) => s + parseFloat(r.amount), 0)

  const fmt = (n: number) => `$${n.toFixed(2)}`
  const shortDate = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const Row = ({ label: l, value, tone, dim }: { label: string; value: string; tone?: string; dim?: boolean }) => (
    <div className={`flex justify-between py-2 text-sm ${dim ? 'text-white/40' : 'text-white/70'}`}>
      <span>{l}</span>
      <span className={tone} style={{ fontFamily: 'Georgia, serif' }}>{value}</span>
    </div>
  )

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl tracking-[0.3em] uppercase" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
              {label}
            </h1>
            <p className="text-white/30 text-xs tracking-widest uppercase mt-1">
              {prop[0].name} · {prop[0].holding_entity}
            </p>
            <p className="text-white/40 text-xs mt-1">{start} → {end}{isClosed ? ' · 🔒 closed' : ''}</p>
          </div>
          <Link href={`/real-estate/${propertyId}/periods`} className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
            ← Periods
          </Link>
        </div>

        {/* P&L */}
        <div className="border border-white/10 p-6 mb-6">
          <div className="text-white/30 text-xs tracking-widest uppercase mb-3">Quarter P&amp;L (actuals)</div>
          <Row label="Income" value={fmt(c.income)} tone="text-emerald-400" />
          <Row label="Operating expenses" value={`(${fmt(c.opExpense)})`} tone="text-rose-400" />
          <Row label="Tax / insurance paid" value={`(${fmt(c.reservedExpense)})`} tone="text-rose-400" />
          <div className="border-t border-white/10 my-1" />
          <Row label="Net" value={fmt(c.allInNet)} tone={c.allInNet >= 0 ? 'text-emerald-400' : 'text-amber-400'} />
          <Row label="Net before tax/insurance (operating)" value={fmt(c.operatingNet)} dim />
        </div>

        {/* Reserve */}
        <div className="border border-dashed border-amber-400/30 p-6 mb-6">
          <div className="text-amber-400/70 text-xs tracking-widest uppercase mb-3">Tax / insurance reserve</div>
          <Row label="Annual target (tax + insurance est.)" value={fmt(c.annualReserve)} dim />
          <Row label="This quarter's reserve set-aside" value={`(${fmt(c.reserveTargetQuarter)})`} tone="text-amber-400/80" />
          <div className="border-t border-white/10 my-1" />
          <Row label={`Reserve accrued YTD (×${c.q})`} value={fmt(c.reserveAccrued)} dim />
          <Row label="Tax / insurance paid YTD" value={`(${fmt(c.reservedPaidYtd)})`} dim />
          <Row label="Reserve balance" value={fmt(c.reserveBalance)} tone={c.reserveBalance >= 0 ? 'text-emerald-400' : 'text-red-400'} />
          {c.reserveBalance < 0 && (
            <p className="text-[11px] text-red-400/70 mt-2">
              Under-reserved: tax/insurance paid YTD exceeds what's been set aside — this is the cash pinch. Funding
              the quarterly set-aside ahead of the bill smooths it.
            </p>
          )}
        </div>

        {/* Forward runway — "safe to distribute today" */}
        <div className="border border-emerald-400/20 p-6 mb-6">
          <div className="text-emerald-400/50 text-xs tracking-widest uppercase mb-3">Runway to next reserve bill</div>
          <Row label={`Retained cash (YTD all-in NOI, net of tax paid${c.distributedYtd > 0 ? ' & distributions' : ''})`} value={fmt(c.retainedCash)} dim />
          <Row label={`+ Scheduled NOI until ${c.nextReserveBillDate ? shortDate(c.nextReserveBillDate) : 'next bill'}`} value={`+${fmt(c.forwardNoi)}`} tone="text-emerald-400/70" />
          <Row label="− Upcoming tax/insurance" value={`(${fmt(c.upcomingReserve)})`} tone="text-amber-400/80" />
          <div className="border-t border-white/10 my-1" />
          <Row label="Projected cash after the bill" value={fmt(c.projectedCashAfterBill)} tone={c.projectedCashAfterBill >= 0 ? 'text-white/60' : 'text-red-400'} />
          <div className="border-t border-white/10 my-1" />
          <Row label="Safe to distribute today" value={fmt(c.runwayDistributable)} tone={c.runwayDistributable > 0 ? 'text-emerald-400' : 'text-white/50'} />
          <p className="text-[11px] text-white/40 mt-3 leading-relaxed">
            {c.reserveShortfall > 0
              ? `Incoming rent covers all but ${fmt(c.reserveShortfall)} of the next bill, so that much is held back from your retained cash.`
              : `Incoming scheduled rent fully covers the next tax/insurance bill, so your retained cash is free to distribute.`}{' '}
            Capped at retained cash — never distributes rent you haven&apos;t collected. Assumes scheduled rent arrives; leaves {fmt(c.projectedCashAfterBill)} after the bill.
          </p>
        </div>

        {/* Distributable + split */}
        <div className="border border-white/10 p-6 mb-6">
          <div className="text-white/30 text-xs tracking-widest uppercase mb-3">Owner split</div>
          <div className="mt-1 space-y-1">
            {c.split.map((s) => (
              <div key={s.owner_id} className="flex justify-between text-sm">
                <span className="text-white/70">{s.name} <span className="text-white/30">· {s.pct.toFixed(2)}%</span></span>
                <span className="text-white/80" style={{ fontFamily: 'Georgia, serif' }}>{fmt(s.amount)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-white/5 mt-3 pt-3 space-y-1">
            <Row label="Single-quarter cash basis (holds full next bill)" value={fmt(c.distributableCash)} dim />
            <Row label="Smoothed accrual (annual ÷ 4)" value={fmt(c.distributable)} dim />
          </div>
          <p className="text-[11px] text-white/40 mt-3">
            Split is of the runway figure above. The two references show the more conservative single-quarter views.
          </p>
        </div>

        {/* Recorded distribution status */}
        {isRecorded && (
          <div className="border border-emerald-400/20 p-6 mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-emerald-400/70 text-xs tracking-widest uppercase">Recorded distribution</span>
              <span className="text-white/50 text-xs" style={{ fontFamily: 'Georgia, serif' }}>total {fmt(recordedTotal)}</span>
            </div>
            {recorded.map((r) => (
              <div key={r.owner_id} className="flex justify-between text-sm">
                <span className="text-white/70">{r.name}</span>
                <span className="text-white/80" style={{ fontFamily: 'Georgia, serif' }}>{fmt(parseFloat(r.amount))}</span>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-end gap-3">
          {!isRecorded ? (
            <form action={recordDistribution} className="flex items-end gap-2">
              <input type="hidden" name="property_id" value={propertyId} />
              <input type="hidden" name="period" value={period} />
              <div>
                <label className="block text-[10px] text-white/30 tracking-widest uppercase mb-1">Distribution total</label>
                <input name="amount" type="number" step="0.01" min="0" defaultValue={Math.max(c.runwayDistributable, 0).toFixed(2)}
                  className="w-32 bg-white/5 border border-white/20 px-3 py-1.5 text-white text-sm focus:outline-none focus:border-white/50" />
              </div>
              <button type="submit"
                className="border border-emerald-400/30 text-emerald-400/80 px-5 py-2 text-xs tracking-widest uppercase hover:bg-emerald-400/10 transition-all">
                Record distribution
              </button>
            </form>
          ) : (
            <form action={clearDistribution}>
              <input type="hidden" name="property_id" value={propertyId} />
              <input type="hidden" name="period" value={period} />
              <button type="submit" className="border border-white/20 text-white/50 px-5 py-2 text-xs tracking-widest uppercase hover:bg-white/10 transition-all">
                Clear distribution
              </button>
            </form>
          )}

          {!isClosed ? (
            <form action={closePeriod}>
              <input type="hidden" name="property_id" value={propertyId} />
              <input type="hidden" name="label" value={period} />
              <input type="hidden" name="period_start" value={start} />
              <input type="hidden" name="period_end" value={end} />
              <button type="submit" className="border border-white/30 px-5 py-2 text-xs tracking-widest uppercase hover:bg-white/10 transition-all">
                Close quarter
              </button>
            </form>
          ) : (
            <form action={reopenPeriod}>
              <input type="hidden" name="property_id" value={propertyId} />
              <input type="hidden" name="label" value={period} />
              <button type="submit" className="border border-amber-400/30 text-amber-400/70 px-5 py-2 text-xs tracking-widest uppercase hover:bg-amber-400/10 transition-all">
                Reopen quarter
              </button>
            </form>
          )}
        </div>
        <p className="text-[11px] text-white/25 mt-4">
          The distribution total defaults to the smoothed distributable. Override it to match an actual distribution —
          e.g. for history where you held back a specific bill — and it’s split by ownership %. Record, then close.
        </p>
      </div>
    </main>
  )
}
