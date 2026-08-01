// app/real-estate/import/distribute/distribute-client.tsx
'use client'
// Grid for distributing identical-amount fee rows across properties. Pick which
// properties share the fee and a category, hit "Distribute evenly" to round-robin
// one row per property (in date order, so each month lands one-per-property),
// tweak any row, then Post all. Each row books its full amount to one property.
import { useState, useMemo, useTransition } from 'react'
import { postFeeBatch, type FeeAssignment } from '../actions'

export type Property = { id: number; name: string }
export type FeeRow = { id: number; txn_date: string; amount: number; display: string }

const money = (n: number) =>
  Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default function DistributeClient({
  amount, rows, properties, defaultCategory,
}: {
  amount: number; rows: FeeRow[]; properties: Property[]; defaultCategory: string
}) {
  const [category, setCategory] = useState(defaultCategory)
  const [selectedProps, setSelectedProps] = useState<number[]>(properties.map(p => p.id))
  const [assign, setAssign] = useState<Record<number, number | ''>>(
    Object.fromEntries(rows.map(r => [r.id, '' as const])),
  )
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const ordered = useMemo(
    () => [...rows].sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.id - b.id),
    [rows],
  )

  const distribute = () => {
    const picks = properties.filter(p => selectedProps.includes(p.id))
    if (picks.length === 0) return
    // Round-robin per month so each calendar month lands one row per property.
    const next: Record<number, number | ''> = {}
    const perMonth = new Map<string, number>()
    for (const r of ordered) {
      const month = r.txn_date.slice(0, 7)
      const i = perMonth.get(month) ?? 0
      next[r.id] = picks[i % picks.length].id
      perMonth.set(month, i + 1)
    }
    setAssign(next)
  }

  const assignedCount = ordered.filter(r => assign[r.id] !== '').length

  const post = () => {
    setError(null); setDone(null)
    const payload: FeeAssignment[] = ordered
      .filter(r => assign[r.id] !== '')
      .map(r => ({ bankTxnId: r.id, propertyId: Number(assign[r.id]), category }))
    if (payload.length === 0) { setError('Assign at least one row first.'); return }
    if (!category.trim()) { setError('Set a category.'); return }
    startTransition(async () => {
      try {
        const res = await postFeeBatch(payload)
        setDone(`Posted ${res.posted}${res.skipped.length ? `, skipped ${res.skipped.length}` : ''}.`)
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  return (
    <div className="space-y-4">
      {error && <div className="border border-red-300 bg-red-50 text-red-700 rounded p-3 text-sm">{error}</div>}
      {done && <div className="border border-green-300 bg-green-50 text-green-800 rounded p-3 text-sm">{done}</div>}

      <div className="border rounded p-4 space-y-3 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Category for all</span>
            <input value={category} onChange={e => setCategory(e.target.value)}
                   list="dist-cats" className="border rounded px-2 py-1" />
            <datalist id="dist-cats">
              <option value="Municipal Fees" /><option value="Utilities" />
            </datalist>
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Properties that share this fee</span>
            <div className="flex flex-wrap gap-2">
              {properties.map(p => (
                <label key={p.id} className="flex items-center gap-1 text-xs border rounded px-2 py-1">
                  <input type="checkbox" checked={selectedProps.includes(p.id)}
                         onChange={e => setSelectedProps(s =>
                           e.target.checked ? [...s, p.id] : s.filter(x => x !== p.id))} />
                  {p.name}
                </label>
              ))}
            </div>
          </div>
          <button onClick={distribute} disabled={isPending}
                  className="border rounded px-3 py-1.5 hover:bg-gray-50">
            Distribute evenly
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Each {money(amount)} row books its full amount to the chosen property. Even distribution
          gives every selected property one row per month — the per-property total is correct even
          though which line goes where is arbitrary for identical fees.
        </p>
      </div>

      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-gray-500 border-b">
              <th className="p-2">Date</th>
              <th className="p-2">Counterparty</th>
              <th className="p-2 text-right">Amount</th>
              <th className="p-2">Property</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map(r => (
              <tr key={r.id} className="border-t">
                <td className="p-2 whitespace-nowrap">{r.txn_date}</td>
                <td className="p-2 truncate">{r.display}</td>
                <td className="p-2 text-right whitespace-nowrap">−{money(r.amount)}</td>
                <td className="p-2">
                  <select value={assign[r.id]} onChange={e =>
                    setAssign(a => ({ ...a, [r.id]: e.target.value === '' ? '' : Number(e.target.value) }))}
                    className="border rounded px-2 py-1">
                    <option value="">— unassigned —</option>
                    {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={post} disabled={isPending || assignedCount === 0}
                className="border rounded px-4 py-1.5 bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40">
          Post {assignedCount} assigned
        </button>
        <span className="text-xs text-gray-500">{assignedCount} of {ordered.length} assigned</span>
      </div>
    </div>
  )
}
