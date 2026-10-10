'use client'
// Property sub-navigation. A plain row of links with the current one underlined.
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function Tabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const path = usePathname() || ''
  return (
    <nav aria-label="Property sections" className="border-b border-rule">
      <ul className="-mb-px flex gap-6">
        {tabs.map((t) => {
          const on = path === t.href
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={on ? 'page' : undefined}
                className={`inline-block border-b-2 pb-2.5 text-[15px] transition-colors ${
                  on ? 'border-brass text-ink font-medium' : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
