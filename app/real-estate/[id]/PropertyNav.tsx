// app/real-estate/[id]/PropertyNav.tsx  (NEW — persistent property nav, client component)
'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function PropertyNav({
  propertyId, name, canEdit,
}: {
  propertyId: number; name: string; canEdit: boolean
}) {
  const pathname = usePathname() || ''
  const base = `/real-estate/${propertyId}`

  const tabs: { label: string; href: string; active: boolean }[] = [
    { label: 'Overview', href: base, active: pathname === base },
    { label: 'Capital', href: `${base}/capital`, active: pathname === `${base}/capital` },
    { label: 'Returns', href: `${base}/returns`, active: pathname === `${base}/returns` },
    ...(canEdit
      ? [
          { label: 'Schedules', href: `${base}/schedules`, active: pathname.startsWith(`${base}/schedules`) },
          { label: 'Periods', href: `${base}/periods`, active: pathname.startsWith(`${base}/periods`) },
        ]
      : []),
  ]

  const tabCls = (active: boolean) =>
    `text-xs tracking-widest uppercase transition-colors pb-1 ${
      active ? 'text-white border-b border-white/60' : 'text-white/40 hover:text-white border-b border-transparent'
    }`
  const upCls = 'text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors'

  return (
    <nav className="sticky top-0 z-20 bg-black/90 backdrop-blur border-b border-white/10 px-6 md:px-10 py-4">
      <div className="max-w-3xl mx-auto flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-6 flex-wrap">
          <span className="text-sm tracking-[0.2em] uppercase text-white/80" style={{ fontFamily: 'Georgia, serif' }}>
            {name}
          </span>
          <div className="flex items-center gap-5">
            {tabs.map((t) => (
              <Link key={t.label} href={t.href} className={tabCls(t.active)}>
                {t.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-5">
          {canEdit && <Link href="/real-estate/southside" className={upCls}>Southside</Link>}
          <Link href="/real-estate" className={upCls}>All Properties</Link>
          <Link href="/" className={upCls}>Home</Link>
        </div>
      </div>
    </nav>
  )
}
