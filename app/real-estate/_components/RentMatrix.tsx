'use client'
// app/real-estate/_components/RentMatrix.tsx
// Rent roll laid out like the spreadsheet: properties (and their units) across
// the top, rental months down the side. Each cell holds one or more payments for
// that unit × month — confirmed actuals, confirmable scheduled rents, or empty.
// Everything books into the shared income ledger. Light theme to match Southside.
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  addRentPayment, confirmRentPayment, editRentPayment, deleteRentPayment, setTenant,
} from '@/app/real-estate/southside/rent-actions'

export type RentColumn = {
  key: string
  propertyId: number
  unitId: number | null
  propertyName: string
  unitLabel: string | null
  tenant: string | null
}
export type RentPayment = {
  id: number
  amount: number
  date: string // YYYY-MM-DD
  status: string // actual | forecast
  isDeposit: boolean
  locked: boolean
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd2 = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const monthLabel = (p: string) => {
  const [y, m] = p.split('-')
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}
const shortDate = (d: string) => {
  const [, m, day] = d.split('-')
  return `${Number(m)}/${Number(day)}`
}

export default function RentMatrix({
  columns,
  months,
  cells,
}: {
  columns: RentColumn[]
  months: string[]
  cells: Record<string, RentPayment[]>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<{ col: RentColumn; period: string } | null>(null)
  const [editingTenant, setEditingTenant] = useState<string | null>(null)

  const run = (fn: () => Promise<void>) => {
    setError(null)
    startTransition(async () => {
      try { await fn(); router.refresh() }
      catch (e: any) { setError(e?.message || 'Something went wrong.') }
    })
  }

  // Property header groups (columns are pre-sorted property → unit).
  const groups: { propertyName: string; span: number }[] = []
  for (const c of columns) {
    const g = groups[groups.length - 1]
    if (g && g.propertyName === c.propertyName) g.span++
    else groups.push({ propertyName: c.propertyName, span: 1 })
  }

  const cellKey = (c: RentColumn, period: string) => `${c.propertyId}:${c.unitId ?? 'P'}:${period}`
  const thinCell = 'border border-gray-200 px-2 py-1 text-center align-top'

  return (
    <div className="text-gray-900">
      {error && (
        <div className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="border-collapse text-xs">
          <thead>
            <tr className="bg-gray-50">
              <th className="sticky left-0 z-10 bg-gray-50 border border-gray-200 px-3 py-2 text-left font-medium text-gray-500">
                Rental month
              </th>
              {groups.map((g, i) => (
                <th key={i} colSpan={g.span} className="border border-gray-200 px-2 py-2 text-center font-semibold text-gray-800">
                  {g.propertyName}
                </th>
              ))}
            </tr>
            <tr className="bg-gray-50">
              <th className="sticky left-0 z-10 bg-gray-50 border border-gray-200 px-3 py-1.5" />
              {columns.map((c) => (
                <th key={c.key} className="border border-gray-200 px-2 py-1.5 text-center font-normal min-w-[120px]">
                  {c.unitLabel && <div className="text-[11px] text-gray-500">{c.unitLabel}</div>}
                  {editingTenant === c.key ? (
                    <TenantInput
                      initial={c.tenant || ''}
                      onCancel={() => setEditingTenant(null)}
                      onSave={(name) => run(async () => {
                        await setTenant({ propertyId: c.propertyId, unitId: c.unitId, name })
                        setEditingTenant(null)
                      })}
                    />
                  ) : (
                    <button
                      onClick={() => setEditingTenant(c.key)}
                      className="text-[13px] font-medium text-gray-800 hover:text-blue-700"
                      title="Set tenant"
                    >
                      {c.tenant || <span className="text-gray-400 font-normal">+ tenant</span>}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.map((period) => (
              <tr key={period} className="hover:bg-gray-50/50">
                <th className="sticky left-0 z-10 bg-white border border-gray-200 px-3 py-1.5 text-left font-medium text-gray-600 whitespace-nowrap">
                  {monthLabel(period)}
                </th>
                {columns.map((c) => {
                  const list = cells[cellKey(c, period)] || []
                  const isSel = sel && sel.col.key === c.key && sel.period === period
                  return (
                    <td
                      key={c.key}
                      onClick={() => setSel({ col: c, period })}
                      className={`${thinCell} cursor-pointer ${isSel ? 'ring-2 ring-blue-400 ring-inset' : ''} ${list.length === 0 ? 'text-gray-300' : ''}`}
                    >
                      {list.length === 0 ? (
                        <span className="text-gray-300">+</span>
                      ) : (
                        <div className="space-y-0.5">
                          {list.map((p) => (
                            <div key={p.id} className={'flex items-center justify-center gap-1 ' + (p.status === 'forecast' ? 'text-amber-600' : 'text-gray-800')}>
                              <span className="tabular-nums font-medium">{usd(p.amount)}</span>
                              <span className="text-[10px] text-gray-400">{shortDate(p.date)}</span>
                              {p.isDeposit && <span className="rounded bg-blue-100 px-1 text-[9px] font-semibold text-blue-700">D</span>}
                              {p.status === 'forecast' && <span className="text-[9px] uppercase tracking-wide">sched</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-gray-400">
        Click any cell to add, confirm, or edit payments. Scheduled rents show in amber — confirm them once they clear.
        Deposits are flagged “D”. A cell can hold several payments (e.g. a split month).
      </p>

      {sel && (
        <CellEditor
          col={sel.col}
          period={sel.period}
          payments={cells[cellKey(sel.col, sel.period)] || []}
          pending={pending}
          onClose={() => setSel(null)}
          onAdd={(amount, date, isDeposit) => run(() =>
            addRentPayment({ propertyId: sel.col.propertyId, unitId: sel.col.unitId, period: sel.period, amount, date, isDeposit }))}
          onConfirm={(id, amount, date, isDeposit) => run(() =>
            confirmRentPayment(id, { period: sel.period, amount, date, isDeposit }))}
          onEdit={(id, amount, date, isDeposit) => run(() =>
            editRentPayment(id, { period: sel.period, amount, date, isDeposit }))}
          onDelete={(id) => run(() => deleteRentPayment(id))}
        />
      )}
    </div>
  )
}

function TenantInput({ initial, onSave, onCancel }: { initial: string; onSave: (n: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSave(v); if (e.key === 'Escape') onCancel() }}
        className="w-24 rounded border border-gray-300 px-1 py-0.5 text-xs"
        placeholder="Name"
      />
      <button onClick={() => onSave(v)} className="text-[11px] text-blue-700">✓</button>
      <button onClick={onCancel} className="text-[11px] text-gray-400">✕</button>
    </div>
  )
}

const fieldCls = 'rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 bg-white focus:outline-none focus:ring-1 focus:ring-gray-400'

function CellEditor({
  col, period, payments, pending, onClose, onAdd, onConfirm, onEdit, onDelete,
}: {
  col: RentColumn
  period: string
  payments: RentPayment[]
  pending: boolean
  onClose: () => void
  onAdd: (amount: number, date: string, isDeposit: boolean) => void
  onConfirm: (id: number, amount: number, date: string, isDeposit: boolean) => void
  onEdit: (id: number, amount: number, date: string, isDeposit: boolean) => void
  onDelete: (id: number) => void
}) {
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(`${period}-05`)
  const [isDeposit, setIsDeposit] = useState(false)
  const total = payments.reduce((s, p) => s + p.amount, 0)

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-medium text-gray-800">
          {col.propertyName}{col.unitLabel ? ` · ${col.unitLabel}` : ''}{col.tenant ? ` · ${col.tenant}` : ''}
          <span className="text-gray-400"> — {monthLabel(period)}</span>
          {payments.length > 0 && <span className="ml-2 text-gray-500">({usd2(total)} recorded)</span>}
        </div>
        <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-700">Close ✕</button>
      </div>

      {payments.length > 0 && (
        <div className="mb-3 divide-y divide-gray-200 rounded border border-gray-200 bg-white">
          {payments.map((p) => (
            <PaymentRow key={p.id} p={p} pending={pending}
              onConfirm={(a, d, dep) => onConfirm(p.id, a, d, dep)}
              onEdit={(a, d, dep) => onEdit(p.id, a, d, dep)}
              onDelete={() => onDelete(p.id)} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[11px] text-gray-500 mb-0.5">Amount</label>
          <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldCls + ' w-28'} placeholder="0.00" />
        </div>
        <div>
          <label className="block text-[11px] text-gray-500 mb-0.5">Paid on</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldCls} />
        </div>
        <label className="flex items-center gap-1.5 pb-1.5 text-sm text-gray-700">
          <input type="checkbox" checked={isDeposit} onChange={(e) => setIsDeposit(e.target.checked)} /> Deposit
        </label>
        <button
          disabled={pending}
          onClick={() => { onAdd(Number(amount), date, isDeposit); setAmount(''); setIsDeposit(false) }}
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          Add payment
        </button>
      </div>
    </div>
  )
}

function PaymentRow({
  p, pending, onConfirm, onEdit, onDelete,
}: {
  p: RentPayment
  pending: boolean
  onConfirm: (a: number, d: string, dep: boolean) => void
  onEdit: (a: number, d: string, dep: boolean) => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(String(p.amount))
  const [date, setDate] = useState(p.date)
  const [dep, setDep] = useState(p.isDeposit)
  const scheduled = p.status === 'forecast'

  if (p.locked) {
    return (
      <div className="flex items-center justify-between px-3 py-2 text-sm text-gray-400">
        <span>{usd2(p.amount)} · {shortDate(p.date)}{p.isDeposit ? ' · deposit' : ''}</span>
        <span className="text-xs">Locked</span>
      </div>
    )
  }

  if (open) {
    return (
      <div className="flex flex-wrap items-end gap-2 px-3 py-2">
        <input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className={fieldCls + ' w-24'} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldCls} />
        <label className="flex items-center gap-1.5 pb-1.5 text-sm text-gray-700">
          <input type="checkbox" checked={dep} onChange={(e) => setDep(e.target.checked)} /> Deposit
        </label>
        {scheduled ? (
          <button disabled={pending} onClick={() => onConfirm(Number(amount), date, dep)}
            className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">Confirm</button>
        ) : (
          <button disabled={pending} onClick={() => onEdit(Number(amount), date, dep)}
            className="rounded bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50">Save</button>
        )}
        <button onClick={() => setOpen(false)} className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100">Cancel</button>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between px-3 py-2 text-sm">
      <span className={scheduled ? 'text-amber-600' : 'text-gray-800'}>
        {usd2(p.amount)} · {shortDate(p.date)}
        {p.isDeposit && <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] font-semibold text-blue-700">Deposit</span>}
        {scheduled && <span className="ml-1 text-xs uppercase tracking-wide">scheduled</span>}
      </span>
      <span className="flex items-center gap-2">
        {scheduled
          ? <button onClick={() => setOpen(true)} className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500">Confirm</button>
          : <button onClick={() => setOpen(true)} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100">Edit</button>}
        <button onClick={() => { if (confirm('Delete this payment?')) onDelete() }} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-500 hover:bg-gray-100">Delete</button>
      </span>
    </div>
  )
}
