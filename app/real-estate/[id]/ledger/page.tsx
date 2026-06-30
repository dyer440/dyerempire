// app/real-estate/[id]/ledger/page.tsx
// Per-property unified ledger: actual transactions + upcoming scheduled items,
// in one chronological list. Editor-only (admin/manager); partners are redirected.
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import LedgerView, { LedgerRow } from '@/app/real-estate/_components/LedgerView'

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default async function PropertyLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }> | { id: string }
  searchParams?: Promise<Record<string, string | undefined>> | Record<string, string | undefined>
}) {
  await initDb()
  const editor = await getEditorEmail()
  if (!editor) redirect('/real-estate') // partners/viewers don't get the entry view

  const { id } = await params
  const sp = (await searchParams) || {}
  const propertyId = Number(id)

  const props = (await sql`SELECT id, name FROM properties WHERE id = ${propertyId} LIMIT 1`) as Record<string, any>[]
  const property = props[0]
  if (!property) redirect('/real-estate')

  const now = new Date()
  const fromDefault = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)) // start of last month
  const toDefault = ymd(new Date(now.getFullYear(), now.getMonth() + 13, 0)) // ~12 months out
  const from = sp.from || fromDefault
  const to = sp.to || toDefault

  // Actuals always; scheduled only from the start of the current month forward
  // (matches the forecast generator's retention boundary).
  const rows = (await sql`
    SELECT t.id, t.property_id, p.name AS property_name, t.type, t.category,
           t.amount::float8 AS amount, to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date,
           t.description, t.status,
           EXISTS (
             SELECT 1 FROM period_closes pc
             WHERE pc.property_id = t.property_id AND t.txn_date BETWEEN pc.period_start AND pc.period_end
           ) AS locked
    FROM transactions t JOIN properties p ON p.id = t.property_id
    WHERE t.property_id = ${propertyId}
      AND t.txn_date >= ${from}::date AND t.txn_date <= ${to}::date
      AND (t.status = 'actual' OR (t.status = 'forecast' AND t.txn_date >= date_trunc('month', CURRENT_DATE)))
    ORDER BY t.txn_date ASC, t.id ASC
  `) as Record<string, any>[]

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{property.name} — Ledger</h1>
          <p className="text-sm text-gray-500">
            Actuals and upcoming scheduled items in date order. Confirm a scheduled item once it clears the bank.
          </p>
        </div>
        <Link href="/real-estate/southside" className="text-sm text-blue-700 hover:underline">
          All-properties entry (Southside) →
        </Link>
      </div>

      <LedgerView
        rows={rows as LedgerRow[]}
        properties={[{ id: property.id, name: property.name }]}
        showProperty={false}
        defaultPropertyId={property.id}
      />

      <p className="mt-4 text-xs text-gray-400">
        Showing {from} to {to}. Add <code>?from=YYYY-MM-DD&amp;to=YYYY-MM-DD</code> to change the window.
      </p>
    </div>
  )
}
