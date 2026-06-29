// app/real-estate/[id]/layout.tsx  (NEW — wraps all property-scoped pages with the nav)
import type { ReactNode } from 'react'
import { auth } from '@clerk/nextjs/server'
import sql from '@/lib/db'
import { getUserRole, canAccessProperty, canEdit } from '@/lib/access'
import PropertyNav from './PropertyNav'

export default async function PropertyLayout({
  children, params,
}: {
  children: ReactNode; params: Promise<{ id: string }>
}) {
  const { id } = await params
  const propertyId = Number(id)

  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)

  // No access → render the page alone; it will handle the redirect itself.
  if (!(await canAccessProperty(email, role, propertyId))) return <>{children}</>

  const prop = (await sql`SELECT name FROM properties WHERE id = ${propertyId} LIMIT 1`) as { name: string }[]
  const name = prop[0]?.name || ''

  return (
    <div className="bg-black">
      <PropertyNav propertyId={propertyId} name={name} canEdit={canEdit(role)} />
      {children}
    </div>
  )
}
