// app/real-estate/entity/[slug]/actions.ts
'use server'
// Generic entity-ledger actions (any non-property entity: SL Cap Mgmt, SL
// Trading, SL Media…). Generalizes the hardcoded /slcm actions. Role is
// re-checked server-side; amounts stored positive with sign carried by `type`;
// rows are entity-level (property_id NULL). No closed-period check — period_closes
// is keyed to property_id and does not yet cover entities.
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'
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
