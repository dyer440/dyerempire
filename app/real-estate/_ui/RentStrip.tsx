// A unit's rent, month by month, as a row of tabs: green when paid, ochre
// when partly paid or not yet due, brick when 7+ days late, blank when nothing
// was expected. Each tab carries the exact figures for screen readers and on hover.
import type { RentCell } from '@/lib/views'
import { money, monthName } from '@/lib/format'

const tone: Record<RentCell['state'], string> = {
  paid: 'bg-paid text-white',
  partial: 'bg-due-wash text-due ring-1 ring-inset ring-due/40',
  due: 'bg-due-wash text-due',
  late: 'bg-late text-white',
  none: 'bg-transparent text-faint ring-1 ring-inset ring-rule',
}

export function describeCell(c: RentCell) {
  const m = monthName(c.ym, true)
  switch (c.state) {
    case 'paid': return `${m}: ${money(c.received)} received`
    case 'partial': return `${m}: ${money(c.received)} received, ${money(c.open)} still due`
    case 'due': return `${m}: ${money(c.open)} due`
    case 'late': return `${m}: ${money(c.open)} late${c.received ? `, ${money(c.received)} received` : ''}`
    default: return `${m}: no rent expected`
  }
}

export default function RentStrip({ cells, showMonths = false }: { cells: RentCell[]; showMonths?: boolean }) {
  return (
    <ol className="flex gap-1" aria-label="Rent by month">
      {cells.map((c) => (
        <li
          key={c.ym}
          title={describeCell(c)}
          className={`relative flex h-7 min-w-0 flex-1 items-center justify-center rounded text-[11px] font-medium ${tone[c.state]}`}
        >
          <span className="sr-only">{describeCell(c)}</span>
          <span aria-hidden>{showMonths ? monthName(c.ym).slice(0, 3) : ''}</span>
        </li>
      ))}
    </ol>
  )
}

export function RentLegend() {
  const items: [RentCell['state'], string][] = [
    ['paid', 'Paid'], ['partial', 'Part paid'], ['due', 'Due'], ['late', 'Late (7+ days)'], ['none', 'Nothing expected'],
  ]
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
      {items.map(([s, label]) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={`inline-block h-3 w-4 rounded-sm ${tone[s]}`} aria-hidden />
          {label}
        </li>
      ))}
    </ul>
  )
}
