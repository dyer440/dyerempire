// app/real-estate/close/page.tsx
// Quarter Close & Distribute — the quarterly workflow in one place, for the
// partner (PE) properties. Per quarter it shows:
//   1. SL CAP MGMT CASH REQUIREMENT — upcoming scheduled tax/insurance across
//      ALL properties (taxes are PAID FROM the SLCM checking account, so this is
//      the cash that must STAY there before sweeping distributions).
//   2. Per PE property: the quarter's P&L (via computeQuarter), audit flags
//      (possible duplicates, pending bank rows, months with no rent), the owner
//      split, and the record-distribution / close-period actions.
// Editors only. Builds entirely on existing machinery: computeQuarter,
// recordDistribution, closePeriod.
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { computeQuarter, quarterBounds, isValidPeriod } from '@/lib/distributions'
import { wsRecordDistribution, wsClearDistribution, wsClosePeriod, wsReopenPeriod } from './actions'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function currentQuarterLabel(): string {
  const d = new Date()
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
}
function shiftQuarter(label: string, delta: number): string {
  const [y, qs] = label.split('-Q')
  let year = Number(y), q = Number(qs) + delta
  while (q < 1) { q += 4; year-- }
  while (q > 4) { q -= 4; year++ }
  return `${year}-Q${q}`
}
function prevQuarterLabel(): string {
  return shiftQuarter(currentQuarterLabel(), -1)
}

export default async function QuarterClosePage({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string }> | { period?: string }
}) {
  const editor = await getEditorEmail()
  if (!editor) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <h1 className="text-xl font-semibold text-gray-900">Quarter close</h1>
        <p className="text-sm text-gray-500 mt-1">You need editor access to use this.</p>
      </div>
    )
  }

  const sp = (await searchParams) || {}
  // Default to the most recently COMPLETED quarter — that's what gets closed.
  const period = isValidPeriod(sp.period || '') ? (sp.period as string) : prevQuarterLabel()
  const { start, end } = quarterBounds(period)

  // PE properties = more than one owner on the cap table.
  const peProps = (await sql`
    SELECT p.id, p.name FROM properties p
    WHERE p.status = 'active'
      AND (SELECT COUNT(*) FROM property_owners po WHERE po.property_id = p.id) > 1
    ORDER BY p.name
  `) as { id: number; name: string }[]

  // ── 1. SLCM cash requirement: upcoming scheduled tax/insurance, ALL props ──
  const upcoming = (await sql`
    SELECT p.name AS property, t.category, t.amount::float8 AS amount,
           to_char(t.txn_date, 'YYYY-MM-DD') AS due
    FROM transactions t JOIN properties p ON p.id = t.property_id
    WHERE t.status = 'forecast'
      AND t.category IN ('Property Taxes', 'Insurance')
      AND t.txn_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '6 months')
    ORDER BY t.txn_date, p.name
  `) as { property: string; category: string; amount: number; due: string }[]
  const retention = upcoming.reduce((s, u) => s + u.amount, 0)

  // ── 2. Per PE property: computation + audit flags + recorded state ──────────
  const sections = await Promise.all(
    peProps.map(async (p) => {
      const c = await computeQuarter(p.id, period)

      // Audit flag A: same amount+type booked 2+ times within 10 days in the quarter.
      const dupes = (await sql`
        SELECT a.id AS id_a, b.id AS id_b, a.amount::float8 AS amount, a.type,
               to_char(a.txn_date,'YYYY-MM-DD') AS date_a, to_char(b.txn_date,'YYYY-MM-DD') AS date_b,
               a.description AS desc_a, b.description AS desc_b
        FROM transactions a JOIN transactions b
          ON b.property_id = a.property_id AND b.id > a.id
         AND b.amount = a.amount AND b.type = a.type
         AND ABS(b.txn_date - a.txn_date) <= 10
        WHERE a.property_id = ${p.id} AND a.status = 'actual' AND b.status = 'actual'
          AND a.txn_date BETWEEN ${start} AND ${end}
          AND COALESCE(a.is_deposit, FALSE) = FALSE AND COALESCE(b.is_deposit, FALSE) = FALSE
        ORDER BY a.txn_date
      `) as Record<string, any>[]

      // Audit flag B: months in the quarter with no rent income at all.
      const rentMonths = (await sql`
        SELECT DISTINCT to_char(t.txn_date, 'YYYY-MM') AS m
        FROM transactions t
        WHERE t.property_id = ${p.id} AND t.type = 'income' AND t.status = 'actual'
          AND t.category ILIKE '%rent%' AND COALESCE(t.is_deposit, FALSE) = FALSE
          AND t.txn_date BETWEEN ${start} AND ${end}
      `) as { m: string }[]
      const have = new Set(rentMonths.map(r => r.m))
      const y = Number(period.slice(0, 4)), q = Number(period.slice(6))
      const qMonths = [0, 1, 2].map(i => `${y}-${String((q - 1) * 3 + i + 1).padStart(2, '0')}`)
      const noRentMonths = qMonths.filter(m => !have.has(m))

      // Audit flag C: bank rows still pending inside the quarter window.
      const pendingBank = (await sql`
        SELECT COUNT(*)::int AS n FROM bank_txns
        WHERE status = 'pending' AND txn_date BETWEEN ${start} AND ${end}
      `) as { n: number }[]

      const recorded = (await sql`
        SELECT o.name, d.amount::float8 AS amount
        FROM distributions d JOIN owners o ON o.id = d.owner_id
        WHERE d.property_id = ${p.id} AND d.period = ${period}
        ORDER BY d.amount DESC
      `) as { name: string; amount: number }[]

      const closed = (await sql`
        SELECT 1 FROM period_closes WHERE property_id = ${p.id} AND label = ${period} LIMIT 1
      `) as Record<string, any>[]

      return { p, c, dupes, noRentMonths, pendingBank: pendingBank[0]?.n ?? 0, recorded, isClosed: closed.length > 0 }
    }),
  )

  const anyPendingBank = sections.some(s => s.pendingBank > 0)

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Quarter close &amp; distribute</h1>
          <p className="text-sm text-gray-500">
            Review each partner property, hold back the SL Cap Mgmt tax/insurance cash, record distributions, close the quarter.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href={`?period=${shiftQuarter(period, -1)}`} className="rounded-full border border-gray-300 px-3 py-1 hover:bg-gray-100">← {shiftQuarter(period, -1)}</Link>
          <span className="font-semibold text-gray-900 tabular-nums">{period}</span>
          <Link href={`?period=${shiftQuarter(period, 1)}`} className="rounded-full border border-gray-300 px-3 py-1 hover:bg-gray-100">{shiftQuarter(period, 1)} →</Link>
        </div>
      </div>

      {/* 1 · SLCM cash requirement */}
      <div className="rounded border border-amber-300 bg-amber-50 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-amber-900">
            Keep in SL Cap Mgmt checking before sweeping
          </h2>
          <div className="text-xl font-semibold text-amber-900 tabular-nums">{money(retention)}</div>
        </div>
        <p className="text-xs text-amber-800/80 mt-1">
          Scheduled tax &amp; insurance across all properties, next 6 months — these are paid from the SLCM account.
        </p>
        {upcoming.length > 0 ? (
          <table className="mt-2 w-full text-xs">
            <tbody>
              {upcoming.map((u, i) => (
                <tr key={i} className="border-t border-amber-200/60">
                  <td className="py-1 text-amber-900/80">{u.due}</td>
                  <td className="py-1">{u.property}</td>
                  <td className="py-1">{u.category}</td>
                  <td className="py-1 text-right tabular-nums">{money(u.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-amber-800 mt-2">
            No scheduled tax/insurance found in the next 6 months — if that seems wrong, check the schedules and Regenerate.
          </p>
        )}
      </div>

      {anyPendingBank && (
        <div className="rounded border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900">
          There are unassigned bank rows dated inside {period} —{' '}
          <Link href="/real-estate/import" className="underline">finish the import</Link> before closing so the quarter is complete.
        </div>
      )}

      {/* 2 · Per PE property */}
      {sections.map(({ p, c, dupes, noRentMonths, recorded, isClosed }) => (
        <div key={p.id} className="rounded border border-gray-200">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold text-gray-900">{p.name}</h2>
              {isClosed && (
                <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">Closed</span>
              )}
              {c.flipActive && (
                <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">50/50 flip active</span>
              )}
            </div>
            <Link href={`/real-estate/${p.id}/periods/${period}`} className="text-xs text-blue-700 hover:underline">
              Full period detail →
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-4 text-sm">
            <div><div className="text-[10px] uppercase text-gray-400">Income</div><div className="font-medium tabular-nums">{money(c.income)}</div></div>
            <div><div className="text-[10px] uppercase text-gray-400">Operating exp.</div><div className="font-medium tabular-nums">{money(c.opExpense)}</div></div>
            <div><div className="text-[10px] uppercase text-gray-400">Tax/Ins paid</div><div className="font-medium tabular-nums">{money(c.reservedExpense)}</div></div>
            <div><div className="text-[10px] uppercase text-gray-400">Operating net</div>
              <div className={`font-semibold tabular-nums ${c.operatingNet < 0 ? 'text-red-600' : ''}`}>{money(c.operatingNet)}</div>
            </div>
          </div>
          {c.scheduledIncluded && (
            <p className="px-4 pb-2 text-[11px] text-amber-600">
              Includes {money(Math.abs(c.scheduledNet))} of still-scheduled items — confirm them before closing.
            </p>
          )}

          {/* Audit flags */}
          {(dupes.length > 0 || noRentMonths.length > 0) && (
            <div className="mx-4 mb-3 rounded border border-orange-200 bg-orange-50 p-3 text-xs text-orange-900 space-y-1">
              {dupes.map((d, i) => (
                <div key={i}>
                  Possible duplicate: id{d.id_a} ({d.date_a}, “{d.desc_a}”) and id{d.id_b} ({d.date_b}, “{d.desc_b}”) — both {d.type} {money(d.amount)}.
                </div>
              ))}
              {noRentMonths.length > 0 && (
                <div>No rent recorded for: {noRentMonths.join(', ')} — vacancy, or missing entries?</div>
              )}
            </div>
          )}

          {/* Distribution */}
          <div className="border-t border-gray-100 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <span className="text-gray-500">Owner split{c.flipActive ? ' (50/50)' : ''}: </span>
                {c.split.map((s: { owner_id: number; name: string; pct: number; amount: number }) => (
                  <span key={s.owner_id} className="mr-3">{s.name} <span className="text-gray-400">{s.pct.toFixed(1)}%</span></span>
                ))}
              </div>
              {recorded.length > 0 ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className="rounded bg-emerald-50 border border-emerald-200 px-2 py-1 text-emerald-800">
                    Recorded: {recorded.map(r => `${r.name} ${money(r.amount)}`).join(' · ')}
                  </span>
                  {!isClosed && (
                    <form action={wsClearDistribution}>
                      <input type="hidden" name="property_id" value={p.id} />
                      <input type="hidden" name="period" value={period} />
                      <button type="submit" className="text-xs text-red-600 hover:underline">clear</button>
                    </form>
                  )}
                </div>
              ) : (
                <form action={wsRecordDistribution} className="flex items-end gap-2 text-sm">
                  <input type="hidden" name="property_id" value={p.id} />
                  <input type="hidden" name="period" value={period} />
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[10px] uppercase text-gray-400">Total to distribute</span>
                    <input name="amount" type="number" step="0.01" min="0" placeholder="0.00"
                           className="w-32 rounded border border-gray-300 px-2 py-1 text-right tabular-nums" />
                  </label>
                  <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-white text-xs hover:bg-gray-700">
                    Record split
                  </button>
                </form>
              )}
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Enter the total; it splits {c.flipActive ? '50/50' : 'by ownership %'}. An explicit 0 records a “no distribution” quarter.
            </p>
          </div>

          {/* Close / reopen */}
          <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between">
            <p className="text-[11px] text-gray-400 max-w-md">
              Closing locks {period} (edits blocked, leftover forecasts cleared). Record the distribution first —
              clearing needs the period open.
            </p>
            {isClosed ? (
              <form action={wsReopenPeriod}>
                <input type="hidden" name="property_id" value={p.id} />
                <input type="hidden" name="label" value={period} />
                <button type="submit" className="rounded border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-100">
                  Reopen {period}
                </button>
              </form>
            ) : (
              <form action={wsClosePeriod}>
                <input type="hidden" name="property_id" value={p.id} />
                <input type="hidden" name="label" value={period} />
                <input type="hidden" name="period_start" value={start} />
                <input type="hidden" name="period_end" value={end} />
                <button type="submit" className="rounded bg-gray-900 px-4 py-1.5 text-xs text-white hover:bg-gray-700">
                  Close {period}
                </button>
              </form>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
