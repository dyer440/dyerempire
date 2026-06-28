// app/real-estate/[id]/page.tsx  (NEW — single property: ledger, summary, owners, units)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import sql from '@/lib/db'
import { getUserRole, canAccessProperty, canEdit } from '@/lib/access'
import { INCOME_CATEGORIES, EXPENSE_CATEGORIES } from '@/lib/categories'
import { addTransaction, deleteTransaction } from '../actions'

export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  await auth.protect()
  const { id } = await params
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

  const txns = (await sql`
    SELECT t.id, t.type, t.category, t.amount, t.txn_date, t.description, u.label AS unit_label
    FROM transactions t LEFT JOIN units u ON u.id = t.unit_id
    WHERE t.property_id = ${propertyId}
    ORDER BY t.txn_date DESC, t.created_at DESC
  `) as { id: number; type: string; category: string; amount: string; txn_date: string; description: string; unit_label: string | null }[]

  const yearStart = `${new Date().getFullYear()}-01-01`
  let incomeYtd = 0, expenseYtd = 0
  for (const t of txns) {
    if (t.txn_date >= yearStart) {
      const a = parseFloat(t.amount)
      if (t.type === 'income') incomeYtd += a; else expenseYtd += a
    }
  }
  const netYtd = incomeYtd - expenseYtd

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
          <Link href="/real-estate" className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
            ← All Properties
          </Link>
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

        {/* YTD summary */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="border border-white/10 p-4">
            <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Income YTD</div>
            <div className="text-xl text-emerald-400" style={{ fontFamily: 'Georgia, serif' }}>${incomeYtd.toFixed(2)}</div>
          </div>
          <div className="border border-white/10 p-4">
            <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Expenses YTD</div>
            <div className="text-xl text-rose-400" style={{ fontFamily: 'Georgia, serif' }}>${expenseYtd.toFixed(2)}</div>
          </div>
          <div className="border border-white/10 p-4">
            <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Net YTD</div>
            <div className={`text-xl ${netYtd >= 0 ? 'text-emerald-400' : 'text-amber-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
              ${netYtd.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Add transaction (editors only) */}
        {editable && (
          <form action={addTransaction} className="border border-white/10 p-6 mb-8">
            <input type="hidden" name="property_id" value={prop.id} />
            <h2 className="text-xs tracking-widest uppercase text-white/40 mb-4">Add Transaction</h2>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <select name="category" required
                className="bg-white/5 border border-white/20 px-4 py-2 text-white focus:outline-none focus:border-white/50 text-sm">
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
              <input name="txn_date" type="date" required defaultValue={new Date().toISOString().split('T')[0]}
                className="bg-white/5 border border-white/20 px-4 py-2 text-white focus:outline-none focus:border-white/50 text-sm" />
              <select name="unit_id"
                className="bg-white/5 border border-white/20 px-4 py-2 text-white focus:outline-none focus:border-white/50 text-sm">
                <option value="">Whole property</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </div>
            <div className="flex gap-3">
              <input name="description" type="text" placeholder="Description (optional)"
                className="flex-1 bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 text-sm" />
              <button type="submit"
                className="border border-white/30 px-6 py-2 text-sm tracking-widest uppercase hover:bg-white/10 transition-all whitespace-nowrap">
                Add
              </button>
            </div>
          </form>
        )}

        {/* Ledger */}
        <div className="border border-white/10">
          <div className="px-6 py-3 border-b border-white/10 text-xs tracking-widest uppercase text-white/40">
            Ledger ({txns.length})
          </div>
          {txns.length === 0 && (
            <div className="px-6 py-8 text-center text-white/20 text-sm tracking-widest uppercase">No transactions yet</div>
          )}
          {txns.map((t) => {
            const a = parseFloat(t.amount)
            const income = t.type === 'income'
            return (
              <div key={t.id} className="flex items-center justify-between px-6 py-4 border-b border-white/5 hover:bg-white/5">
                <div className="flex items-center gap-6">
                  <div className={`text-sm w-24 ${income ? 'text-emerald-400' : 'text-rose-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
                    {income ? '+' : '−'}${a.toFixed(2)}
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
