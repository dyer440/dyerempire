// app/real-estate/[id]/page.tsx  (UPDATED — SQL-based YTD (fixes $0), date-range filter on ledger)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import sql from '@/lib/db'
import { getUserRole, canAccessProperty, canEdit } from '@/lib/access'
import { INCOME_CATEGORIES, EXPENSE_CATEGORIES } from '@/lib/categories'
import { addTransaction, deleteTransaction } from '../actions'
import { markForecastPaid } from '../recurring/actions'

type Txn = {
  id: number; type: string; category: string; amount: string; txn_date: string
  description: string | null; unit_label: string | null; status: string
}

export default async function PropertyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string; to?: string; all?: string }>
}) {
  await auth.protect()
  const { id } = await params
  const sp = await searchParams
  const propertyId = Number(id)

  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!(await canAccessProperty(email, role, propertyId))) redirect('/real-estate')
  const editable = canEdit(role)

  const property = (await sql`SELECT * FROM properties WHERE id = ${propertyId} LIMIT 1`) as {
    id: number; name: string; holding_entity: string; property_type: string
    address: string; city: string; state: string; zip: string
  }[]
  if (property.length === 0) redirect('/real-estate')
  const prop = property[0]

  const owners = (await sql`
    SELECT o.name, po.ownership_pct FROM property_owners po
    JOIN owners o ON o.id = po.owner_id
    WHERE po.property_id = ${propertyId} ORDER BY po.ownership_pct DESC
  `) as { name: string; ownership_pct: string }[]

  const units = (await sql`SELECT id, label FROM units WHERE property_id = ${propertyId} ORDER BY id`) as
    { id: number; label: string }[]

  // ---- Date range for the ledger view ----
  const year = new Date().getFullYear()
  const isAll = sp.all === '1'
  const fromDate = isAll ? '1900-01-01' : (sp.from || `${year}-01-01`)
  const toDate = isAll ? '2999-12-31' : (sp.to || `${year}-12-31`)

  // ---- YTD totals computed in SQL (actuals, current year) — type-safe, no JS date math ----
  const ytd = (await sql`
    SELECT type, COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'actual'
      AND EXTRACT(YEAR FROM txn_date) = ${year}
    GROUP BY type
  `) as { type: string; total: number }[]
  let incomeYtd = 0, expenseYtd = 0
  for (const r of ytd) { if (r.type === 'income') incomeYtd = r.total; else expenseYtd = r.total }
  const netYtd = incomeYtd - expenseYtd

  // ---- Actual ledger, filtered to the selected range ----
  const actuals = (await sql`
    SELECT t.id, t.type, t.category, t.amount, t.txn_date, t.description, t.status, u.label AS unit_label
    FROM transactions t LEFT JOIN units u ON u.id = t.unit_id
    WHERE t.property_id = ${propertyId} AND t.status = 'actual'
      AND t.txn_date BETWEEN ${fromDate} AND ${toDate}
    ORDER BY t.txn_date DESC, t.created_at DESC
  `) as Txn[]

  // Range net of the filtered rows (no date math needed — SQL already filtered)
  let rangeIncome = 0, rangeExpense = 0
  for (const t of actuals) {
    const a = parseFloat(t.amount)
    if (t.type === 'income') rangeIncome += a; else rangeExpense += a
  }
  const rangeNet = rangeIncome - rangeExpense

  // ---- Upcoming forecast (scheduled, not yet paid) ----
  const forecasts = (await sql`
    SELECT t.id, t.type, t.category, t.amount, t.txn_date, t.description, t.status, u.label AS unit_label
    FROM transactions t LEFT JOIN units u ON u.id = t.unit_id
    WHERE t.property_id = ${propertyId} AND t.status = 'forecast'
    ORDER BY t.txn_date ASC
  `) as Txn[]
  let projIncome = 0, projExpense = 0
  for (const t of forecasts) {
    const a = parseFloat(t.amount)
    if (t.type === 'income') projIncome += a; else projExpense += a
  }
  const projNet = projIncome - projExpense

  const todayStr = new Date().toISOString().split('T')[0]
  const fmt = (n: number) => `$${n.toFixed(2)}`
  const presetActive = (label: string) => {
    if (label === 'all') return isAll
    if (label === 'year') return !isAll && sp.from === `${year}-01-01` && sp.to === `${year}-12-31`
    if (label === 'last') return !isAll && sp.from === `${year - 1}-01-01` && sp.to === `${year - 1}-12-31`
    return false
  }
  const presetCls = (on: boolean) =>
    `text-xs tracking-widest uppercase transition-colors ${on ? 'text-white' : 'text-white/30 hover:text-white'}`

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl tracking-[0.3em] uppercase" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
              {prop.name}
            </h1>
            <p className="text-white/30 text-xs tracking-widest uppercase mt-1">{prop.holding_entity}</p>
            <p className="text-white/40 text-xs mt-1">{prop.address}, {prop.city} {prop.state} {prop.zip}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Link href="/real-estate" className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
              ← All Properties
            </Link>
            {editable && (
              <Link href={`/real-estate/${propertyId}/schedules`} className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
                Schedules →
              </Link>
            )}
          </div>
        </div>

        {/* Ownership */}
        <div className="border border-white/10 p-4 mb-6">
          <div className="text-white/30 text-xs tracking-widest uppercase mb-3">Ownership</div>
          <div className="space-y-1">
            {owners.map((o) => (
              <div key={o.name} className="flex justify-between text-sm">
                <span className="text-white/70">{o.name}</span>
                <span className="text-white/50" style={{ fontFamily: 'Georgia, serif' }}>
                  {parseFloat(o.ownership_pct).toFixed(2)}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* YTD summary (actuals, current year) */}
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="border border-white/10 p-4">
            <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Income YTD</div>
            <div className="text-xl text-emerald-400" style={{ fontFamily: 'Georgia, serif' }}>{fmt(incomeYtd)}</div>
          </div>
          <div className="border border-white/10 p-4">
            <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Expenses YTD</div>
            <div className="text-xl text-rose-400" style={{ fontFamily: 'Georgia, serif' }}>{fmt(expenseYtd)}</div>
          </div>
          <div className="border border-white/10 p-4">
            <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Net YTD</div>
            <div className={`text-xl ${netYtd >= 0 ? 'text-emerald-400' : 'text-amber-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
              {fmt(netYtd)}
            </div>
          </div>
        </div>

        {/* Projected (forecast) banner */}
        <div className="border border-dashed border-amber-400/30 p-4 mb-8 flex items-center justify-between">
          <div className="text-amber-400/70 text-xs tracking-widest uppercase">Projected net · next 12 mo (scheduled)</div>
          <div className={`text-lg ${projNet >= 0 ? 'text-emerald-400/80' : 'text-amber-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
            {fmt(projNet)}
          </div>
        </div>

        {/* Add transaction (editors only) */}
        {editable && (
          <form action={addTransaction} className="border border-white/10 p-6 mb-8">
            <input type="hidden" name="property_id" value={prop.id} />
            <h2 className="text-xs tracking-widest uppercase text-white/40 mb-4">Add Transaction</h2>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <select name="category" required className="bg-white/5 border border-white/20 px-4 py-2 text-white focus:outline-none focus:border-white/50 text-sm">
                <optgroup label="Income">
                  {INCOME_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </optgroup>
                <optgroup label="Expense">
                  {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </optgroup>
              </select>
              <input name="amount" type="number" step="0.01" min="0.01" placeholder="Amount ($)" required
                className="bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <input name="txn_date" type="date" required defaultValue={todayStr}
                className="bg-white/5 border border-white/20 px-4 py-2 text-white focus:outline-none focus:border-white/50 text-sm" />
              <select name="unit_id" className="bg-white/5 border border-white/20 px-4 py-2 text-white focus:outline-none focus:border-white/50 text-sm">
                <option value="">Whole property</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </div>
            <div className="flex gap-3">
              <input name="description" type="text" placeholder="Description (optional)"
                className="flex-1 bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 text-sm" />
              <button type="submit" className="border border-white/30 px-6 py-2 text-sm tracking-widest uppercase hover:bg-white/10 transition-all whitespace-nowrap">
                Add
              </button>
            </div>
          </form>
        )}

        {/* Upcoming scheduled (forecast) */}
        {forecasts.length > 0 && (
          <div className="border border-dashed border-white/15 mb-8">
            <div className="px-6 py-3 border-b border-white/10 text-xs tracking-widest uppercase text-amber-400/60">
              Scheduled — upcoming ({forecasts.length})
            </div>
            {forecasts.map((t) => {
              const a = parseFloat(t.amount)
              const income = t.type === 'income'
              return (
                <div key={t.id} className="flex items-center justify-between px-6 py-3 border-b border-white/5">
                  <div className="flex items-center gap-6">
                    <div className={`text-sm w-24 ${income ? 'text-emerald-400/60' : 'text-rose-400/60'}`} style={{ fontFamily: 'Georgia, serif' }}>
                      {income ? '+' : '−'}{fmt(a)}
                    </div>
                    <div>
                      <div className="text-sm text-white/50">{t.category}</div>
                      <div className="text-xs text-white/30 mt-0.5">
                        {new Date(t.txn_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                        {t.unit_label ? ` · ${t.unit_label}` : ''}{t.description ? ` · ${t.description}` : ''}
                      </div>
                    </div>
                  </div>
                  {editable && (
                    <form action={markForecastPaid} className="flex items-center gap-2">
                      <input type="hidden" name="property_id" value={prop.id} />
                      <input type="hidden" name="id" value={t.id} />
                      <input name="actual_amount" type="number" step="0.01" min="0.01" placeholder={a.toFixed(2)}
                        className="w-24 bg-white/5 border border-white/20 px-2 py-1 text-white placeholder:text-white/30 text-xs focus:outline-none focus:border-white/50" />
                      <input name="actual_date" type="date"
                        className="bg-white/5 border border-white/20 px-2 py-1 text-white text-xs focus:outline-none focus:border-white/50" />
                      <button type="submit" className="border border-emerald-400/30 text-emerald-400/80 px-3 py-1 text-xs tracking-widest uppercase hover:bg-emerald-400/10 transition-all whitespace-nowrap">
                        Mark paid
                      </button>
                    </form>
                  )}
                </div>
              )
            })}
            <div className="px-6 py-2 text-[11px] text-white/25">
              Amounts marked “est” are estimates — correct the amount/date when you mark them paid. Leave blank to accept as-is.
            </div>
          </div>
        )}

        {/* Ledger filter controls */}
        <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
          <form method="get" className="flex items-end gap-2">
            <div>
              <label className="block text-[10px] text-white/30 tracking-widest uppercase mb-1">From</label>
              <input name="from" type="date" defaultValue={isAll ? '' : fromDate}
                className="bg-white/5 border border-white/20 px-3 py-1.5 text-white text-xs focus:outline-none focus:border-white/50" />
            </div>
            <div>
              <label className="block text-[10px] text-white/30 tracking-widest uppercase mb-1">To</label>
              <input name="to" type="date" defaultValue={isAll ? '' : toDate}
                className="bg-white/5 border border-white/20 px-3 py-1.5 text-white text-xs focus:outline-none focus:border-white/50" />
            </div>
            <button type="submit" className="border border-white/30 px-4 py-1.5 text-xs tracking-widest uppercase hover:bg-white/10 transition-all">
              Apply
            </button>
          </form>
          <div className="flex items-center gap-4">
            <Link href={`/real-estate/${propertyId}?from=${year}-01-01&to=${year}-12-31`} className={presetCls(presetActive('year'))}>This Year</Link>
            <Link href={`/real-estate/${propertyId}?from=${year - 1}-01-01&to=${year - 1}-12-31`} className={presetCls(presetActive('last'))}>Last Year</Link>
            <Link href={`/real-estate/${propertyId}?all=1`} className={presetCls(presetActive('all'))}>All</Link>
          </div>
        </div>

        {/* Actual ledger */}
        <div className="border border-white/10">
          <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between">
            <span className="text-xs tracking-widest uppercase text-white/40">
              Ledger · actuals ({actuals.length})
            </span>
            <span className="text-xs tracking-widest uppercase text-white/40">
              range net <span className={rangeNet >= 0 ? 'text-emerald-400' : 'text-amber-400'} style={{ fontFamily: 'Georgia, serif' }}>{fmt(rangeNet)}</span>
            </span>
          </div>
          {actuals.length === 0 && (
            <div className="px-6 py-8 text-center text-white/20 text-sm tracking-widest uppercase">No transactions in range</div>
          )}
          {actuals.map((t) => {
            const a = parseFloat(t.amount)
            const income = t.type === 'income'
            return (
              <div key={t.id} className="flex items-center justify-between px-6 py-4 border-b border-white/5 hover:bg-white/5">
                <div className="flex items-center gap-6">
                  <div className={`text-sm w-24 ${income ? 'text-emerald-400' : 'text-rose-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
                    {income ? '+' : '−'}{fmt(a)}
                  </div>
                  <div>
                    <div className="text-sm text-white/70">{t.category}</div>
                    <div className="text-xs text-white/40 mt-0.5">
                      {new Date(t.txn_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                      {t.unit_label ? ` · ${t.unit_label}` : ''}{t.description ? ` · ${t.description}` : ''}
                    </div>
                  </div>
                </div>
                {editable && (
                  <form action={deleteTransaction}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="property_id" value={prop.id} />
                    <button type="submit" className="text-xs text-white/20 hover:text-red-400 tracking-widest uppercase transition-colors">
                      Remove
                    </button>
                  </form>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </main>
  )
}
