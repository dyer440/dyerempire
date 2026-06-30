// app/real-estate/southside/page.tsx
// "Southside Properties" — the bank-reconciliation / entry workspace.
// One list across EVERY property, mirroring the shared Southside checking
// statement Betsy works from. Editor-only (admin/manager). Zach (partner)
// is redirected and it never appears in his nav.
//
// NOTE: this is a banking/management view, not an ownership entity. It exists
// so cross-property entry doesn't clutter the per-property pages.
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import LedgerView, { LedgerRow } from '@/app/real-estate/_components/LedgerView'

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default async function SouthsidePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>> | Record<string, string | undefined>
}) {
  await initDb()
  const editor = await getEditorEmail()
  if (!editor) redirect('/real-estate')

  const sp = (await searchParams) || {}
  const now = new Date()
  const fromDefault = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1))
  const toDefault = ymd(new Date(now.getFullYear(), now.getMonth() + 13, 0))
  const from = sp.from || fromDefault
  const to = sp.to || toDefault

  const properties = (await sql`
    SELECT id, name FROM properties WHERE status = 'active' ORDER BY name
  `) as Record<string, any>[]

  const rows = (await sql`
    SELECT t.id, t.property_id, p.name AS property_name, t.type, t.category,
           t.amount::float8 AS amount, to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date,
           t.description, t.status,
           EXISTS (
             SELECT 1 FROM period_closes pc
             WHERE pc.property_id = t.property_id AND t.txn_date BETWEEN pc.period_start AND pc.period_end
           ) AS locked
    FROM transactions t JOIN properties p ON p.id = t.property_id
    WHERE p.status = 'active'
      AND t.txn_date >= ${from}::date AND t.txn_date <= ${to}::date
      AND (t.status = 'actual' OR (t.status = 'forecast' AND t.txn_date >= date_trunc('month', CURRENT_DATE)))
    ORDER BY t.txn_date ASC, p.name ASC, t.id ASC
  `) as Record<string, any>[]

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Southside Properties — Entry &amp; reconciliation</h1>
          <p className="text-sm text-gray-500">
            Every property in one list, in date order — matched to the Southside checking statement.
            Confirm scheduled items as they clear, or add new ones. Tag each entry to its property.
          </p>
        </div>
        <Link href="/real-estate" className="text-sm text-blue-700 hover:underline">
          ← Properties
        </Link>
      </div>

      <LedgerView
        rows={rows as LedgerRow[]}
        properties={properties as { id: number; name: string }[]}
        showProperty={true}
      />

      <p className="mt-4 text-xs text-gray-400">
        Showing {from} to {to}. Add <code>?from=YYYY-MM-DD&amp;to=YYYY-MM-DD</code> to change the window.
      </p>
    </div>
  )
}
