// app/real-estate/actions.ts  (NEW — server actions, permission re-checked server-side)
'use server'
import sql from '@/lib/db'
import { auth } from '@clerk/nextjs/server'
import { revalidatePath } from 'next/cache'
import { getUserRole, canEdit, canAccessProperty } from '@/lib/access'
import { INCOME_CATEGORIES } from '@/lib/categories'

async function currentEmail() {
  const { sessionClaims } = await auth()
  return (sessionClaims?.email as string) || ''
}

export async function addTransaction(formData: FormData) {
  const email = await currentEmail()
  const role = await getUserRole(email)
  if (!canEdit(role)) throw new Error('Not authorized')

  const propertyId = Number(formData.get('property_id'))
  if (!(await canAccessProperty(email, role, propertyId))) throw new Error('Not authorized')

  const category = String(formData.get('category') || '')
  const type = (INCOME_CATEGORIES as readonly string[]).includes(category) ? 'income' : 'expense'
  const amount = parseFloat(String(formData.get('amount') || '0'))
  const txnDate = String(formData.get('txn_date') || '')
  const description = String(formData.get('description') || '')
  const unitRaw = String(formData.get('unit_id') || '')
  const unitId = unitRaw ? Number(unitRaw) : null

  if (!amount || amount <= 0 || !category || !txnDate) return

  await sql`
    INSERT INTO transactions (property_id, unit_id, type, category, amount, txn_date, description, created_by)
    VALUES (${propertyId}, ${unitId}, ${type}, ${category}, ${amount}, ${txnDate}, ${description}, ${email})
  `
  revalidatePath(`/real-estate/${propertyId}`)
  revalidatePath('/real-estate')
}

export async function deleteTransaction(formData: FormData) {
  const email = await currentEmail()
  const role = await getUserRole(email)
  if (!canEdit(role)) throw new Error('Not authorized')

  const id = Number(formData.get('id'))
  const propertyId = Number(formData.get('property_id'))
  if (!(await canAccessProperty(email, role, propertyId))) throw new Error('Not authorized')

  await sql`DELETE FROM transactions WHERE id = ${id} AND property_id = ${propertyId}`
  revalidatePath(`/real-estate/${propertyId}`)
  revalidatePath('/real-estate')
}
