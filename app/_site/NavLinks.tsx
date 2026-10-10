'use client'
// Top-level site links with the current section marked.
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// match: exact paths, 'prefix*', or '^regex'
export type NavItem = { href: string; label: string; match: string[] }

export default function NavLinks({ items }: { items: NavItem[] }) {
  const path = usePathname() || ''
  const isActive = (it: NavItem) =>
    it.match.some((m) =>
      m.startsWith('^') ? new RegExp(m).test(path)
      : m.endsWith('*') ? path.startsWith(m.slice(0, -1))
      : path === m)
  return (
    <ul className="flex items-center gap-1 overflow-x-auto">
      {items.map((it) => {
        const on = isActive(it)
        return (
          <li key={it.href}>
            <Link
              href={it.href}
              aria-current={on ? 'page' : undefined}
              className={`block whitespace-nowrap rounded-md px-3 py-1.5 text-[15px] transition-colors ${
                on ? 'bg-wash text-ink font-medium' : 'text-muted hover:text-ink hover:bg-wash/60'
              }`}
            >
              {it.label}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
