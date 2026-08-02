// app/real-estate/[id]/summary/page.tsx
// Summary — the annual rollup, one column per year, structured like Form 8825
// (rental real estate on a partnership 1065). Rows: Rental income, each 8825
// expense line (consolidated from the ledger's many categories), Net income
// (cash, before depreciation), then Depreciation → Paper net income, then
// Distributions. Current (in-progress) year is included as a PARTIAL from
// actuals booked so far and labeled as such.
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { getUserRole, canAccessProperty } from '@/lib/access'
import { FORM_8825_LINES, lineForCategory } from '@/lib/form8825'

const fmt = (n: number) =>
  n < 0 ? `(${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
        : n === 0 ? '—'
        : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default async function SummaryPage({ params }: { params: Promise<{ id: string }> }) {
  await auth.protect()
  await initDb()
  const { id } = await params
  const propertyId = Number(id)

  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!(await canAccessProperty(email, role, propertyId))) redirect('/real-estate')

  const prop = (await sql`SELECT name, holding_entity FROM properties WHERE id = ${propertyId} LIMIT 1`) as
    { name: string; holding_entity: string }[]
  if (prop.length === 0) redirect('/real-estate')

  const currentYear = new Date().getFullYear()

  // Actual income/expense by year and category (deposits excluded).
  const rows = (await sql`
    SELECT EXTRACT(YEAR FROM txn_date)::int AS yr, type, category,
           COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'actual'
      AND COALESCE(is_deposit, FALSE) = FALSE
    GROUP BY yr, type, category
  `) as { yr: number; type: string; category: string; total: number }[]

  const depRows = (await sql`
    SELECT year AS yr, COALESCE(SUM(amount), 0)::float8 AS total
    FROM depreciation_schedule WHERE property_id = ${propertyId} GROUP BY year
  `) as { yr: number; total: number }[]

  const distRows = (await sql`
    SELECT LEFT(period, 4)::int AS yr, COALESCE(SUM(amount), 0)::float8 AS total
    FROM distributions WHERE property_id = ${propertyId} GROUP BY yr
  `) as { yr: number; total: number }[]

  // Collect the set of years present anywhere.
  const yearSet = new Set<number>()
  rows.forEach(r => yearSet.add(r.yr))
  depRows.forEach(r => yearSet.add(r.yr))
  distRows.forEach(r => yearSet.add(r.yr))
  const years = [...yearSet].sort((a, b) => a - b)

  // income[yr], expenseByLine[lineLabel][yr], unmapped[yr]
  const income: Record<number, number> = {}
  const expenseByLine: Record<string, Record<number, number>> = {}
  const unmapped: Record<number, number> = {}
  const unmappedCats = new Set<string>()
  for (const l of FORM_8825_LINES) expenseByLine[l.label] = {}

  for (const r of rows) {
    if (r.type === 'income') {
      income[r.yr] = (income[r.yr] || 0) + r.total
    } else {
      const line = lineForCategory(r.category)
      if (line === null) continue // deposits etc.
      if (line === '__UNMAPPED__') {
        unmapped[r.yr] = (unmapped[r.yr] || 0) + r.total
        unmappedCats.add(r.category)
      } else {
        expenseByLine[line][r.yr] = (expenseByLine[line][r.yr] || 0) + r.total
      }
    }
  }

  const dep: Record<number, number> = {}
  depRows.forEach(r => (dep[r.yr] = r.total))
  const dist: Record<number, number> = {}
  distRows.forEach(r => (dist[r.yr] = r.total))

  const totalExpense = (yr: number) => {
    let t = 0
    for (const l of FORM_8825_LINES) t += expenseByLine[l.label][yr] || 0
    t += unmapped[yr] || 0
    return t
  }
  const netIncome = (yr: number) => (income[yr] || 0) - totalExpense(yr) // cash, pre-depreciation
  const paperNet = (yr: number) => netIncome(yr) - (dep[yr] || 0)

  const activeLines = FORM_8825_LINES.filter(l => years.some(y => (expenseByLine[l.label][y] || 0) !== 0))
  const hasUnmapped = years.some(y => (unmapped[y] || 0) !== 0)

  const th = 'px-3 py-2 text-right text-xs tabular-nums'
  const labelTd = 'px-3 py-2 text-left whitespace-nowrap'

  return (
    <main className="min-h-screen bg-white text-gray-900 p-6 md:p-10">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">{prop[0].name} — Summary</h1>
          <p className="text-sm text-gray-500">
            {prop[0].holding_entity} · annual rollup, structured to Form 8825. Depreciation is the paper-only line
            bridging Net income to Paper net income.
          </p>
        </div>

        <div className="overflow-x-auto border border-gray-200 rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-gray-500">Form 8825 line</th>
                {years.map(y => (
                  <th key={y} className="px-3 py-2 text-right text-xs uppercase tracking-wider text-gray-500">
                    {y}{y === currentYear ? ' *' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-100 font-medium">
                <td className={labelTd}>Rental income</td>
                {years.map(y => <td key={y} className={th + ' text-emerald-700'}>{fmt(income[y] || 0)}</td>)}
              </tr>

              {activeLines.map(l => (
                <tr key={l.label} className="border-b border-gray-50">
                  <td className={labelTd + ' text-gray-600'}><span className="text-gray-400 mr-2">{l.line}</span>{l.label}</td>
                  {years.map(y => <td key={y} className={th}>{fmt(-(expenseByLine[l.label][y] || 0))}</td>)}
                </tr>
              ))}
              {hasUnmapped && (
                <tr className="border-b border-gray-50">
                  <td className={labelTd + ' text-amber-700'}>Unmapped (fix category)</td>
                  {years.map(y => <td key={y} className={th + ' text-amber-700'}>{fmt(-(unmapped[y] || 0))}</td>)}
                </tr>
              )}

              <tr className="border-t-2 border-gray-300 font-semibold">
                <td className={labelTd}>Net income (cash)</td>
                {years.map(y => {
                  const n = netIncome(y)
                  return <td key={y} className={th + (n < 0 ? ' text-red-600' : '')}>{fmt(n)}</td>
                })}
              </tr>
              <tr className="border-b border-gray-50">
                <td className={labelTd + ' text-gray-600'}><span className="text-gray-400 mr-2">14</span>Depreciation</td>
                {years.map(y => <td key={y} className={th}>{fmt(-(dep[y] || 0))}</td>)}
              </tr>
              <tr className="border-t border-gray-300 font-semibold">
                <td className={labelTd}>Paper net income</td>
                {years.map(y => {
                  const n = paperNet(y)
                  return <td key={y} className={th + (n < 0 ? ' text-red-600' : '')}>{fmt(n)}</td>
                })}
              </tr>

              <tr className="border-t-2 border-gray-300">
                <td className={labelTd + ' text-gray-600'}>Distributions</td>
                {years.map(y => <td key={y} className={th + ' text-gray-600'}>{fmt(-(dist[y] || 0))}</td>)}
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-4 space-y-1 text-xs text-gray-500">
          {years.includes(currentYear) && <p>* {currentYear} is a partial year — actuals booked so far, not a full-year projection.</p>}
          <p>Net income is cash-basis before depreciation; Paper net income is after the depreciation schedule (your K-1 figure).</p>
          {hasUnmapped && (
            <p className="text-amber-700">
              Some expenses fall in categories not yet mapped to an 8825 line: {[...unmappedCats].join(', ')}. Re-category them,
              or tell me which line they belong on and I&apos;ll add the mapping.
            </p>
          )}
        </div>
      </div>
    </main>
  )
}
