// app/real-estate/southside/rent/page.tsx
// The rent roll: properties/units across the top, rental months down the side.
// Editor-only (admin/manager); partners are redirected. Rent and deposits book
// into the shared income ledger, so they feed Overviews, distributions, and IRR.
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import SouthsideTabs from '@/app/real-estate/_components/SouthsideTabs'
import RentMatrix, { RentColumn, RentPayment } from '@/app/real-estate/_components/RentMatrix'

const pad = (n: number) => String(n).padStart(2, '0')

export default async function RentRollPage() {
  await initDb()
  const editor = await getEditorEmail()
  if (!editor) redirect('/real-estate')

  // Rental-month window: ~12 months back through 3 months ahead, oldest → newest.
  const now = new Date()
  const months: string[] = []
  let cur = new Date(now.getFullYear(), now.getMonth() - 12, 1)
  const endD = new Date(now.getFullYear(), now.getMonth() + 3, 1)
  while (cur <= endD) {
    months.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}`)
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
  }
  const firstPeriod = months[0]
  const lastPeriod = months[months.length - 1]

  const properties = (await sql`
    SELECT id, name, current_tenant FROM properties WHERE status = 'active' ORDER BY name
  `) as Record<string, any>[]
  const units = (await sql`
    SELECT id, property_id, label, current_tenant FROM units ORDER BY property_id, id
  `) as Record<string, any>[]

  const unitsByProp: Record<number, Record<string, any>[]> = {}
  for (const u of units) (unitsByProp[u.property_id] ||= []).push(u)

  // Rent + deposits. Match any income whose category contains "rent" (so 'Rent',
  // 'Rental Income', etc. all qualify) plus anything flagged as a deposit.
  // Scheduled rents from the current month forward are included for confirming.
  const pays = (await sql`
    SELECT t.id, t.property_id, t.unit_id, t.amount::float8 AS amount,
           to_char(t.txn_date, 'YYYY-MM-DD') AS date, t.status,
           COALESCE(t.is_deposit, false) AS is_deposit,
           COALESCE(t.rental_period, to_char(t.txn_date, 'YYYY-MM')) AS period,
           EXISTS (
             SELECT 1 FROM period_closes pc
             WHERE pc.property_id = t.property_id AND t.txn_date BETWEEN pc.period_start AND pc.period_end
           ) AS locked
    FROM transactions t JOIN properties p ON p.id = t.property_id
    WHERE p.status = 'active' AND t.type = 'income'
      AND (t.category ILIKE '%rent%' OR COALESCE(t.is_deposit, false) = true)
      AND (t.status = 'actual' OR (t.status = 'forecast' AND t.txn_date >= date_trunc('month', CURRENT_DATE)))
      AND COALESCE(t.rental_period, to_char(t.txn_date, 'YYYY-MM')) BETWEEN ${firstPeriod} AND ${lastPeriod}
    ORDER BY t.txn_date ASC, t.id ASC
  `) as Record<string, any>[]

  // Properties that have rent booked at the whole-property level (no unit).
  const orphanProps = new Set<number>()
  for (const p of pays) if (p.unit_id == null) orphanProps.add(p.property_id)

  const columns: RentColumn[] = []
  for (const p of properties) {
    const us = unitsByProp[p.id] || []
    if (us.length) {
      for (const u of us) {
        columns.push({ key: `u${u.id}`, propertyId: p.id, unitId: u.id, propertyName: p.name, unitLabel: u.label, tenant: u.current_tenant })
      }
      // Catch-all column if any rent was booked without a unit on this property.
      if (orphanProps.has(p.id)) {
        columns.push({ key: `p${p.id}`, propertyId: p.id, unitId: null, propertyName: p.name, unitLabel: 'Whole property', tenant: p.current_tenant })
      }
    } else {
      columns.push({ key: `p${p.id}`, propertyId: p.id, unitId: null, propertyName: p.name, unitLabel: null, tenant: p.current_tenant })
    }
  }

  const cells: Record<string, RentPayment[]> = {}
  for (const p of pays) {
    const key = `${p.property_id}:${p.unit_id ?? 'P'}:${p.period}`
    ;(cells[key] ||= []).push({
      id: p.id, amount: p.amount, date: p.date, status: p.status, isDeposit: p.is_deposit, locked: p.locked,
    })
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Southside Properties — Rent roll</h1>
          <p className="text-sm text-gray-500">
            Rent and deposits by unit and rental month. Confirm scheduled rents as they clear; a month can hold several payments.
          </p>
        </div>
        <Link href="/real-estate" className="text-sm text-blue-700 hover:underline">← Properties</Link>
      </div>

      <SouthsideTabs />

      {columns.length === 0 ? (
        <div className="rounded-lg border border-gray-200 px-6 py-10 text-center text-gray-500">
          No active properties yet.
        </div>
      ) : (
        <RentMatrix columns={columns} months={months} cells={cells} />
      )}
    </div>
  )
}
