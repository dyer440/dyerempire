// app/real-estate/recurring/actions.ts  (UPDATED — adds closePeriod / reopenPeriod)
'use server'
import sql from '@/lib/db'
import { auth } from '@clerk/nextjs/server'
import { revalidatePath } from 'next/cache'
import { getUserRole, canEdit, canAccessProperty } from '@/lib/access'
import { generateForecasts } from '@/lib/recurring'

async function guard(propertyId: number) {
  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!canEdit(role)) throw new Error('Not authorized')
  if (!(await canAccessProperty(email, role, propertyId))) throw new Error('Not authorized')
  return email
}

export async function addSchedule(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)

  const type = String(formData.get('type') || 'expense')
  const category = String(formData.get('category') || '')
  const description = String(formData.get('description') || '')
  const amount = parseFloat(String(formData.get('amount') || '0'))
  const frequency = String(formData.get('frequency') || 'monthly')
  const monthsCsv = String(formData.get('months_csv') || '').trim() || null
  const dayOfMonth = Number(formData.get('day_of_month') || 15)
  const isEstimate = formData.get('is_estimate') === 'on'
  const growthPct = parseFloat(String(formData.get('growth_pct') || '0')) || 0
  const startDate = String(formData.get('start_date') || '') || null
  const endRaw = String(formData.get('end_date') || '')
  const endDate = endRaw ? endRaw : null
  const unitRaw = String(formData.get('unit_id') || '')
  const unitId = unitRaw ? Number(unitRaw) : null

  if (!category || !amount || amount <= 0) return

  await sql`
    INSERT INTO recurring_schedules
      (property_id, unit_id, type, category, description, amount, is_estimate,
       frequency, months_csv, day_of_month, growth_pct, start_date, end_date, status)
    VALUES (${propertyId}, ${unitId}, ${type}, ${category}, ${description}, ${amount}, ${isEstimate},
            ${frequency}, ${monthsCsv}, ${dayOfMonth}, ${growthPct}, ${startDate}, ${endDate}, 'active')
  `
  await generateForecasts(propertyId)
  revalidatePath(`/real-estate/${propertyId}/schedules`)
  revalidatePath(`/real-estate/${propertyId}`)
}

export async function deleteSchedule(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)
  const id = Number(formData.get('id'))

  await sql`DELETE FROM recurring_schedules WHERE id = ${id} AND property_id = ${propertyId}`
  await generateForecasts(propertyId)
  revalidatePath(`/real-estate/${propertyId}/schedules`)
  revalidatePath(`/real-estate/${propertyId}`)
}

export async function toggleSchedule(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)
  const id = Number(formData.get('id'))
  const next = String(formData.get('next_status') || 'active')

  await sql`UPDATE recurring_schedules SET status = ${next} WHERE id = ${id} AND property_id = ${propertyId}`
  await generateForecasts(propertyId)
  revalidatePath(`/real-estate/${propertyId}/schedules`)
  revalidatePath(`/real-estate/${propertyId}`)
}

export async function regenerateForecasts(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)
  await generateForecasts(propertyId)
  revalidatePath(`/real-estate/${propertyId}/schedules`)
  revalidatePath(`/real-estate/${propertyId}`)
}

export async function markForecastPaid(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)
  const id = Number(formData.get('id'))
  const amtRaw = String(formData.get('actual_amount') || '')
  const dateRaw = String(formData.get('actual_date') || '')
  const amount = amtRaw ? parseFloat(amtRaw) : null
  const txnDate = dateRaw ? dateRaw : null

  await sql`
    UPDATE transactions
    SET status = 'actual',
        created_by = 'confirmed',
        amount = COALESCE(${amount}, amount),
        txn_date = COALESCE(${txnDate}::date, txn_date)
    WHERE id = ${id} AND property_id = ${propertyId} AND status = 'forecast'
  `
  revalidatePath(`/real-estate/${propertyId}`)
}

export async function deleteForecast(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)
  const id = Number(formData.get('id'))

  await sql`
    DELETE FROM transactions
    WHERE id = ${id} AND property_id = ${propertyId} AND status = 'forecast'
  `
  revalidatePath(`/real-estate/${propertyId}`)
}

// ---- Period locking (soft close) ----

// Close a quarter: clear any leftover forecasts in the period (a closed quarter
// holds only actuals), then record the lock so the scheduler won't refill it.
export async function closePeriod(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  const email = await guard(propertyId)
  const label = String(formData.get('label') || '')
  const periodStart = String(formData.get('period_start') || '')
  const periodEnd = String(formData.get('period_end') || '')
  if (!label || !periodStart || !periodEnd) return

  await sql`
    DELETE FROM transactions
    WHERE property_id = ${propertyId} AND status = 'forecast'
      AND txn_date BETWEEN ${periodStart} AND ${periodEnd}
  `
  await sql`
    INSERT INTO period_closes (property_id, period_start, period_end, label, closed_by)
    VALUES (${propertyId}, ${periodStart}, ${periodEnd}, ${label}, ${email})
    ON CONFLICT (property_id, label) DO NOTHING
  `
  revalidatePath(`/real-estate/${propertyId}/periods`)
  revalidatePath(`/real-estate/${propertyId}`)
}

// Reopen a quarter: remove the lock, then regenerate (refills future forecasts only).
export async function reopenPeriod(formData: FormData) {
  const propertyId = Number(formData.get('property_id'))
  await guard(propertyId)
  const label = String(formData.get('label') || '')

  await sql`DELETE FROM period_closes WHERE property_id = ${propertyId} AND label = ${label}`
  await generateForecasts(propertyId)
  revalidatePath(`/real-estate/${propertyId}/periods`)
  revalidatePath(`/real-estate/${propertyId}`)
}
