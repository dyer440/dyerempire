// app/real-estate/distributions/actions.ts  (NEW — record / clear a quarter's distribution)
'use server'
import sql from '@/lib/db'
import { auth } from '@clerk/nextjs/server'
import { revalidatePath } from 'next/cache'
import { getUserRole, canEdit, canAccessProperty } from '@/lib/access'
import { computeQuarter, isValidPeriod } from '@/lib/distributions'

async function guard(propertyId: number) {
  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!canEdit(role)) throw new Error('Not authorized')
  if (!(await canAccessProperty(email, role, propertyId))) throw new Error('Not authorized')
  return email
}

// Record the distribution for a quarter: recompute server-side, write one row per owner.
export async function recordDistribution(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)
  const period = String(formData.get('period') || '')
  if (!isValidPeriod(period)) return

  const c = await computeQuarter(propertyId, period)
  if (c.distributable <= 0) return // nothing to distribute

  // Replace any prior record for this period (idempotent)
  await sql`DELETE FROM distributions WHERE property_id = ${propertyId} AND period = ${period}`
  for (const s of c.split) {
    await sql`
      INSERT INTO distributions (period, property_id, owner_id, amount, status)
      VALUES (${period}, ${propertyId}, ${s.owner_id}, ${s.amount}, 'recorded')
    `
  }
  revalidatePath(`/real-estate/${propertyId}/periods/${period}`)
  revalidatePath(`/real-estate/${propertyId}/periods`)
}

export async function clearDistribution(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)
  const period = String(formData.get('period') || '')
  if (!isValidPeriod(period)) return

  await sql`DELETE FROM distributions WHERE property_id = ${propertyId} AND period = ${period}`
  revalidatePath(`/real-estate/${propertyId}/periods/${period}`)
  revalidatePath(`/real-estate/${propertyId}/periods`)
}
