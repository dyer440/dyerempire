// app/real-estate/_components/MonthPager.tsx
// Reusable month navigator: ← prev · Month YYYY · next → plus a "This month"
// shortcut, all driven by ?month=YYYY-MM. Server component, no client JS — just
// links. Used by the Southside ledger and the per-property ledger so month
// paging works the same everywhere.
import Link from 'next/link'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

export function monthBounds(month: string): { from: string; to: string; label: string } {
  const [y, m] = month.split('-').map(Number)
  const from = `${y}-${String(m).padStart(2, '0')}-01`
  const last = new Date(y, m, 0).getDate() // day 0 of next month = last day
  const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  return { from, to, label: `${MONTHS[m - 1]} ${y}` }
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function MonthPager({ basePath, month }: { basePath: string; month: string }) {
  const { label } = monthBounds(month)
  const prev = shiftMonth(month, -1)
  const next = shiftMonth(month, 1)
  const thisMonth = currentMonth()
  const btn = 'rounded-full border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100'
  return (
    <div className="mb-4 flex items-center justify-center gap-3">
      <Link href={`${basePath}?month=${prev}`} className={btn}>&larr; {shiftMonth(month, -1).slice(5)}/{prev.slice(2, 4)}</Link>
      <span className="min-w-[10rem] text-center text-lg font-semibold text-gray-900 tabular-nums">{label}</span>
      <Link href={`${basePath}?month=${next}`} className={btn}>{next.slice(5)}/{next.slice(2, 4)} &rarr;</Link>
      {month !== thisMonth && (
        <Link href={`${basePath}?month=${thisMonth}`} className={btn}>This month</Link>
      )}
    </div>
  )
}
