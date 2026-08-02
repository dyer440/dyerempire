// app/real-estate/_components/RealEstateNav.tsx
// Global navigation for the entire real-estate area. Rendered by
// app/real-estate/layout.tsx so it appears on EVERY page under /real-estate —
// properties, company (entity) ledgers, importer, rent roll, southside — making
// any page reachable from any other in two clicks.
//
// Three groupings, matching what the things ARE:
//   Properties  — the real-estate assets (dropdown; role-filtered, so partners
//                 see only their co-owned properties)
//   Companies   — non-property legal entities (SL Cap Mgmt, SL Trading,
//                 SL Media…), driven by the entities table so future LLCs
//                 appear automatically; editors only
//   Operations  — the workflows: Rent Roll, Ledger, Import (+ Reconcile /
//                 Distribute); editors only, since these mutate the books
//
// Server component; dropdowns are <details> elements — no client JS. Dark bar
// styled to sit acceptably on both the dark property pages and light pages
// (theme unification is separate, known debt).
import sql from '@/lib/db'
import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { getUserRole, canEdit, getAccessibleProperties } from '@/lib/access'
import NavAutoClose from './NavAutoClose'

export default async function RealEstateNav() {
  const { sessionClaims } = await auth()
  const email = ((sessionClaims as Record<string, unknown> | null)?.email as string) || ''
  const role = await getUserRole(email)
  const editor = canEdit(role)

  const properties = ((await getAccessibleProperties(email, role)) as { id: number; name: string }[]) || []

  const companies = editor
    ? ((await sql`
        SELECT slug, name FROM entities
        WHERE type <> 'property' AND status = 'active' AND slug IS NOT NULL
        ORDER BY name
      `) as { slug: string; name: string }[])
    : []

  const item = 'block px-4 py-2 text-sm text-white/70 hover:text-white hover:bg-white/10 whitespace-nowrap'

  return (
    <nav className="bg-zinc-950 border-b border-white/10 text-sm relative z-50">
      <NavAutoClose />
      <div className="max-w-6xl mx-auto px-4 flex items-center gap-1">
        <Link href="/real-estate" className="py-3 pr-4 text-white font-semibold tracking-wide whitespace-nowrap">
          Dyer Empire <span className="text-white/40 font-normal">· Real Estate</span>
        </Link>

        {/* Properties */}
        {properties.length > 0 && (
          <details className="relative group">
            <summary className="list-none cursor-pointer px-3 py-3 text-white/70 hover:text-white select-none">
              Properties <span className="text-white/30">▾</span>
            </summary>
            <div className="absolute left-0 top-full bg-zinc-900 border border-white/10 rounded-b shadow-xl min-w-[12rem]">
              {properties.map(p => (
                <Link key={p.id} href={`/real-estate/${p.id}`} className={item}>{p.name}</Link>
              ))}
            </div>
          </details>
        )}

        {/* Companies (entity ledgers) */}
        {companies.length > 0 && (
          <details className="relative">
            <summary className="list-none cursor-pointer px-3 py-3 text-white/70 hover:text-white select-none">
              Companies <span className="text-white/30">▾</span>
            </summary>
            <div className="absolute left-0 top-full bg-zinc-900 border border-white/10 rounded-b shadow-xl min-w-[12rem]">
              {companies.map(c => (
                <Link key={c.slug} href={`/real-estate/entity/${c.slug}`} className={item}>{c.name}</Link>
              ))}
            </div>
          </details>
        )}

        {/* Operations */}
        {editor && (
          <>
            <Link href="/real-estate/southside/rent" className="px-3 py-3 text-white/70 hover:text-white whitespace-nowrap">
              Rent Roll
            </Link>
            <Link href="/real-estate/southside" className="px-3 py-3 text-white/70 hover:text-white whitespace-nowrap">
              Ledger
            </Link>
            <Link href="/real-estate/close" className="px-3 py-3 text-white/70 hover:text-white whitespace-nowrap">
              Quarter close
            </Link>
            <details className="relative">
              <summary className="list-none cursor-pointer px-3 py-3 text-white/70 hover:text-white select-none">
                Import <span className="text-white/30">▾</span>
              </summary>
              <div className="absolute left-0 top-full bg-zinc-900 border border-white/10 rounded-b shadow-xl min-w-[12rem]">
                <Link href="/real-estate/import" className={item}>Assign bank rows</Link>
                <Link href="/real-estate/import/reconcile" className={item}>Fee reconciliation</Link>
                <Link href="/real-estate/import/distribute" className={item}>Distribute fees</Link>
              </div>
            </details>
          </>
        )}
      </div>
    </nav>
  )
}
