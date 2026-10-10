// lib/viewer.ts
// Who is looking at the site, resolved once per request for the read-only UI.
// Role rules come from lib/access.ts: admin and manager see everything, a
// partner sees only the properties they co-own, anyone else is turned away.
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { getUserRole, canEdit, canAccessRealEstate, getAccessibleProperties, type Role } from './access'

export type ViewerProperty = {
  id: number; name: string; holding_entity: string; property_type: string
  address: string; city: string; state: string; zip: string; status: string
}

export type Viewer = {
  email: string
  role: Role
  /** admin or manager: sees every property, companies and the note box */
  insider: boolean
  properties: ViewerProperty[]
}

export const getViewer = cache(async (): Promise<Viewer> => {
  await auth.protect()
  const { sessionClaims } = await auth()
  const email = ((sessionClaims as Record<string, unknown> | null)?.email as string) || ''
  const role = await getUserRole(email)
  if (!canAccessRealEstate(role)) redirect('/not-authorized')
  const properties = ((await getAccessibleProperties(email, role)) as ViewerProperty[])
    .filter((p) => p.status !== 'sold' && p.status !== 'inactive')
  return { email, role, insider: canEdit(role), properties }
})

/** The viewer, or a redirect home if they can't see this property. */
export async function requireProperty(id: number) {
  const v = await getViewer()
  const prop = v.properties.find((p) => p.id === id)
  if (!prop) redirect('/real-estate')
  return { viewer: v, property: prop }
}
