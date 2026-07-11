// app/real-estate/southside/rent/page.tsx
// The rent roll: properties/units across the top, one YEAR of rental months down
// the side, with prev/next-year paging. Columns are built only from units that
// actually carry rent, so empty unit records don't create phantom columns.
// Editor-only (admin/manager); partners are redirected.
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import SouthsideTabs from '@/app/real-estate/_components/SouthsideTabs'
import RentMatrix, { RentColumn, RentPayment } from '@/app/real-estate/_components/RentMatrix'

const pad = (n: number) => String(n).padStart(2, '0')

export default async function RentRollPage({
  searchParams,
}: {
  searchParams?: Promise<{ year?: string }> | { year?: string }
}) {
  await initDb()
  const editor = await getEditorEmail()
  if (!editor) redirect('/real-estate')

  const sp = (await searchParams) || {}
  const nowYear = new Date().getFullYear()
  const year = Number(sp.year) || nowYear
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`)
  const firstPeriod = `${year}-01`
  const lastPeriod = `${year}-12`

  const properties = (await sql`
    SELECT id, name, current_tenant FROM properties WHERE status = 'active' ORDER BY name
  `) as Record<string, any>[]
  const units = (await sql`
    SELECT id, property_id, label, current_tenant FROM units ORDER BY property_id, id
  `) as Record<string, any>[]
  const unitsByProp: Record<number, Record<string, any>[]> = {}
  for (const u of units) (unitsByProp[u.property_id] ||= []).push(u)

  // Column structure comes from ALL-TIME rent presence (stable across years):
  // which units have ever had rent, and which properties have whole-property rent.
  const struct = (await sql`
    SELECT DISTINCT t.property_id, t.unit_id
    FROM transactions t JOIN properties p ON p.id = t.property_id
    WHERE p.status = 'active' AND t.type = 'income'
      AND (t.category ILIKE '%rent%' OR COALESCE(t.is_deposit, false) = true)
  `) as Record<string, any>[]
  const unitsWithRent = new Set<number>()
  const wholePropRent = new Set<number>()
  for (const s of struct) {
    if (s.unit_id == null) wholePropRent.add(s.property_id)
    else unitsWithRent.add(s.unit_id)
  }

  const columns: RentColumn[] = []
  for (const p of properties) {
    const unitCols = (unitsByProp[p.id] || []).filter((u) => unitsWithRent.has(u.id))
    if (unitCols.length === 0) {
      // Single whole-property column (SFH, or all rent booked at property level).
      columns.push({ key: `p${p.id}`, propertyId: p.id, unitId: null, propertyName: p.name, unitLabel: null, tenant: p.current_tenant })
    } else {
      for (const u of unitCols) {
        columns.push({ key: `u${u.id}`, propertyId: p.id, unitId: u.id, propertyName: p.name, unitLabel: u.label, tenant: u.current_tenant })
      }
      // Only add a catch-all if this property ALSO has whole-property rent.
      if (wholePropRent.has(p.id)) {
        columns.push({ key: `p${p.id}`, propertyId: p.id, unitId: null, propertyName: p.name, unitLabel: 'Whole property', tenant: p.current_tenant })
      }
    }
  }

  // Cells for the selected year only.
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

  const cells: Record<string, RentPayment[]> = {}
  for (const p of pays) {
    const key = `${p.property_id}:${p.unit_id ?? 'P'}:${p.period}`
    ;(cells[key] ||= []).push({
      id: p.id, amount: p.amount, date: p.date, status: p.status, isDeposit: p.is_deposit, locked: p.locked,
    })
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Southside Properties — Rent roll</h1>
          <p className="text-sm text-gray-500">
            Rent and deposits by unit and rental month. Confirm scheduled rents as they clear; a month can hold several payments.
          </p>
        </div>
        <Link href="/real-estate" className="text-sm text-blue-700 hover:underline">&larr; Properties</Link>
      </div>

      <SouthsideTabs />

      {/* Year pager */}
      <div className="mb-4 flex items-center justify-center gap-4">
        <Link href={`?year=${year - 1}`} className="rounded-full border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100">
          &larr; {year - 1}
        </Link>
        <span className="text-lg font-semibold text-gray-900 tabular-nums">{year}</span>
        <Link href={`?year=${year + 1}`} className="rounded-full border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100">
          {year + 1} &rarr;
        </Link>
        {year !== nowYear && (
          <Link href={`?year=${nowYear}`} className="text-sm text-blue-700 hover:underline">Today</Link>
        )}
      </div>

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
