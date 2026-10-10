// app/_site/SiteFrame.tsx
// The signed-in site frame: a light page, one row of links and the account
// button. Used by /real-estate and /admin so they look like one site.
import Link from 'next/link'
import { UserButton } from '@clerk/nextjs'
import { getViewer } from '@/lib/viewer'
import NavLinks, { type NavItem } from './NavLinks'

export default async function SiteFrame({ children }: { children: React.ReactNode }) {
  const v = await getViewer()
  const items: NavItem[] = [
    { href: '/real-estate', label: 'Properties', match: ['/real-estate', '^/real-estate/\\d+'] },
    { href: '/real-estate/rent', label: 'Rent roll', match: ['/real-estate/rent'] },
  ]
  if (v.insider) {
    items.push({ href: '/real-estate/companies', label: 'Companies', match: ['/real-estate/companies*'] })
    items.push({ href: '/real-estate/notes', label: 'Notes', match: ['/real-estate/notes'] })
  }
  if (v.role === 'admin') items.push({ href: '/admin', label: 'Admin', match: ['/admin'] })

  return (
    <div className="site min-h-screen bg-paper text-ink">
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-6">
          <Link href="/real-estate" className="shrink-0 font-serif text-xl tracking-tight text-ink">
            Dyer Empire
          </Link>
          <div className="order-last -mx-3 w-[calc(100%+1.5rem)] min-w-0 sm:order-none sm:mx-0 sm:w-auto sm:flex-1">
            <NavLinks items={items} />
          </div>
          <div className="ml-auto flex sm:ml-0"><UserButton /></div>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6">{children}</div>
    </div>
  )
}
