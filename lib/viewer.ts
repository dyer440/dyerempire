// lib/viewer.ts
// Who is looking at the site, resolved once per request for the read-only UI.
// Role rules come from lib/access.ts: admin and manager see everything, a
// partner sees only the properties they co-own. Anyone else sees only the
// pages granted to them in page_access (e.g. Matt Warder: media-tct).
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import sql from './db'
import { getUserRole, canEdit, canAccessRealEstate, getAccessibleProperties, type Role } from './access'

export type ViewerProperty = {
  id: number; name: string; holding_entity: string; property_type: string
  address: string; city: string; state: string; zip: string; status: string
}

export type SiteUser = {
  email: string
  role: Role
  /** admin or manager: sees every property, company, media page and the note box */
  insider: boolean
  realEstate: boolean
  /** page_access keys granted to this user (admins implicitly have all) */
  pages: string[]
}

export type Viewer = SiteUser & { properties: ViewerProperty[] }

export const getSiteUser = cache(async (): Promise<SiteUser> => {
  await auth.protect()
  const { sessionClaims } = await auth()
  const email = ((sessionClaims as Record<string, unknown> | null)?.email as string) || ''
  const role = await getUserRole(email)
  const pages = email
    ? ((await sql`SELECT page_key FROM page_access WHERE lower(email) = lower(${email})`) as { page_key: string }[]).map((r) => r.page_key)
    : []
  return { email, role, insider: canEdit(role), realEstate: canAccessRealEstate(role), pages }
})

/** True when the user may open a page_access-gated page. Insiders always may. */
export function canSee(u: SiteUser, pageKey: string) {
  return u.insider || u.pages.includes(pageKey)
}

/** The viewer of the real-estate pages; anyone else goes to their own page or away. */
export const getViewer = cache(async (): Promise<Viewer> => {
  const u = await getSiteUser()
  if (!u.realEstate) redirect(landingFor(u))
  const properties = ((await getAccessibleProperties(u.email, u.role)) as ViewerProperty[])
    .filter((p) => p.status !== 'sold' && p.status !== 'inactive')
  return { ...u, properties }
})

/** Where someone without real-estate access should land. */
export function landingFor(u: SiteUser) {
  const media = u.pages.find((p) => p.startsWith('media-'))
  if (media) return `/media/${media.slice('media-'.length)}`
  if (u.pages.includes('thomas-car')) return '/thomas-car'
  return '/not-authorized'
}

/** The viewer, or a redirect home if they can't see this property. */
export async function requireProperty(id: number) {
  const v = await getViewer()
  const prop = v.properties.find((p) => p.id === id)
  if (!prop) redirect('/real-estate')
  return { viewer: v, property: prop }
}
