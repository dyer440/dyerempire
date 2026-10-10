// app/real-estate/leases/page.tsx
// Every current lease, the ones that need attention first.
import { getViewer } from '@/lib/viewer'
import { listLeases, EXPIRING_DAYS, type Lease } from '@/lib/leases'
import sql from '@/lib/db'
import LeaseCard from '../_ui/LeaseCard'

const order: Record<Lease['state'], number> = { ending_soon: 0, month_to_month: 1, no_end_date: 2, in_term: 3, ended: 4 }

export default async function Leases() {
  const v = await getViewer()
  const ids = v.properties.map((p) => p.id)
  const leases = (await listLeases({ propertyIds: ids }))
    .sort((a, b) => order[a.state] - order[b.state] || (a.end_date ?? '9999').localeCompare(b.end_date ?? '9999'))
  // Units someone is renting that have no lease on file yet.
  const missing = (await sql`
    SELECT p.name AS property, u.label AS unit, u.current_tenant AS tenant
    FROM units u JOIN properties p ON p.id = u.property_id
    WHERE u.property_id = ANY(${ids}::int[]) AND u.current_tenant IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.unit_id = u.id AND l.status = 'active')
    ORDER BY p.name, u.label
  `) as { property: string; unit: string; tenant: string }[]
  const attention = leases.filter((l) => l.state === 'ending_soon' || l.state === 'month_to_month').length

  return (
    <main className="space-y-8">
      <header>
        <h1 className="font-serif text-4xl font-medium tracking-tight">Leases</h1>
        <p className="mt-2 max-w-2xl text-[15px] text-muted">
          {leases.length} current {leases.length === 1 ? 'lease' : 'leases'}.
          {attention > 0 ? ` ${attention} ${attention === 1 ? 'is' : 'are'} ending within ${EXPIRING_DAYS} days or running month to month.` : ' None need attention.'}
          {v.insider && ' To change a lease, leave a note or tell Claude.'}
        </p>
      </header>
      <div className="grid gap-4 lg:grid-cols-2">
        {leases.map((l) => <LeaseCard key={l.id} l={l} showProperty showContact={v.insider} />)}
      </div>
      {missing.length > 0 && (
        <section aria-labelledby="missing-h" className="rounded-lg border border-rule bg-surface p-5">
          <h2 id="missing-h" className="font-serif text-xl">No lease on file</h2>
          <ul className="mt-2 space-y-1 text-[15px]">
            {missing.map((m) => <li key={`${m.property}-${m.unit}`}>{m.property}, {m.unit}: {m.tenant}</li>)}
          </ul>
        </section>
      )}
    </main>
  )
}
