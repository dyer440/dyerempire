// app/real-estate/[id]/page.tsx  (UPDATED — scheduled + actuals merged into ONE
//   chronological list; actuals now editable inline; Southside link for editors)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import sql from '@/lib/db'
import { getUserRole, canAccessProperty, canEdit } from '@/lib/access'
import { INCOME_CATEGORIES, EXPENSE_CATEGORIES } from '@/lib/categories'
import { addTransaction, deleteTransaction } from '../actions'
import { markForecastPaid, deleteForecast } from '../recurring/actions'
import { editTransaction } from '../ledger-form-actions'

type Txn = {
  id: number; type: string; category: string; amount: string; txn_date: string
  description: string | null; unit_label: string | null; unit_id: number | null; status: string
}

const pad = (n: number) => String(n).padStart(2, '0')
function monthRange(y: number, m1: number) {
  // m1 is 1-indexed; handle rollover
  let yy = y, mm = m1
  if (mm < 1) { mm = 12; yy-- }
  if (mm > 12) { mm = 1; yy++ }
  const lastDay = new Date(yy, mm, 0).getDate()
  return { from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${pad(lastDay)}` }
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

  // ---- Date range (scopes the merged ledger) ----
  const year = new Date().getFullYear()
  const isAll = sp.all === '1'
  const isDefault = !isAll && !sp.from && !sp.to
  const fromDate = isAll ? '1900-01-01' : (sp.from || `${year}-01-01`)
  const toDate = isAll ? '2999-12-31' : (sp.to || `${year}-12-31`)

  // ---- YTD totals in SQL (actuals, current year) — always full year regardless of filter ----
  const ytd = (await sql`
    SELECT type, COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'actual'
      AND EXTRACT(YEAR FROM txn_date) = ${year}
      AND COALESCE(is_deposit, FALSE) = FALSE
    GROUP BY type
  `) as { type: string; total: number }[]
  let incomeYtd = 0, expenseYtd = 0
  for (const r of ytd) { if (r.type === 'income') incomeYtd = r.total; else expenseYtd = r.total }
  const netYtd = incomeYtd - expenseYtd

  // ---- Projected net over the FULL forecast horizon (banner stays 12-mo, unfiltered) ----
  const proj = (await sql`
    SELECT type, COALESCE(SUM(amount), 0)::float8 AS total
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'forecast'
      AND COALESCE(is_deposit, FALSE) = FALSE
    GROUP BY type
  `) as { type: string; total: number }[]
  let projIncome = 0, projExpense = 0
  for (const r of proj) { if (r.type === 'income') projIncome = r.total; else projExpense = r.total }
  const projNet = projIncome - projExpense

  // ---- Deposits held (liability) — excluded from P&L above; shown separately.
  // Net of returns: a collection is income+is_deposit, a return is expense+is_deposit.
  const depRows = (await sql`
    SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0)::float8 AS held
    FROM transactions
    WHERE property_id = ${propertyId} AND status = 'actual' AND COALESCE(is_deposit, FALSE) = TRUE
  `) as { held: number }[]
  const depositsHeld = depRows[0]?.held || 0

  // ---- One ledger: actuals + scheduled, filtered to range, sorted chronologically ----
  const rows = (await sql`
    SELECT t.id, t.type, t.category, t.amount,
           to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date,
           t.description, t.status, t.unit_id, u.label AS unit_label
    FROM transactions t LEFT JOIN units u ON u.id = t.unit_id
    WHERE t.property_id = ${propertyId}
      AND t.txn_date BETWEEN ${fromDate} AND ${toDate}
      AND (t.status = 'actual' OR (t.status = 'forecast' AND t.txn_date >= date_trunc('month', CURRENT_DATE)))
    ORDER BY t.txn_date ASC, t.status ASC, t.created_at ASC
  `) as Txn[]

  let rangeIncome = 0, rangeExpense = 0, schedIncome = 0, schedExpense = 0
  for (const t of rows) {
    const a = parseFloat(t.amount)
    if (t.status === 'actual') {
      if (t.type === 'income') rangeIncome += a; else rangeExpense += a
    } else {
      if (t.type === 'income') schedIncome += a; else schedExpense += a
    }
  }
  const rangeNet = rangeIncome - rangeExpense
  const schedNet = schedIncome - schedExpense

  const todayStr = new Date().toISOString().split('T')[0]
  const fmt = (n: number) => `$${n.toFixed(2)}`
  const longDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

  // ---- Filter preset helpers ----
  const base = `/real-estate/${propertyId}`
  const yearActive = isDefault || (!isAll && sp.from === `${year}-01-01` && sp.to === `${year}-12-31`)
  const lastActive = !isAll && sp.from === `${year - 1}-01-01` && sp.to === `${year - 1}-12-31`
  const presetCls = (on: boolean) =>
    `text-xs tracking-widest uppercase transition-colors ${on ? 'text-white' : 'text-white/30 hover:text-white'}`

  // Month stepper relative to current fromDate
  const [fy, fmth] = fromDate.split('-').map(Number)
  const prevM = monthRange(fy, fmth - 1)
  const nextM = monthRange(fy, fmth + 1)
  const thisM = monthRange(year, new Date().getMonth() + 1)

  // Group the merged list by month for a clean chronological scan.
  const groups: { key: string; label: string; items: Txn[] }[] = []
  for (const t of rows) {
    const key = t.txn_date.slice(0, 7)
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) {
      g = { key, label: new Date(t.txn_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), items: [] }
      groups.push(g)
    }
    g.items.push(t)
  }

  const editFieldCls =
    'bg-white/5 border border-white/20 px-2 py-1 text-white placeholder:text-white/30 text-xs focus:outline-none focus:border-white/50'

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
              <>
                <Link href={`${base}/schedules`} className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
                  Schedules →
                </Link>
                <Link href="/real-estate/southside" className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
                  Southside →
                </Link>
              </>
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

        {/* Projected (forecast) banner — full 12-mo horizon */}
        <div className="border border-dashed border-amber-400/30 p-4 mb-8 flex items-center justify-between">
          <div className="text-amber-400/70 text-xs tracking-widest uppercase">Projected net · next 12 mo (scheduled)</div>
          <div className={`text-lg ${projNet >= 0 ? 'text-emerald-400/80' : 'text-amber-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
            {fmt(projNet)}
          </div>
        </div>

        {/* Deposits held — a liability, not income. Excluded from all P&L above. */}
        {depositsHeld > 0 && (
          <div className="border border-white/10 p-4 mb-8 flex items-center justify-between">
            <div className="text-white/40 text-xs tracking-widest uppercase">Deposits held · liability (excluded from income)</div>
            <div className="text-lg text-white/70" style={{ fontFamily: 'Georgia, serif' }}>{fmt(depositsHeld)}</div>
          </div>
        )}

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

        {/* ---- Date filter (applies to the merged ledger) ---- */}
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 justify-end">
            <Link href={`${base}?from=${prevM.from}&to=${prevM.to}`} className={presetCls(false)}>◀ Prev</Link>
            <Link href={`${base}?from=${thisM.from}&to=${thisM.to}`} className={presetCls(false)}>This Month</Link>
            <Link href={`${base}?from=${nextM.from}&to=${nextM.to}`} className={presetCls(false)}>Next ▶</Link>
            <span className="text-white/15">|</span>
            <Link href={`${base}?from=${year}-01-01&to=${year}-12-31`} className={presetCls(yearActive)}>This Year</Link>
            <Link href={`${base}?from=${year - 1}-01-01&to=${year - 1}-12-31`} className={presetCls(lastActive)}>Last Year</Link>
            <Link href={`${base}?all=1`} className={presetCls(isAll)}>All</Link>
          </div>
        </div>

        {/* ---- Merged ledger: actuals + scheduled, chronological ---- */}
        <div className="border border-white/10">
          <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs tracking-widest uppercase text-white/40">Ledger · in range ({rows.length})</span>
            <span className="text-xs tracking-widest uppercase text-white/40">
              actual <span className={rangeNet >= 0 ? 'text-emerald-400' : 'text-amber-400'} style={{ fontFamily: 'Georgia, serif' }}>{fmt(rangeNet)}</span>
              {schedNet !== 0 && (
                <> · scheduled <span className={schedNet >= 0 ? 'text-emerald-400/70' : 'text-amber-400/80'} style={{ fontFamily: 'Georgia, serif' }}>{fmt(schedNet)}</span></>
              )}
            </span>
          </div>

          {rows.length === 0 && (
            <div className="px-6 py-8 text-center text-white/20 text-sm tracking-widest uppercase">No transactions in range</div>
          )}

          {groups.map((g) => (
            <div key={g.key}>
              <div className="px-6 py-1.5 bg-white/5 text-[11px] tracking-widest uppercase text-white/30">{g.label}</div>
              {g.items.map((t) => {
                const a = parseFloat(t.amount)
                const income = t.type === 'income'
                const scheduled = t.status === 'forecast'
                return (
                  <div key={`${t.status}-${t.id}`}
                    className={`px-6 py-3 border-b border-white/5 ${scheduled ? 'bg-amber-400/[0.03]' : 'hover:bg-white/5'}`}>
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-6">
                        <div className={`text-sm w-24 ${scheduled ? (income ? 'text-emerald-400/60' : 'text-rose-400/60') : (income ? 'text-emerald-400' : 'text-rose-400')}`} style={{ fontFamily: 'Georgia, serif' }}>
                          {income ? '+' : '−'}{fmt(a)}
                        </div>
                        <div>
                          <div className={`text-sm ${scheduled ? 'text-white/50' : 'text-white/70'} flex items-center gap-2`}>
                            {t.category}
                            {scheduled && (
                              <span className="rounded-full border border-amber-400/40 text-amber-400/80 px-2 py-0.5 text-[10px] tracking-widest uppercase">Scheduled</span>
                            )}
                          </div>
                          <div className={`text-xs ${scheduled ? 'text-white/30' : 'text-white/40'} mt-0.5`}>
                            {longDate(t.txn_date)}
                            {t.unit_label ? ` · ${t.unit_label}` : ''}{t.description ? ` · ${t.description}` : ''}
                          </div>
                        </div>
                      </div>

                      {editable && (
                        <div className="flex items-center gap-2 shrink-0">
                          {scheduled ? (
                            <>
                              <form action={markForecastPaid} className="flex items-center gap-2">
                                <input type="hidden" name="property_id" value={prop.id} />
                                <input type="hidden" name="id" value={t.id} />
                                <input name="actual_amount" type="number" step="0.01" min="0.01" placeholder={a.toFixed(2)}
                                  className="w-24 bg-white/5 border border-white/20 px-2 py-1 text-white placeholder:text-white/30 text-xs focus:outline-none focus:border-white/50" />
                                <input name="actual_date" type="date"
                                  className="bg-white/5 border border-white/20 px-2 py-1 text-white text-xs focus:outline-none focus:border-white/50" />
                                <button type="submit" className="border border-emerald-400/30 text-emerald-400/80 px-3 py-1 text-xs tracking-widest uppercase hover:bg-emerald-400/10 transition-all whitespace-nowrap">
                                  Confirm
                                </button>
                              </form>
                              <form action={deleteForecast}>
                                <input type="hidden" name="property_id" value={prop.id} />
                                <input type="hidden" name="id" value={t.id} />
                                <button type="submit" className="text-xs text-white/20 hover:text-red-400 tracking-widest uppercase transition-colors">
                                  Skip
                                </button>
                              </form>
                            </>
                          ) : (
                            <form action={deleteTransaction}>
                              <input type="hidden" name="id" value={t.id} />
                              <input type="hidden" name="property_id" value={prop.id} />
                              <button type="submit" className="text-xs text-white/20 hover:text-red-400 tracking-widest uppercase transition-colors">
                                Remove
                              </button>
                            </form>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Inline edit for actuals — native disclosure, no client JS */}
                    {editable && !scheduled && (
                      <details className="mt-1">
                        <summary className="cursor-pointer list-none ml-auto w-fit text-xs text-white/30 hover:text-white tracking-widest uppercase transition-colors select-none">
                          Edit
                        </summary>
                        <form action={editTransaction} className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-2 border-t border-white/5 pt-3">
                          <input type="hidden" name="id" value={t.id} />
                          <input type="hidden" name="property_id" value={prop.id} />
                          <select name="category" defaultValue={t.category} className={editFieldCls}>
                            <optgroup label="Income">
                              {INCOME_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                            </optgroup>
                            <optgroup label="Expense">
                              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                            </optgroup>
                          </select>
                          <input name="amount" type="number" step="0.01" min="0.01" defaultValue={a.toFixed(2)} className={editFieldCls} />
                          <input name="txn_date" type="date" defaultValue={t.txn_date.slice(0, 10)} className={editFieldCls} />
                          <select name="unit_id" defaultValue={t.unit_id ?? ''} className={editFieldCls}>
                            <option value="">Whole property</option>
                            {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                          </select>
                          <input name="description" type="text" defaultValue={t.description ?? ''} placeholder="Description" className={editFieldCls} />
                          <button type="submit" className="border border-white/30 px-4 py-1 text-xs tracking-widest uppercase hover:bg-white/10 transition-all">
                            Save
                          </button>
                        </form>
                      </details>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {editable && (
            <div className="px-6 py-2 text-[11px] text-white/25">
              “Confirm” turns a scheduled item into an actual (adjust the amount/date if it cleared differently). “Skip”
              drops one occurrence (Regenerate recreates it — edit the schedule to stop it for good). “Edit” opens an actual row to fix the amount, date, category, or unit.
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
