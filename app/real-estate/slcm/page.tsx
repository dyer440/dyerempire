// app/real-estate/slcm/page.tsx
// SL Cap Mgmt (Second Line Capital Management LLC / "Southside Properties")
// entity ledger — the management company's OWN books. Shows only entity-level
// rows (entity_id = management_co, property_id NULL); property expenses stay on
// property books. Minimal by design: year switcher, category summary, ledger
// table, inline add/delete for editors. Server component; direct SQL.
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { addSlcmTransaction, deleteSlcmTransaction } from './actions'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

type Txn = {
  id: number
  type: string
  amount: number
  category: string
  txn_date: string
  description: string | null
  method: string | null
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default async function SlcmLedgerPage({
  searchParams,
}: {
  // Promise in Next 15, plain object in Next 14 — Promise.resolve handles both.
  searchParams: { year?: string } | Promise<{ year?: string }>
}) {
  const params = await Promise.resolve(searchParams)
  const currentYear = new Date().getFullYear()
  const year = /^\d{4}$/.test(params.year || '') ? Number(params.year) : currentYear

  const entityRows = (await sql`
    SELECT id, name, legal_name, dba FROM entities WHERE type = 'management_co' LIMIT 1
  `) as Record<string, any>[]

  if (!entityRows[0]) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">SL Cap Mgmt</h1>
        <p className="text-red-600">
          No management_co entity found. Run <code>migrations/2026-07_entity_slcm.sql</code> in Neon, then reload.
        </p>
      </div>
    )
  }
  const entity = entityRows[0]

  const txns = (
    (await sql`
      SELECT t.id, t.type, t.amount::float8 AS amount, t.category,
             to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date,
             t.description, t.method
      FROM transactions t
      WHERE t.entity_id = ${entity.id}
        AND t.property_id IS NULL
        AND t.status = 'actual'
        AND EXTRACT(YEAR FROM t.txn_date) = ${year}
      ORDER BY t.txn_date DESC, t.id DESC
    `) as Record<string, any>[]
  ) as Txn[]

  const income = txns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0)
  const expenses = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)

  const byCategory = new Map<string, { income: number; expense: number }>()
  for (const t of txns) {
    const row = byCategory.get(t.category) || { income: 0, expense: 0 }
    if (t.type === 'income') row.income += t.amount
    else row.expense += t.amount
    byCategory.set(t.category, row)
  }
  const categories = [...byCategory.entries()].sort((a, b) =>
    b[1].expense + b[1].income - (a[1].expense + a[1].income),
  )

  const editor = await getEditorEmail()
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{entity.name}</h1>
        <p className="text-sm text-gray-500">
          {entity.legal_name}
          {entity.dba ? ` · dba ${entity.dba}` : ''} — entity ledger (company-level only; property
          expenses live on property books)
        </p>
      </div>

      {/* Year switcher */}
      <div className="flex items-center gap-3 text-sm">
        <Link href={`/real-estate/slcm?year=${year - 1}`} className="px-2 py-1 border rounded hover:bg-gray-50">
          ← {year - 1}
        </Link>
        <span className="font-medium">{year}</span>
        <Link href={`/real-estate/slcm?year=${year + 1}`} className="px-2 py-1 border rounded hover:bg-gray-50">
          {year + 1} →
        </Link>
        {year !== currentYear && (
          <Link href="/real-estate/slcm" className="px-2 py-1 border rounded hover:bg-gray-50">
            Today
          </Link>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="border rounded p-4">
          <div className="text-xs uppercase text-gray-500">Income ({year})</div>
          <div className="text-xl font-semibold">{money(income)}</div>
        </div>
        <div className="border rounded p-4">
          <div className="text-xs uppercase text-gray-500">Expenses ({year})</div>
          <div className="text-xl font-semibold">{money(expenses)}</div>
        </div>
        <div className="border rounded p-4">
          <div className="text-xs uppercase text-gray-500">Net ({year})</div>
          <div className={`text-xl font-semibold ${income - expenses < 0 ? 'text-red-600' : ''}`}>
            {money(income - expenses)}
          </div>
        </div>
      </div>

      {/* Category summary */}
      {categories.length > 0 && (
        <div className="border rounded p-4">
          <h2 className="text-sm font-semibold mb-2">By category</h2>
          <table className="w-full text-sm">
            <tbody>
              {categories.map(([cat, v]) => (
                <tr key={cat} className="border-t">
                  <td className="py-1">{cat}</td>
                  <td className="py-1 text-right">
                    {v.income > 0 && <span className="mr-3 text-green-700">+{money(v.income)}</span>}
                    {v.expense > 0 && <span>−{money(v.expense)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add form (editors only) */}
      {editor && (
        <form action={addSlcmTransaction} className="border rounded p-4 grid grid-cols-2 sm:grid-cols-6 gap-2 text-sm items-end">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Type</span>
            <select name="type" defaultValue="expense" className="border rounded px-2 py-1">
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Date</span>
            <input type="date" name="txnDate" defaultValue={today} required className="border rounded px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Category</span>
            <input name="category" required placeholder="Payroll, Insurance…" list="slcm-cats" className="border rounded px-2 py-1" />
            <datalist id="slcm-cats">
              <option value="Payroll" />
              <option value="Payroll Fees" />
              <option value="Insurance" />
              <option value="Bank Fees" />
              <option value="Management Fee Income" />
              <option value="Other Misc. Expenses" />
            </datalist>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Amount</span>
            <input type="number" name="amount" step="0.01" min="0.01" required className="border rounded px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1 col-span-2 sm:col-span-1">
            <span className="text-xs text-gray-500">Description</span>
            <input name="description" placeholder="optional" className="border rounded px-2 py-1" />
          </label>
          <button type="submit" className="border rounded px-3 py-1.5 bg-gray-900 text-white hover:bg-gray-700">
            Add
          </button>
        </form>
      )}

      {/* Ledger table */}
      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-gray-500 border-b">
              <th className="p-2">Date</th>
              <th className="p-2">Category</th>
              <th className="p-2">Description</th>
              <th className="p-2 text-right">Amount</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {txns.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-gray-500">
                  No entity-level transactions in {year}.
                </td>
              </tr>
            )}
            {txns.map(t => (
              <tr key={t.id} className="border-t">
                <td className="p-2 whitespace-nowrap">{t.txn_date}</td>
                <td className="p-2">{t.category}</td>
                <td className="p-2 text-gray-600">{t.description}</td>
                <td className={`p-2 text-right whitespace-nowrap ${t.type === 'expense' ? '' : 'text-green-700'}`}>
                  {t.type === 'expense' ? '−' : '+'}
                  {money(t.amount)}
                </td>
                <td className="p-2 text-right">
                  {editor && (
                    <form action={deleteSlcmTransaction}>
                      <input type="hidden" name="id" value={t.id} />
                      <button type="submit" className="text-xs text-red-600 hover:underline">
                        delete
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
