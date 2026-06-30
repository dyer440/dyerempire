'use client'
// app/real-estate/_components/SouthsideTabs.tsx
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function SouthsideTabs() {
  const pathname = usePathname() || ''
  const tabs = [
    { label: 'Ledger', href: '/real-estate/southside' },
    { label: 'Rent', href: '/real-estate/southside/rent' },
  ]
  return (
    <div className="mb-5 flex items-center gap-1 border-b border-gray-200">
      {tabs.map((t) => {
        const active = pathname === t.href
        return (
          <Link
            key={t.href}
            href={t.href}
            className={
              'px-4 py-2 text-sm font-medium -mb-px border-b-2 transition ' +
              (active ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800')
            }
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
