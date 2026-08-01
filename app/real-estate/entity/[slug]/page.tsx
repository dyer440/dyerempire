// app/real-estate/entity/[slug]/page.tsx
// Generic entity ledger — the own books of any non-property entity (SL Cap Mgmt,
// SL Trading, SL Media). Generalizes the hardcoded /slcm page: same year switcher,
// income/expense/net cards, category rollup, ledger table, inline add/delete for
// editors. Shows only entity-level rows (entity_id set, property_id NULL).
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { addEntityTransaction, deleteEntityTransaction } from './actions'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

type Txn = {
  id: number; type: string; amount: number; category: string
  txn_date: string; description: string | null
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default async function EntityLedgerPage({
  params, searchParams,
}: {
  params: { slug: string } | Promise<{ slug: string }>
  searchParams: { year?: string } | Promise<{ year?: string }>
}) {
  const { slug } = await Promise.resolve(params)
  const sp = await Promise.resolve(searchParams)
  const currentYear = new Date().getFullYear()
  const year = /^\d{4}$/.test(sp.year || '') ? Number(sp.year) : currentYear

  const entityRows = (await sql`
    SELECT id, name, legal_name, dba, type FROM entities
    WHERE slug = ${slug} AND type <> 'property' LIMIT 1
  `) as Record<string, any>[]

  if (!entityRows[0]) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">Entity ledger</h1>
        <p className="text-red-600">No entity found for “{slug}”. Check the slug or run the entity migration.</p>
      </div>
    )
  }
  const entity = entityRows[0]

  const txns = (
    (await sql`
      SELECT t.id, t.type, t.amount::float8 AS amount, t.category,
             to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date, t.description
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
  const categories = [...byCategory.entries()].sort(
    (a, b) => b[1].expense + b[1].income - (a[1].expense + a[1].income),
  )

  const editor = await getEditorEmail()
  const today = new Date().toISOString().slice(0, 10)

  const addAction = addEntityTransaction.bind(null, slug)
  const deleteAction = deleteEntityTransaction.bind(null, slug)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{entity.name}</h1>
        <p className="text-sm text-gray-500">
          {entity.legal_name}{entity.dba ? ` · dba ${entity.dba}` : ''} — entity ledger
          (company-level only; property expenses live on property books)
        </p>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <Link href={`/real-estate/entity/${slug}?year=${year - 1}`} className="px-2 py-1 border rounded hover:bg-gray-50">← {year - 1}</Link>
        <span className="font-medium">{year}</span>
        <Link href={`/real-estate/entity/${slug}?year=${year + 1}`} className="px-2 py-1 border rounded hover:bg-gray-50">{year + 1} →</Link>
        {year !== currentYear && (
          <Link href={`/real-estate/entity/${slug}`} className="px-2 py-1 border rounded hover:bg-gray-50">Today</Link>
        )}
      </div>

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

      {editor && (
        <form action={addAction} className="border rounded p-4 grid grid-cols-2 sm:grid-cols-6 gap-2 text-sm items-end">
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
            <input name="category" required placeholder="Software, Payroll…" className="border rounded px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Amount</span>
            <input type="number" name="amount" step="0.01" min="0.01" required className="border rounded px-2 py-1" />
          </label>
          <label className="flex flex-col gap-1 col-span-2 sm:col-span-1">
            <span className="text-xs text-gray-500">Description</span>
            <input name="description" placeholder="optional" className="border rounded px-2 py-1" />
          </label>
          <button type="submit" className="border rounded px-3 py-1.5 bg-gray-900 text-white hover:bg-gray-700">Add</button>
        </form>
      )}

      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-gray-500 border-b">
              <th className="p-2">Date</th><th className="p-2">Category</th>
              <th className="p-2">Description</th><th className="p-2 text-right">Amount</th><th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {txns.length === 0 && (
              <tr><td colSpan={5} className="p-4 text-center text-gray-500">No entity-level transactions in {year}.</td></tr>
            )}
            {txns.map(t => (
              <tr key={t.id} className="border-t">
                <td className="p-2 whitespace-nowrap">{t.txn_date}</td>
                <td className="p-2">{t.category}</td>
                <td className="p-2 text-gray-600">{t.description}</td>
                <td className={`p-2 text-right whitespace-nowrap ${t.type === 'expense' ? '' : 'text-green-700'}`}>
                  {t.type === 'expense' ? '−' : '+'}{money(t.amount)}
                </td>
                <td className="p-2 text-right">
                  {editor && (
                    <form action={deleteAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <button type="submit" className="text-xs text-red-600 hover:underline">delete</button>
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
