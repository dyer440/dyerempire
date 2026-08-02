// app/real-estate/_components/NavAutoClose.tsx
'use client'
// Closes any open <details> menu in the nav when the user clicks outside it or
// navigates to a new route. Plain <details> stays open until toggled, so links
// inside it leave the menu hanging open after navigation — this fixes that
// without turning the whole nav into a client component.
import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

export default function NavAutoClose() {
  const pathname = usePathname()

  // Close all menus whenever the route changes (i.e. after a link click).
  useEffect(() => {
    document
      .querySelectorAll<HTMLDetailsElement>('nav details[open]')
      .forEach(d => { d.open = false })
  }, [pathname])

  // Close menus when clicking anywhere outside the currently-open one.
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      const openMenus = document.querySelectorAll<HTMLDetailsElement>('nav details[open]')
      openMenus.forEach(d => {
        if (!d.contains(e.target as Node)) d.open = false
      })
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  return null
}
