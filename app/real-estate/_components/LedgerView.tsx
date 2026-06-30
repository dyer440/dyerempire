'use client'
// app/real-estate/_components/LedgerView.tsx
// One unified, chronological ledger that interleaves actual transactions and
// scheduled (forecast) items. Used in two places:
//   - per-property:  app/real-estate/[id]/ledger/page.tsx  (showProperty = false)
//   - cross-property: app/real-estate/southside/page.tsx    (showProperty = true)
// Light theme to match the rest of the real-estate pages (Betsy's primary view).
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { addTransaction, confirmScheduled, updateTransaction, deleteTransaction } from '@/app/real-estate/ledger-actions'

export type LedgerRow = {
  id: number
  property_id: number
  property_name: string
  type: string // 'income' | 'expense'
  category: string
  amount: number // positive
  txn_date: string // 'YYYY-MM-DD'
  description: string | null
  status: string // 'actual' | 'forecast'
  locked: boolean // date falls in a closed period
}

type PropertyOpt = { id: number; name: string }

const CATEGORIES = [
  'Rental Income', 'Other Income',
  'Property Taxes', 'Insurance', 'Repairs & Maintenance', 'Contractors',
  'Utilities', 'Refuse', 'Fire Fee', 'Sanitary', 'Management',
  'Mortgage Interest', 'Supplies', 'Legal & Professional', 'Bank Fees', 'Other Expense',
]

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const monthLabel = (d: string) => {
  const [y, m] = d.split('-')
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

const dayLabel = (d: string) => {
  const [y, m, day] = d.split('-')
  return `${m}/${day}/${y}`
}

type Draft = { type: string; category: string; amount: string; txnDate: string; description: string }

export default function LedgerView({
  rows,
  properties,
  showProperty,
  defaultPropertyId,
}: {
  rows: LedgerRow[]
  properties: PropertyOpt[]
  showProperty: boolean
  defaultPropertyId?: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Inline edit state
  const [editId, setEditId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  // Client-side property filter (cross-property view only)
  const [filterProp, setFilterProp] = useState<number | 'all'>('all')

  // Add-row state
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`
  const [adding, setAdding] = useState(false)
  const [addProp, setAddProp] = useState<number>(defaultPropertyId ?? properties[0]?.id ?? 0)
  const [addDraft, setAddDraft] = useState<Draft>({
    type: 'expense', category: '', amount: '', txnDate: todayStr, description: '',
  })

  const run = (fn: () => Promise<void>) => {
    setError(null)
    startTransition(async () => {
      try {
        await fn()
        setEditId(null)
        setDraft(null)
        router.refresh()
      } catch (e: any) {
        setError(e?.message || 'Something went wrong. Try again.')
      }
    })
  }

  const beginEdit = (r: LedgerRow) => {
    setError(null)
    setEditId(r.id)
    setDraft({
      type: r.type,
      category: r.category,
      amount: String(r.amount),
      txnDate: r.txn_date,
      description: r.description || '',
    })
  }

  const draftPayload = (d: Draft) => ({
    type: d.type,
    category: d.category,
    amount: Number(d.amount),
    txnDate: d.txnDate,
    description: d.description,
  })

  const visible = showProperty && filterProp !== 'all'
    ? rows.filter((r) => r.property_id === filterProp)
    : rows

  // Group rows by month for a clean monthly/quarterly scan.
  const groups: { key: string; label: string; rows: LedgerRow[] }[] = []
  for (const r of visible) {
    const key = r.txn_date.slice(0, 7)
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) {
      g = { key, label: monthLabel(r.txn_date), rows: [] }
      groups.push(g)
    }
    g.rows.push(r)
  }

  const colCount = showProperty ? 7 : 6
  const inputCls =
    'w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 bg-white focus:outline-none focus:ring-1 focus:ring-gray-400'

  return (
    <div className="text-gray-900">
      <datalist id="ledger-categories">
        {CATEGORIES.map((c) => <option key={c} value={c} />)}
      </datalist>

      {error && (
        <div className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" /> Scheduled (tap Confirm once it clears)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-gray-300" /> Locked (closed period)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {showProperty && (
            <select
              className={inputCls + ' w-auto'}
              value={filterProp}
              onChange={(e) => setFilterProp(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            >
              <option value="all">All properties</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <button
            onClick={() => { setAdding((v) => !v); setError(null) }}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
          >
            {adding ? 'Cancel' : '+ Add transaction'}
          </button>
        </div>
      </div>

      {adding && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
            {showProperty && (
              <select className={inputCls} value={addProp} onChange={(e) => setAddProp(Number(e.target.value))}>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <input type="date" className={inputCls} value={addDraft.txnDate}
              onChange={(e) => setAddDraft({ ...addDraft, txnDate: e.target.value })} />
            <select className={inputCls} value={addDraft.type}
              onChange={(e) => setAddDraft({ ...addDraft, type: e.target.value })}>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
            <input className={inputCls} list="ledger-categories" placeholder="Category" value={addDraft.category}
              onChange={(e) => setAddDraft({ ...addDraft, category: e.target.value })} />
            <input className={inputCls} type="number" step="0.01" min="0" placeholder="Amount" value={addDraft.amount}
              onChange={(e) => setAddDraft({ ...addDraft, amount: e.target.value })} />
            <input className={inputCls} placeholder="Description (optional)" value={addDraft.description}
              onChange={(e) => setAddDraft({ ...addDraft, description: e.target.value })} />
          </div>
          <div className="mt-2 flex justify-end">
            <button
              disabled={pending}
              onClick={() => run(async () => {
                await addTransaction({ propertyId: showProperty ? addProp : (defaultPropertyId as number), ...draftPayload(addDraft) })
                setAddDraft({ type: 'expense', category: '', amount: '', txnDate: todayStr, description: '' })
                setAdding(false)
              })}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Add transaction
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2 font-medium">Date</th>
              {showProperty && <th className="px-3 py-2 font-medium">Property</th>}
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td colSpan={colCount + 1} className="px-3 py-8 text-center text-gray-500">
                Nothing in this window yet. Add a transaction, or widen the date range.
              </td></tr>
            )}
            {groups.map((g) => (
              <GroupRows
                key={g.key}
                group={g}
                colCount={colCount + 1}
                showProperty={showProperty}
                editId={editId}
                draft={draft}
                setDraft={setDraft}
                pending={pending}
                inputCls={inputCls}
                beginEdit={beginEdit}
                cancelEdit={() => { setEditId(null); setDraft(null); setError(null) }}
                onConfirm={(id, d) => run(() => confirmScheduled(id, draftPayload(d)))}
                onSave={(id, d) => run(() => updateTransaction(id, draftPayload(d)))}
                onDelete={(id) => run(() => deleteTransaction(id))}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GroupRows({
  group, colCount, showProperty, editId, draft, setDraft, pending, inputCls,
  beginEdit, cancelEdit, onConfirm, onSave, onDelete,
}: {
  group: { label: string; rows: LedgerRow[] }
  colCount: number
  showProperty: boolean
  editId: number | null
  draft: Draft | null
  setDraft: (d: Draft) => void
  pending: boolean
  inputCls: string
  beginEdit: (r: LedgerRow) => void
  cancelEdit: () => void
  onConfirm: (id: number, d: Draft) => void
  onSave: (id: number, d: Draft) => void
  onDelete: (id: number) => void
}) {
  return (
    <>
      <tr className="bg-gray-100/70">
        <td colSpan={colCount} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {group.label}
        </td>
      </tr>
      {group.rows.map((r) => {
        const editing = editId === r.id && draft
        const signed = r.type === 'income' ? r.amount : -r.amount
        const isForecast = r.status === 'forecast'

        if (editing && draft) {
          return (
            <tr key={r.id} className="border-t border-gray-200 bg-blue-50/40 align-top">
              <td className="px-3 py-2">
                <input type="date" className={inputCls} value={draft.txnDate}
                  onChange={(e) => setDraft({ ...draft, txnDate: e.target.value })} />
              </td>
              {showProperty && <td className="px-3 py-2 text-gray-500">{r.property_name}</td>}
              <td className="px-3 py-2">
                <div className="flex flex-col gap-1">
                  <select className={inputCls} value={draft.type}
                    onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                    <option value="income">Income</option>
                    <option value="expense">Expense</option>
                  </select>
                  <input className={inputCls} list="ledger-categories" value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
                </div>
              </td>
              <td className="px-3 py-2">
                <input className={inputCls} value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </td>
              <td className="px-3 py-2">
                <input type="number" step="0.01" min="0" className={inputCls + ' text-right'} value={draft.amount}
                  onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
              </td>
              <td className="px-3 py-2 text-xs text-gray-500">{isForecast ? 'Scheduled' : 'Actual'}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap justify-end gap-1">
                  {isForecast && (
                    <button disabled={pending} onClick={() => onConfirm(r.id, draft)}
                      className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                      Confirm as actual
                    </button>
                  )}
                  <button disabled={pending} onClick={() => onSave(r.id, draft)}
                    className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50">
                    {isForecast ? 'Save scheduled' : 'Save'}
                  </button>
                  <button disabled={pending} onClick={cancelEdit}
                    className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100">
                    Cancel
                  </button>
                </div>
              </td>
            </tr>
          )
        }

        return (
          <tr key={r.id} className={'border-t border-gray-200 ' + (isForecast ? 'bg-amber-50/60' : 'bg-white') + (r.locked ? ' opacity-60' : '')}>
            <td className="whitespace-nowrap px-3 py-2 text-gray-700">{dayLabel(r.txn_date)}</td>
            {showProperty && <td className="whitespace-nowrap px-3 py-2 text-gray-600">{r.property_name}</td>}
            <td className="px-3 py-2 text-gray-800">{r.category}</td>
            <td className="px-3 py-2 text-gray-500">{r.description || '—'}</td>
            <td className={'whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums ' + (signed < 0 ? 'text-red-600' : 'text-emerald-700')}>
              {usd(signed)}
            </td>
            <td className="px-3 py-2">
              {isForecast
                ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Scheduled</span>
                : <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Actual</span>}
            </td>
            <td className="px-3 py-2">
              <div className="flex flex-wrap justify-end gap-1">
                {r.locked ? (
                  <span className="text-xs text-gray-400">Locked</span>
                ) : (
                  <>
                    {isForecast && (
                      <button onClick={() => beginEdit(r)}
                        className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500">
                        Confirm
                      </button>
                    )}
                    <button onClick={() => beginEdit(r)}
                      className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100">
                      Edit
                    </button>
                    <button onClick={() => { if (confirm('Delete this item?')) onDelete(r.id) }}
                      className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-500 hover:bg-gray-100">
                      Delete
                    </button>
                  </>
                )}
              </div>
            </td>
          </tr>
        )
      })}
    </>
  )
}
