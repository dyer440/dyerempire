// Rent by unit and month for a year. Paid months show what came in; due,
// partly paid and late months show what was due.
import Link from 'next/link'
import type { RentCell, RentLine } from '@/lib/views'
import { money0, monthName } from '@/lib/format'
import { describeCell } from './RentStrip'

const cellTone: Record<RentCell['state'], string> = {
  paid: 'bg-paid-wash text-paid',
  partial: 'bg-due-wash text-due',
  due: 'bg-due-wash/60 text-due',
  late: 'bg-late text-white',
  none: 'text-faint',
}

export default function RentTable({ lines, months, showProperty = false }: {
  lines: RentLine[]; months: string[]; showProperty?: boolean
}) {
  const totalFor = (ym: string) => lines.reduce((t, l) => t + (l.cells.find((c) => c.ym === ym)?.received || 0), 0)
  return (
    <div className="relative overflow-x-auto rounded-lg border border-rule bg-surface">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead>
          <tr className="border-b border-rule text-muted">
            <th scope="col" className="px-3 py-2 text-left font-normal">{showProperty ? 'Property and tenant' : 'Tenant'}</th>
            {months.map((m) => <th key={m} scope="col" className="px-1 py-2 text-center font-normal">{monthName(m)}</th>)}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const firstOfProperty = showProperty && (i === 0 || lines[i - 1].propertyId !== l.propertyId)
            return (
              <tr key={l.key} className={`border-b border-rule ${firstOfProperty && i > 0 ? 'border-t-2 border-t-rule' : ''}`}>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {showProperty && (
                    <Link href={`/real-estate/${l.propertyId}`} className="block font-serif text-[15px] text-ink hover:underline">
                      {l.propertyName}
                    </Link>
                  )}
                  <span className={showProperty ? 'block text-muted' : 'block text-[14px] text-ink'}>
                    {l.tenant || 'Vacant'}{l.unitLabel ? `, ${l.unitLabel}` : ''}
                  </span>
                </th>
                {l.cells.map((c) => (
                  <td key={c.ym} className="px-0.5 py-1.5">
                    <div title={describeCell(c)} className={`num relative rounded px-1 py-1.5 text-center ${cellTone[c.state]}`}>
                      <span className="sr-only">{describeCell(c)}</span>
                      <span aria-hidden>{c.state === 'none' ? '' : c.state === 'paid' ? money0(c.received) : money0(c.open + c.received)}</span>
                    </div>
                  </td>
                ))}
              </tr>
            )
          })}
          {lines.length > 1 && (
            <tr className="bg-wash/50 text-ink">
              <th scope="row" className="px-3 py-2 text-left font-medium">Received</th>
              {months.map((m) => <td key={m} className="num px-1 py-2 text-center font-medium">{totalFor(m) ? money0(totalFor(m)) : ''}</td>)}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
