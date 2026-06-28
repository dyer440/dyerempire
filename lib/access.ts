// lib/access.ts  (REWRITE — adds canAccessPage)
import sql from './db'

export const ADMIN_EMAIL = 'david.dyer.24@gmail.com'
export type Role = 'admin' | 'manager' | 'partner' | 'viewer'

export async function getUserRole(email: string): Promise<Role> {
  if (!email) return 'viewer'
  if (email === ADMIN_EMAIL) return 'admin'
  const rows = await sql`SELECT role FROM allowed_users WHERE email = ${email} LIMIT 1`
  const role = (rows as { role: string | null }[])[0]?.role
  return (role as Role) || 'viewer'
}

export function canEdit(role: Role): boolean {
  return role === 'admin' || role === 'manager'
}

export function canAccessRealEstate(role: Role): boolean {
  return role === 'admin' || role === 'manager' || role === 'partner'
}

// Per-page allowlist for standalone pages (thomas-car, future projects).
// Admin always passes; everyone else needs a page_access row.
export async function canAccessPage(email: string, role: Role, pageKey: string): Promise<boolean> {
  if (role === 'admin') return true
  if (!email) return false
  const rows = await sql`
    SELECT 1 FROM page_access WHERE page_key = ${pageKey} AND email = ${email} LIMIT 1`
  return (rows as unknown[]).length > 0
}

export async function getAccessibleProperties(email: string, role: Role) {
  if (role === 'admin' || role === 'manager') {
    return await sql`SELECT * FROM properties ORDER BY name`
  }
  if (role === 'partner') {
    return await sql`
      SELECT DISTINCT p.* FROM properties p
      JOIN property_owners po ON po.property_id = p.id
      JOIN owners o ON o.id = po.owner_id
      WHERE o.email = ${email}
      ORDER BY p.name
    `
  }
  return []
}

export async function canAccessProperty(email: string, role: Role, propertyId: number): Promise<boolean> {
  if (role === 'admin' || role === 'manager') return true
  if (role === 'partner') {
    const rows = await sql`
      SELECT 1 FROM property_owners po
      JOIN owners o ON o.id = po.owner_id
      WHERE po.property_id = ${propertyId} AND o.email = ${email}
      LIMIT 1`
    return (rows as unknown[]).length > 0
  }
  return false
}
