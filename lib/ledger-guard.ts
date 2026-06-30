// lib/ledger-guard.ts
// Self-contained access helpers for the unified ledger + Southside page.
// Kept independent of lib/access.ts on purpose so it can't break the build if
// that file's signatures change. If you prefer, swap getEditorEmail() for your
// existing canEdit() — the role rule (admin/manager can edit) is identical.
import { auth } from '@clerk/nextjs/server'
import sql from './db'

const ADMIN_EMAIL = 'david.dyer.24@gmail.com'

/**
 * Returns the signed-in user's email IFF they may edit the books
 * (admin or manager). Returns null for partners/viewers/anonymous.
 */
export async function getEditorEmail(): Promise<string | null> {
  const { sessionClaims } = await auth()
  const email = (sessionClaims as Record<string, any> | null)?.email as string | undefined
  if (!email) return null
  if (email === ADMIN_EMAIL) return email
  const rows = (await sql`
    SELECT role FROM allowed_users WHERE email = ${email} LIMIT 1
  `) as Record<string, any>[]
  const role = rows[0]?.role
  return role === 'admin' || role === 'manager' ? email : null
}

/** True if the given date falls inside a closed (soft-locked) period for the property. */
export async function isDateClosed(propertyId: number, dateStr: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM period_closes
    WHERE property_id = ${propertyId}
      AND ${dateStr}::date BETWEEN period_start AND period_end
    LIMIT 1
  `) as Record<string, any>[]
  return rows.length > 0
}
