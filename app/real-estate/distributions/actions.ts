// app/real-estate/distributions/actions.ts  (UPDATED — allow an explicit $0 distribution)
'use server'
import sql from '@/lib/db'
import { auth } from '@clerk/nextjs/server'
import { revalidatePath } from 'next/cache'
import { getUserRole, canEdit, canAccessProperty } from '@/lib/access'
import { computeQuarter, isValidPeriod, lifetimeRetained } from '@/lib/distributions'

async function guard(propertyId: number) {
  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!canEdit(role)) throw new Error('Not authorized')
  if (!(await canAccessProperty(email, role, propertyId))) throw new Error('Not authorized')
  return email
}

// Record the distribution for a quarter. Splits a TOTAL across owners by ownership %.
// - If the amount field is left BLANK, defaults to the runway distributable and
//   only records when that is positive.
// - If the amount field is filled (including an explicit 0), that value is recorded
//   as-is — so a "$0 distributed this quarter" can be logged. Negatives are ignored.
export async function recordDistribution(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)
  const period = String(formData.get('period') || '')
  if (!isValidPeriod(period)) return

  const c = await computeQuarter(propertyId, period)
  const overrideRaw = String(formData.get('amount') || '').trim()

  let total: number
  if (overrideRaw !== '') {
    total = parseFloat(overrideRaw)
    if (isNaN(total) || total < 0) return // explicit value: allow 0, reject negatives/garbage
  } else {
    total = c.runwayDistributable
    if (total <= 0) return // blank field: only auto-record a positive runway distributable
  }

  // OVER-DISTRIBUTION GUARD. Compare against LIFETIME retained cash (all-in net
  // income ever earned, minus everything ever distributed) — not YTD, so paying
  // out last year's Q4 profit in January doesn't false-positive. Recording a
  // distribution larger than the property has ever actually earned means you're
  // returning capital; that may be intentional, so this warns rather than blocks:
  // re-submit with the "confirm over-distribution" box checked to proceed.
  const prior = (await sql`
    SELECT COALESCE(SUM(amount), 0)::float8 AS total FROM distributions
    WHERE property_id = ${propertyId} AND period = ${period}
  `) as { total: number }[]
  const { retained } = await lifetimeRetained(propertyId)
  // This period's existing record is being replaced, so add it back before comparing.
  const available = retained + (prior[0]?.total || 0)
  const acknowledged = String(formData.get('allow_over') || '') !== ''
  if (total > available + 0.005 && !acknowledged) {
    throw new Error(
      `That distribution ($${total.toFixed(2)}) exceeds this property's lifetime retained cash ` +
      `($${available.toFixed(2)}) — it would return partner capital. If that's intended, check ` +
      `"confirm over-distribution" and submit again.`,
    )
  }

  // Replace any prior record for this period (idempotent)
  await sql`DELETE FROM distributions WHERE property_id = ${propertyId} AND period = ${period}`
  for (const s of c.split) {
    const amt = (total * s.pct) / 100
    await sql`
      INSERT INTO distributions (period, property_id, owner_id, amount, status)
      VALUES (${period}, ${propertyId}, ${s.owner_id}, ${amt}, 'recorded')
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
