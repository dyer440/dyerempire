// app/real-estate/import/import-client.tsx
'use client'
// Interactive assignment UI for the bank importer (Phase A — everything lands
// here for manual assignment; the rules engine in Phase B will pre-fill most
// of it). One expandable editor per pending row: Post (1 leg), Split (N legs),
// Link (tie to pre-existing ledger rows), or Exclude (personal).
import { useState, useTransition } from 'react'
import {
  postBankTxn, linkBankTxn, excludeBankTxn, revertBankTxn, createRule,
  type PostLeg,
} from './actions'

export type Property = { id: number; name: string }
export type Unit = { id: number; property_id: number; label: string }
export type Entity = { id: number; name: string }
export type Candidate = {
  id: number; amount: number; txn_date: string; category: string
  type: string; description: string | null; property: string | null
}
export type Suggestion = {
  ruleId: number
  kind: 'post' | 'exclude'
  target?: string
  category?: string
  isRent?: boolean
  unitId?: number | null
  isDeposit?: boolean
  needsProperty?: boolean
  reason?: string
  note?: string | null
}
export type PendingRow = {
  id: number; txn_date: string; amount: number; display: string
  name_norm: string; is_check: boolean
  memo: string | null; candidates: Candidate[]; suggestion: Suggestion | null
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

  const targetLabel = (target?: string) => {
    if (!target) return ''
    const m = /^(property|entity):(\d+)$/.exec(target)
    if (!m) return target
    const id = Number(m[2])
    return m[1] === 'entity'
      ? entities.find(e => e.id === id)?.name ?? target
      : properties.find(p => p.id === id)?.name ?? target
  }

  // A suggestion is "confident" (one-click) when it's an exclude, or a post
  // that already knows its destination. Category-only hints still need a pick.
  const isConfident = (s: Suggestion | null) =>
    !!s && (s.kind === 'exclude' || (s.kind === 'post' && !!s.target && !s.needsProperty))

  const suggestionText = (s: Suggestion) => {
    if (s.kind === 'exclude') return `Exclude — ${s.reason}`
    const dest = targetLabel(s.target)
    if (s.isRent) return `Rent → ${dest}`
    if (s.needsProperty) return `${s.category} — pick property`
    return `${dest} · ${s.category}`
  }

  const acceptSuggestion = (row: PendingRow) => {
    const s = row.suggestion!
    if (s.kind === 'exclude') {
      return run(() => excludeBankTxn(row.id, s.reason || 'excluded', s.ruleId))
    }
    const leg: PostLeg = {
      target: s.target!,
      amount: Math.abs(row.amount),
      category: s.isRent ? 'Rental Income' : s.category || '',
      unitId: s.isRent && s.unitId ? s.unitId : undefined,
      rentalPeriod: s.isRent ? row.txn_date.slice(0, 7) : undefined,
      isDeposit: s.isDeposit,
    }
    return run(() => postBankTxn(row.id, [leg], s.ruleId))
  }

  // Sort: confident suggestions first (fast skim-and-accept), then hints, then unmatched.
  const orderedPending = [...pending].sort((a, b) => {
    const rank = (r: PendingRow) => (isConfident(r.suggestion) ? 0 : r.suggestion ? 1 : 2)
    return rank(a) - rank(b) || a.txn_date.localeCompare(b.txn_date)
  })
  const confidentCount = pending.filter(r => isConfident(r.suggestion)).length

  return (
    <div className="space-y-6">
      {error && (
        <div className="border border-red-300 bg-red-50 text-red-700 rounded p-3 text-sm">{error}</div>
      )}

      <section>
        <h2 className="text-sm font-semibold mb-2">
          Needs assignment <span className="text-gray-500 font-normal">({pending.length})</span>
          {confidentCount > 0 && (
            <span className="ml-2 text-xs text-green-700 font-normal">
              {confidentCount} suggested — review &amp; accept
            </span>
          )}
        </h2>
        <div className="border rounded divide-y">
          {pending.length === 0 && (
            <div className="p-4 text-sm text-gray-500">Nothing pending — upload a CSV above.</div>
          )}
          {orderedPending.map(row => {
            const s = row.suggestion
            const confident = isConfident(s)
            const accent = confident
              ? (s!.kind === 'exclude' ? 'border-l-4 border-l-gray-300' : 'border-l-4 border-l-green-400')
              : s ? 'border-l-4 border-l-amber-300' : ''
            return (
              <div key={row.id} className={`p-3 ${accent}`}>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-gray-500 whitespace-nowrap">{row.txn_date}</span>
                  <span className="flex-1 truncate" title={row.memo || undefined}>{row.display}</span>
                  <span className={`whitespace-nowrap font-medium ${row.amount < 0 ? '' : 'text-green-700'}`}>
                    {row.amount < 0 ? '−' : '+'}{money(row.amount)}
                  </span>
                  {s && (
                    <span
                      className={`text-xs rounded px-1.5 py-0.5 border whitespace-nowrap ${
                        s.kind === 'exclude' ? 'bg-gray-50 text-gray-600 border-gray-200'
                        : s.needsProperty ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : 'bg-green-50 text-green-700 border-green-200'
                      }`}
                      title={s.note || undefined}
                    >
                      {suggestionText(s)}
                    </span>
                  )}
                  {row.candidates.length > 0 && (
                    <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-1.5 py-0.5 whitespace-nowrap">
                      {row.candidates.length} match{row.candidates.length > 1 ? 'es' : ''}
                    </span>
                  )}
                  {confident && (
                    <button
                      className="text-xs border rounded px-2 py-1 bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
                      disabled={isPending}
                      onClick={() => acceptSuggestion(row)}
                    >
                      Accept
                    </button>
                  )}
                  <button
                    className="text-xs border rounded px-2 py-1 hover:bg-gray-50"
                    onClick={() => setOpenId(openId === row.id ? null : row.id)}
                  >
                    {openId === row.id ? 'Close' : confident ? 'Edit' : 'Assign'}
                  </button>
                </div>
                {openId === row.id && (
                  <RowEditor
                    row={row} properties={properties} units={units} entities={entities}
                    categories={categories} busy={isPending} run={run}
                  />
                )}
              </div>
            )
          })}
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
  const s = row.suggestion
  // Pre-fill the first leg from a post-suggestion (rent or expense) if present.
  const seededLeg: LegDraft = (() => {
    const base = blankLeg(Math.abs(row.amount), defaultPeriod)
    if (s && s.kind === 'post') {
      return {
        ...base,
        target: s.target || '',
        category: s.isRent ? '' : s.category || '',
        isRent: !!s.isRent,
        unitId: s.unitId ? String(s.unitId) : '',
        isDeposit: !!s.isDeposit,
      }
    }
    return base
  })()
  const [legs, setLegs] = useState<LegDraft[]>([seededLeg])
  const [linkIds, setLinkIds] = useState<number[]>([])
  const [remember, setRemember] = useState(false)
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

  // A check number never recurs, so a check's rule keys on amount alone (the
  // fire fees identify by amount); everything else keys on the counterparty.
  const ruleKeyFor = (r: PendingRow): { pattern: string; amount: number | null } =>
    r.is_check
      ? { pattern: '', amount: Math.abs(r.amount) }
      : { pattern: r.name_norm, amount: null }

  // Turn a single-leg assignment into a rule mirroring that disposition.
  const maybeCreateRuleFromLeg = async (r: PendingRow, leg: LegDraft) => {
    const m = /^(property|entity):(\d+)$/.exec(leg.target)
    if (!m) return
    const appliesTo: 'debit' | 'credit' = r.amount > 0 ? 'credit' : 'debit'
    await createRule({
      ...ruleKeyFor(r),
      appliesTo,
      targetKind: m[1] === 'entity' ? 'entity' : 'property',
      propertyId: m[1] === 'property' ? Number(m[2]) : null,
      entityId: m[1] === 'entity' ? Number(m[2]) : null,
      category: leg.isRent ? 'Rental Income' : leg.category || null,
      isRent: leg.isRent,
      unitId: leg.isRent && leg.unitId ? Number(leg.unitId) : null,
      isDeposit: leg.isDeposit,
      note: `learned from "${r.display}"`,
    })
  }

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

      {/* Remember-this: only offered for a single-leg assignment (splits vary
          per transaction, so they don't generalize into a rule). The pattern
          is the counterparty; amount is included when it's the identifying
          signal (e.g. the per-property fire fees). */}
      {legs.length === 1 && (
        <label className="flex items-center gap-1.5 text-xs text-gray-600">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          Remember: auto-suggest “{row.display}” next time
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy || !sumOk} className="border rounded px-3 py-1.5 bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
                onClick={() => run(async () => {
                  await postBankTxn(row.id, buildLegs())
                  if (remember && legs.length === 1) await maybeCreateRuleFromLeg(row, legs[0])
                })}>
          Post{legs.length > 1 ? ` ${legs.length} legs` : ''}
        </button>
        <button disabled={busy} className="border rounded px-3 py-1.5 hover:bg-gray-50"
                onClick={() => setLegs(ls => [...ls, blankLeg(0, defaultPeriod)])}>
          + Split
        </button>
        <button disabled={busy} className="border rounded px-3 py-1.5 hover:bg-gray-50"
                onClick={() => {
                  const reason = window.prompt('Exclude reason:', 'personal / not business')
                  if (reason === null) return
                  run(async () => {
                    await excludeBankTxn(row.id, reason)
                    if (remember) {
                      await createRule({
                        ...ruleKeyFor(row),
                        targetKind: 'exclude', excludeReason: reason,
                        note: `learned from "${row.display}"`,
                      })
                    }
                  })
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
