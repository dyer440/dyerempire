// app/real-estate/import/import-client.tsx
'use client'
// Interactive assignment UI for the bank importer (Phase A — everything lands
// here for manual assignment; the rules engine in Phase B will pre-fill most
// of it). One expandable editor per pending row: Post (1 leg), Split (N legs),
// Link (tie to pre-existing ledger rows), or Exclude (personal).
import { useState, useTransition } from 'react'
import { postBankTxn, linkBankTxn, excludeBankTxn, revertBankTxn, type PostLeg } from './actions'

export type Property = { id: number; name: string }
export type Unit = { id: number; property_id: number; label: string }
export type Entity = { id: number; name: string }
export type Candidate = {
  id: number; amount: number; txn_date: string; category: string
  type: string; description: string | null; property: string | null
}
export type PendingRow = {
  id: number; txn_date: string; amount: number; display: string
  memo: string | null; candidates: Candidate[]
}
export type ResolvedRow = {
  id: number; txn_date: string; amount: number; display: string
  status: string; exclude_reason: string | null; legs: string | null
}

const money = (n: number) =>
  Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

type LegDraft = {
  target: string; amount: string; category: string; description: string
  isRent: boolean; unitId: string; rentalPeriod: string; isDeposit: boolean
}

function blankLeg(amount: number, period: string): LegDraft {
  return { target: '', amount: amount.toFixed(2), category: '', description: '',
           isRent: false, unitId: '', rentalPeriod: period, isDeposit: false }
}

export default function ImportClient({
  pending, resolved, properties, units, entities, categories,
}: {
  pending: PendingRow[]; resolved: ResolvedRow[]; properties: Property[]
  units: Unit[]; entities: Entity[]; categories: string[]
}) {
  const [openId, setOpenId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const run = (fn: () => Promise<unknown>) => {
    setError(null)
    startTransition(async () => {
      try { await fn(); setOpenId(null) }
      catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)) }
    })
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="border border-red-300 bg-red-50 text-red-700 rounded p-3 text-sm">{error}</div>
      )}

      <section>
        <h2 className="text-sm font-semibold mb-2">
          Needs assignment <span className="text-gray-500 font-normal">({pending.length})</span>
        </h2>
        <div className="border rounded divide-y">
          {pending.length === 0 && (
            <div className="p-4 text-sm text-gray-500">Nothing pending — upload a CSV above.</div>
          )}
          {pending.map(row => (
            <div key={row.id} className="p-3">
              <div className="flex items-center gap-3 text-sm">
                <span className="text-gray-500 whitespace-nowrap">{row.txn_date}</span>
                <span className="flex-1 truncate" title={row.memo || undefined}>{row.display}</span>
                <span className={`whitespace-nowrap font-medium ${row.amount < 0 ? '' : 'text-green-700'}`}>
                  {row.amount < 0 ? '−' : '+'}{money(row.amount)}
                </span>
                {row.candidates.length > 0 && (
                  <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-1.5 py-0.5 whitespace-nowrap">
                    {row.candidates.length} match{row.candidates.length > 1 ? 'es' : ''}
                  </span>
                )}
                <button
                  className="text-xs border rounded px-2 py-1 hover:bg-gray-50"
                  onClick={() => setOpenId(openId === row.id ? null : row.id)}
                >
                  {openId === row.id ? 'Close' : 'Assign'}
                </button>
              </div>
              {openId === row.id && (
                <RowEditor
                  row={row} properties={properties} units={units} entities={entities}
                  categories={categories} busy={isPending} run={run}
                />
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">
          Resolved <span className="text-gray-500 font-normal">(latest {resolved.length})</span>
        </h2>
        <div className="border rounded divide-y">
          {resolved.map(r => (
            <div key={r.id} className="p-2 flex items-center gap-3 text-xs">
              <span className="text-gray-500 whitespace-nowrap">{r.txn_date}</span>
              <span className="flex-1 truncate">{r.display}</span>
              <span className="whitespace-nowrap">{r.amount < 0 ? '−' : '+'}{money(r.amount)}</span>
              <span className={`rounded px-1.5 py-0.5 border whitespace-nowrap ${
                r.status === 'posted' ? 'bg-green-50 text-green-700 border-green-200'
                : r.status === 'linked' ? 'bg-blue-50 text-blue-700 border-blue-200'
                : 'bg-gray-50 text-gray-600 border-gray-200'
              }`}>
                {r.status}{r.exclude_reason ? `: ${r.exclude_reason}` : ''}
              </span>
              {r.legs && <span className="text-gray-500 truncate max-w-xs" title={r.legs}>{r.legs}</span>}
              <button
                className="border rounded px-2 py-0.5 hover:bg-gray-50"
                disabled={isPending}
                onClick={() => run(() => revertBankTxn(r.id))}
              >
                revert
              </button>
            </div>
          ))}
          {resolved.length === 0 && <div className="p-4 text-sm text-gray-500">Nothing resolved yet.</div>}
        </div>
      </section>
    </div>
  )
}

function RowEditor({
  row, properties, units, entities, categories, busy, run,
}: {
  row: PendingRow; properties: Property[]; units: Unit[]; entities: Entity[]
  categories: string[]; busy: boolean; run: (fn: () => Promise<unknown>) => void
}) {
  const isCredit = row.amount > 0
  const defaultPeriod = row.txn_date.slice(0, 7)
  const [legs, setLegs] = useState<LegDraft[]>([blankLeg(Math.abs(row.amount), defaultPeriod)])
  const [linkIds, setLinkIds] = useState<number[]>([])
  const legSum = legs.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const sumOk = Math.round(legSum * 100) === Math.round(Math.abs(row.amount) * 100)

  const setLeg = (i: number, patch: Partial<LegDraft>) =>
    setLegs(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  const buildLegs = (): PostLeg[] =>
    legs.map(l => ({
      target: l.target,
      amount: Number(l.amount),
      category: l.isRent ? 'Rental Income' : l.category,
      description: l.description || undefined,
      unitId: l.isRent && l.unitId ? Number(l.unitId) : undefined,
      rentalPeriod: l.isRent ? l.rentalPeriod : undefined,
      isDeposit: l.isDeposit,
    }))

  return (
    <div className="mt-3 border-t pt-3 space-y-3 text-sm">
      {legs.map((leg, i) => {
        const propMatch = /^property:(\d+)$/.exec(leg.target)
        const legUnits = propMatch ? units.filter(u => u.property_id === Number(propMatch[1])) : []
        return (
          <div key={i} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">Books</span>
              <select value={leg.target} onChange={e => setLeg(i, { target: e.target.value, isRent: false, unitId: '' })}
                      className="border rounded px-2 py-1">
                <option value="">— pick —</option>
                {entities.map(e => <option key={e.id} value={`entity:${e.id}`}>{e.name}</option>)}
                {properties.map(p => <option key={p.id} value={`property:${p.id}`}>{p.name}</option>)}
              </select>
            </label>
            {legs.length > 1 && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-500">Amount</span>
                <input type="number" step="0.01" value={leg.amount}
                       onChange={e => setLeg(i, { amount: e.target.value })}
                       className="border rounded px-2 py-1" />
              </label>
            )}
            {isCredit && propMatch && (
              <label className="flex items-center gap-1.5 pb-1.5">
                <input type="checkbox" checked={leg.isRent} onChange={e => setLeg(i, { isRent: e.target.checked })} />
                <span className="text-xs">Rent</span>
              </label>
            )}
            {leg.isRent ? (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">Unit</span>
                  <select value={leg.unitId} onChange={e => setLeg(i, { unitId: e.target.value })}
                          className="border rounded px-2 py-1">
                    <option value="">— unit —</option>
                    {legUnits.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-500">Period</span>
                  <input type="month" value={leg.rentalPeriod}
                         onChange={e => setLeg(i, { rentalPeriod: e.target.value })}
                         className="border rounded px-2 py-1" />
                </label>
              </>
            ) : (
              <label className="flex flex-col gap-1 col-span-2 sm:col-span-1">
                <span className="text-xs text-gray-500">Category</span>
                <input list="import-cats" value={leg.category}
                       onChange={e => setLeg(i, { category: e.target.value })}
                       className="border rounded px-2 py-1" />
              </label>
            )}
            <label className="flex flex-col gap-1 col-span-2 sm:col-span-1">
              <span className="text-xs text-gray-500">Description</span>
              <input value={leg.description} placeholder={row.display}
                     onChange={e => setLeg(i, { description: e.target.value })}
                     className="border rounded px-2 py-1" />
            </label>
            {isCredit && !leg.isRent && (
              <label className="flex items-center gap-1.5 pb-1.5">
                <input type="checkbox" checked={leg.isDeposit} onChange={e => setLeg(i, { isDeposit: e.target.checked })} />
                <span className="text-xs">Security deposit</span>
              </label>
            )}
            {legs.length > 1 && (
              <button className="text-xs text-red-600 hover:underline pb-2 text-left"
                      onClick={() => setLegs(ls => ls.filter((_, j) => j !== i))}>
                remove leg
              </button>
            )}
          </div>
        )
      })}

      {legs.length > 1 && (
        <div className={`text-xs ${sumOk ? 'text-gray-500' : 'text-red-600'}`}>
          Legs total {money(legSum)} of {money(row.amount)}{sumOk ? ' ✓' : ' — must match exactly'}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy || !sumOk} className="border rounded px-3 py-1.5 bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
                onClick={() => run(() => postBankTxn(row.id, buildLegs()))}>
          Post{legs.length > 1 ? ` ${legs.length} legs` : ''}
        </button>
        <button disabled={busy} className="border rounded px-3 py-1.5 hover:bg-gray-50"
                onClick={() => setLegs(ls => [...ls, blankLeg(0, defaultPeriod)])}>
          + Split
        </button>
        <button disabled={busy} className="border rounded px-3 py-1.5 hover:bg-gray-50"
                onClick={() => {
                  const reason = window.prompt('Exclude reason:', 'personal / not business')
                  if (reason !== null) run(() => excludeBankTxn(row.id, reason))
                }}>
          Exclude
        </button>
      </div>

      {row.candidates.length > 0 && (
        <div className="border rounded p-2 bg-blue-50/40">
          <div className="text-xs font-semibold mb-1">Possible existing entries (link instead of posting to avoid double-counting):</div>
          {row.candidates.map(c => (
            <label key={c.id} className="flex items-center gap-2 text-xs py-0.5">
              <input type="checkbox" checked={linkIds.includes(c.id)}
                     onChange={e => setLinkIds(ids => e.target.checked ? [...ids, c.id] : ids.filter(x => x !== c.id))} />
              <span className="text-gray-500">{c.txn_date}</span>
              <span>{c.property || 'entity-level'}</span>
              <span>· {c.category}</span>
              <span className="text-gray-500 truncate">{c.description}</span>
              <span className="ml-auto whitespace-nowrap">{money(c.amount)}</span>
            </label>
          ))}
          <button disabled={busy || linkIds.length === 0}
                  className="mt-1 border rounded px-3 py-1 text-xs hover:bg-white disabled:opacity-40"
                  onClick={() => run(() => linkBankTxn(row.id, linkIds))}>
            Link selected ({linkIds.length})
          </button>
        </div>
      )}

      <datalist id="import-cats">
        {categories.map(c => <option key={c} value={c} />)}
      </datalist>
    </div>
  )
}
