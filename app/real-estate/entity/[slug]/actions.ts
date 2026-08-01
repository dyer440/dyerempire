// app/real-estate/entity/[slug]/actions.ts
'use server'
// Generic entity-ledger actions (any non-property entity: SL Cap Mgmt, SL
// Trading, SL Media…). Generalizes the hardcoded /slcm actions. Role is
// re-checked server-side; amounts stored positive with sign carried by `type`;
// rows are entity-level (property_id NULL). No closed-period check — period_closes
// is keyed to property_id and does not yet cover entities.
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { generateEntityForecasts } from '@/lib/recurring'
import { revalidatePath } from 'next/cache'

async function entityBySlug(slug: string): Promise<{ id: number } | null> {
  const rows = (await sql`
    SELECT id FROM entities WHERE slug = ${slug} AND type <> 'property' LIMIT 1
  `) as Record<string, any>[]
  return rows[0] ? { id: rows[0].id } : null
}

export async function addEntityTransaction(slug: string, formData: FormData) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized to edit the books.')
  const entity = await entityBySlug(slug)
  if (!entity) throw new Error('Unknown entity.')

  const type = formData.get('type') === 'income' ? 'income' : 'expense'
  const category = String(formData.get('category') || '').trim()
  const amount = Math.abs(Number(formData.get('amount')))
  const txnDate = String(formData.get('txnDate') || '').trim()
  const description = String(formData.get('description') || '').trim() || null

  if (!category) throw new Error('Category is required.')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) throw new Error('A valid date is required.')

  await sql`
    INSERT INTO transactions
      (type, amount, method, status, category, txn_date, entity_id,
       created_by, is_deposit, description, property_id)
    VALUES
      (${type}, ${amount}, 'manual', 'actual', ${category}, ${txnDate}::date,
       ${entity.id}, ${editor}, FALSE, ${description}, NULL)
  `
  revalidatePath(`/real-estate/entity/${slug}`)
}

export async function deleteEntityTransaction(slug: string, formData: FormData) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized to edit the books.')
  const entity = await entityBySlug(slug)
  if (!entity) throw new Error('Unknown entity.')

  const id = Number(formData.get('id'))
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid transaction id.')

  await sql`
    DELETE FROM transactions
    WHERE id = ${id} AND entity_id = ${entity.id} AND property_id IS NULL
  `
  revalidatePath(`/real-estate/entity/${slug}`)
}

// ── Recurring schedules for the entity (subscriptions, recurring fees) ────────

export async function addEntitySchedule(slug: string, formData: FormData) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized.')
  const entity = await entityBySlug(slug)
  if (!entity) throw new Error('Unknown entity.')

  const type = formData.get('type') === 'income' ? 'income' : 'expense'
  const category = String(formData.get('category') || '').trim()
  const description = String(formData.get('description') || '').trim() || null
  const amount = Math.abs(Number(formData.get('amount')))
  const frequency = String(formData.get('frequency') || 'monthly')
  const dayOfMonth = Math.min(Number(formData.get('day_of_month') || 15) || 15, 28)

  if (!category) throw new Error('Category is required.')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero.')

  await sql`
    INSERT INTO recurring_schedules
      (property_id, entity_id, unit_id, type, category, description, amount,
       is_estimate, frequency, day_of_month, growth_pct, status)
    VALUES (NULL, ${entity.id}, NULL, ${type}, ${category}, ${description}, ${amount},
            FALSE, ${frequency}, ${dayOfMonth}, 0, 'active')
  `
  await generateEntityForecasts(entity.id)
  revalidatePath(`/real-estate/entity/${slug}`)
}

export async function deleteEntitySchedule(slug: string, formData: FormData) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized.')
  const entity = await entityBySlug(slug)
  if (!entity) throw new Error('Unknown entity.')
  const id = Number(formData.get('id'))
  await sql`DELETE FROM recurring_schedules WHERE id = ${id} AND entity_id = ${entity.id} AND property_id IS NULL`
  await generateEntityForecasts(entity.id)
  revalidatePath(`/real-estate/entity/${slug}`)
}

export async function regenerateEntityForecasts(slug: string) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized.')
  const entity = await entityBySlug(slug)
  if (!entity) throw new Error('Unknown entity.')
  await generateEntityForecasts(entity.id)
  revalidatePath(`/real-estate/entity/${slug}`)
}

// Confirm a scheduled (forecast) entity item into an actual, optionally
// adjusting the amount/date to what was actually charged. Keeps schedule_id so
// the generator won't re-create that month.
export async function confirmEntityForecast(slug: string, formData: FormData) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized.')
  const entity = await entityBySlug(slug)
  if (!entity) throw new Error('Unknown entity.')

  const id = Number(formData.get('id'))
  const amtRaw = String(formData.get('actual_amount') || '')
  const dateRaw = String(formData.get('actual_date') || '')
  const amount = amtRaw ? Math.abs(parseFloat(amtRaw)) : null
  const txnDate = dateRaw || null
  if (amount != null && (!Number.isFinite(amount) || amount <= 0)) throw new Error('Bad amount.')
  if (txnDate && !/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) throw new Error('Bad date.')

  await sql`
    UPDATE transactions
    SET status = 'actual', created_by = ${editor},
        amount = COALESCE(${amount}, amount),
        txn_date = COALESCE(${txnDate}::date, txn_date)
    WHERE id = ${id} AND entity_id = ${entity.id} AND property_id IS NULL AND status = 'forecast'
  `
  revalidatePath(`/real-estate/entity/${slug}`)
}
