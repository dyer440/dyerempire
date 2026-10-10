// app/real-estate/[id]/layout.tsx
// Property header (name, address, who owns it) and the three sections.
import { requireProperty } from '@/lib/viewer'
import sql from '@/lib/db'
import Tabs from '../_ui/Tabs'

export default async function PropertyLayout({
  children, params,
}: {
  children: React.ReactNode; params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { property: p } = await requireProperty(Number(id))
  const owners = (await sql`
    SELECT o.name, po.ownership_pct::float8 AS pct FROM property_owners po
    JOIN owners o ON o.id = po.owner_id
    WHERE po.property_id = ${p.id} ORDER BY po.ownership_pct DESC, o.name
  `) as { name: string; pct: number }[]
  const base = `/real-estate/${p.id}`

  return (
    <main>
      <header className="mb-6">
        <h1 className="font-serif text-4xl font-medium tracking-tight">{p.name}</h1>
        <p className="mt-1 text-[15px] text-muted">
          {p.address}, {p.city}, {p.state} {p.zip}. Held by {p.holding_entity}
          {owners.length > 0 && <>, owned by {owners.map((o) => `${o.name} ${fmtPct(o.pct)}`).join(' and ')}</>}.
        </p>
      </header>
      <Tabs tabs={[
        { href: base, label: 'Overview' },
        { href: `${base}/partners`, label: 'Partners' },
        { href: `${base}/activity`, label: 'Activity' },
      ]} />
      <div className="pt-8">{children}</div>
    </main>
  )
}

function fmtPct(n: number) {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '')}%`
}
