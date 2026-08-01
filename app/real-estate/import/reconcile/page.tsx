// app/real-estate/import/reconcile/page.tsx
// Fee reconciliation (read-only). Municipal/utility micro-fees (Huntington
// Sanitary $7.15, City of Huntington refuse $60, fire fees) are paid from the
// SL Cap Mgmt checking account but must land on each property's Schedule E.
// Because they're tiny and identical across properties, they're easy to miss —
// this view compares what the BANK paid against what's BOOKED in the ledger, so
// the gap (fees paid but never entered) is visible instead of silently dropped.
//
// It reads bank_txns (all statuses) against transactions; it changes nothing.
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default async function ReconcilePage() {
  const editor = await getEditorEmail()
  if (!editor) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">Fee reconciliation</h1>
        <p className="text-gray-600">You need editor access to view this.</p>
      </div>
    )
  }

  // Bank side: fee debits (Huntington Sanitary + City of Huntington), by month.
  const bankByMonth = (await sql`
    SELECT to_char(b.txn_date, 'YYYY-MM') AS month,
           count(*)::int AS n,
           sum(ABS(b.amount))::float8 AS paid
    FROM bank_txns b
    WHERE b.amount < 0
      AND (b.name_norm ILIKE '%HUNTINGTON SANIT%'
        OR b.name_norm ILIKE '%CITY OF HUNTINGTON%')
    GROUP BY 1 ORDER BY 1
  `) as Record<string, any>[]

  // Ledger side: booked fee ACTUALS, by month (municipal/sanitary/refuse/fire/stormwater).
  const bookedByMonth = (await sql`
    SELECT to_char(t.txn_date, 'YYYY-MM') AS month,
           count(*)::int AS n,
           sum(t.amount)::float8 AS booked
    FROM transactions t
    WHERE t.type = 'expense' AND t.status = 'actual'
      AND (t.category ILIKE '%municipal%' OR t.category ILIKE '%sanitary%'
        OR t.category ILIKE '%refuse%' OR t.category ILIKE '%fire%'
        OR t.description ILIKE '%stormwater%' OR t.description ILIKE '%sanitary%'
        OR t.description ILIKE '%refuse%' OR t.description ILIKE '%municipal%')
    GROUP BY 1 ORDER BY 1
  `) as Record<string, any>[]

  const months = new Map<string, { paid: number; nPaid: number; booked: number; nBooked: number }>()
  for (const r of bankByMonth) {
    const m = months.get(r.month) || { paid: 0, nPaid: 0, booked: 0, nBooked: 0 }
    m.paid = r.paid; m.nPaid = r.n; months.set(r.month, m)
  }
  for (const r of bookedByMonth) {
    const m = months.get(r.month) || { paid: 0, nPaid: 0, booked: 0, nBooked: 0 }
    m.booked = r.booked; m.nBooked = r.n; months.set(r.month, m)
  }
  const rows = [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const totalPaid = rows.reduce((s, [, m]) => s + m.paid, 0)
  const totalBooked = rows.reduce((s, [, m]) => s + m.booked, 0)

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Fee reconciliation</h1>
        <p className="text-sm text-gray-500">
          Municipal &amp; sanitary fees paid from the checking account vs. what&apos;s booked to
          properties. A positive gap = fees paid but not yet entered.{' '}
          <Link href="/real-estate/import" className="underline">Back to import</Link>
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="border rounded p-4">
          <div className="text-xs uppercase text-gray-500">Paid (bank)</div>
          <div className="text-xl font-semibold">{money(totalPaid)}</div>
        </div>
        <div className="border rounded p-4">
          <div className="text-xs uppercase text-gray-500">Booked (ledger)</div>
          <div className="text-xl font-semibold">{money(totalBooked)}</div>
        </div>
        <div className="border rounded p-4">
          <div className="text-xs uppercase text-gray-500">Unbooked gap</div>
          <div className={`text-xl font-semibold ${totalPaid - totalBooked > 0.5 ? 'text-amber-600' : ''}`}>
            {money(totalPaid - totalBooked)}
          </div>
        </div>
      </div>

      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-gray-500 border-b">
              <th className="p-2">Month</th>
              <th className="p-2 text-right">Paid (bank)</th>
              <th className="p-2 text-right">Booked (ledger)</th>
              <th className="p-2 text-right">Gap</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([month, m]) => {
              const gap = m.paid - m.booked
              return (
                <tr key={month} className="border-t">
                  <td className="p-2 whitespace-nowrap">{month}</td>
                  <td className="p-2 text-right">{money(m.paid)} <span className="text-gray-400">({m.nPaid})</span></td>
                  <td className="p-2 text-right">{money(m.booked)} <span className="text-gray-400">({m.nBooked})</span></td>
                  <td className={`p-2 text-right font-medium ${gap > 0.5 ? 'text-amber-600' : gap < -0.5 ? 'text-red-600' : 'text-gray-400'}`}>
                    {money(gap)}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-gray-500">No fee activity found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500">
        The gap is not tied to a single property here (the $7.15 and $60 fees are identical across
        houses). Use the amount-identified fire fees plus the per-property fee schedules to place the
        unbooked ones; the importer&apos;s rules pre-fill the amount-identified ones automatically.
      </p>
    </div>
  )
}
