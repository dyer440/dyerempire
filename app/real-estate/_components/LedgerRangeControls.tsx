'use client'
// app/real-estate/_components/LedgerRangeControls.tsx
// Quick date-range presets for the ledger pages. Drives the page via ?from / ?to
// (both ledger pages already read those). Scheduled items still only show from
// the current month forward, so a "This year" view shows the year's actuals plus
// scheduled through year-end.
import { useRouter, usePathname } from 'next/navigation'
import { useState } from 'react'

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function presets(now: Date) {
  const y = now.getFullYear()
  const m = now.getMonth()
  const q = Math.floor(m / 3) // 0..3
  const monthStart = new Date(y, m, 1)
  const monthEnd = new Date(y, m + 1, 0)
  const qStart = new Date(y, q * 3, 1)
  const qEnd = new Date(y, q * 3 + 3, 0)
  const yearStart = new Date(y, 0, 1)
  const yearEnd = new Date(y, 11, 31)
  // Default rolling window: start of last month → ~12 months out.
  const rollFrom = new Date(y, m - 1, 1)
  const rollTo = new Date(y, m + 13, 0)
  return [
    { key: 'month', label: 'This month', from: ymd(monthStart), to: ymd(monthEnd) },
    { key: 'quarter', label: 'This quarter', from: ymd(qStart), to: ymd(qEnd) },
    { key: 'year', label: 'This year', from: ymd(yearStart), to: ymd(yearEnd) },
    { key: 'rolling', label: '12-month', from: ymd(rollFrom), to: ymd(rollTo) },
  ]
}

export default function LedgerRangeControls({ from, to }: { from: string; to: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const [customFrom, setCustomFrom] = useState(from)
  const [customTo, setCustomTo] = useState(to)

  const opts = presets(new Date())
  const go = (f: string, t: string) => router.push(`${pathname}?from=${f}&to=${t}`)

  const btn = (active: boolean) =>
    'rounded-full px-3 py-1 text-sm font-medium transition ' +
    (active ? 'bg-gray-900 text-white' : 'border border-gray-300 text-gray-700 hover:bg-gray-100')

  const inputCls =
    'rounded border border-gray-300 px-2 py-1 text-sm text-gray-900 bg-white focus:outline-none focus:ring-1 focus:ring-gray-400'

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {opts.map((o) => (
        <button key={o.key} className={btn(from === o.from && to === o.to)} onClick={() => go(o.from, o.to)}>
          {o.label}
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-gray-200" />
      <input type="date" className={inputCls} value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
      <span className="text-gray-400">→</span>
      <input type="date" className={inputCls} value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
      <button className={btn(false)} onClick={() => go(customFrom, customTo)}>Apply</button>
    </div>
  )
}
