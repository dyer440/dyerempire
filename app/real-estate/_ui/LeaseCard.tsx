// One unit's current lease, in plain words.
import type { Lease } from '@/lib/leases'
import { money, longDate } from '@/lib/format'

const chip: Record<Lease['state'], string> = {
  in_term: 'bg-paid-wash text-paid',
  ending_soon: 'bg-late-wash text-late',
  month_to_month: 'bg-due-wash text-due',
  no_end_date: 'bg-wash text-muted',
  ended: 'bg-wash text-muted',
}

function stateText(l: Lease) {
  switch (l.state) {
    case 'in_term': return `In term until ${longDate(l.end_date)}`
    case 'ending_soon': return `Ends in ${l.days_left} ${l.days_left === 1 ? 'day' : 'days'}, ${longDate(l.end_date)}`
    case 'month_to_month': return `Month to month since ${longDate(l.end_date)}`
    case 'no_end_date': return 'No end date on file'
    default: return `Ended ${longDate(l.ended_on)}`
  }
}

export default function LeaseCard({ l, showProperty = false, showContact = false }: { l: Lease; showProperty?: boolean; showContact?: boolean }) {
  const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`
  const mismatch = l.schedule_rent !== null && l.monthly_rent !== null && Math.abs(l.schedule_rent - l.monthly_rent) > 0.004
  return (
    <article className="rounded-lg border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {showProperty && <p className="text-[13px] text-muted">{l.property}{l.multi_unit && l.unit ? `, ${l.unit}` : ''}</p>}
          <h3 className="font-serif text-xl leading-snug">{l.tenant || 'Tenant not named'}</h3>
          {!showProperty && l.multi_unit && l.unit && <p className="text-[13px] text-muted">{l.unit}</p>}
        </div>
        <span className={`rounded px-2 py-0.5 text-[13px] font-medium ${chip[l.state]}`}>{stateText(l)}</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px] sm:grid-cols-3">
        <div>
          <dt className="text-muted">Rent</dt>
          <dd className="num">{l.monthly_rent !== null ? `${money(l.monthly_rent)} a month` : 'Not on file'}{l.rent_due_day ? <span className="text-muted">, due the {ordinal(l.rent_due_day)}</span> : null}</dd>
        </div>
        <div>
          <dt className="text-muted">Lease term</dt>
          <dd>{l.start_date ? longDate(l.start_date) : '?'} to {l.end_date ? longDate(l.end_date) : '?'}</dd>
        </div>
        <div>
          <dt className="text-muted">Month-to-month rent</dt>
          <dd className="num">{l.mtm_rent !== null ? money(l.mtm_rent) : 'Not set'}</dd>
        </div>
        <div>
          <dt className="text-muted">Security deposit</dt>
          <dd className="num">{l.deposit_amount !== null ? money(l.deposit_amount) : 'Not on file'}</dd>
        </div>
        {showContact && (l.tenant_phone || l.tenant_email) && (
          <div className="col-span-2">
            <dt className="text-muted">Contact</dt>
            <dd className="truncate">{[l.tenant_phone, l.tenant_email].filter(Boolean).join(', ')}</dd>
          </div>
        )}
      </dl>
      {mismatch && (
        <p className="mt-3 text-[13px] text-due">The rent schedule expects {money(l.schedule_rent!)} a month, not {money(l.monthly_rent!)}. One of them needs updating.</p>
      )}
      {(l.notes || l.plan) && (
        <div className="mt-3 space-y-1 border-t border-rule pt-3 text-[14px]">
          {l.plan && <p><span className="text-muted">Plan: </span>{l.plan}</p>}
          {l.notes && <p className="text-ink/80">{l.notes}</p>}
        </div>
      )}
    </article>
  )
}
