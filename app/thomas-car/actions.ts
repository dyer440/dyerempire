// app/thomas-car/actions.ts  (REWRITE — adds page_access guard to both actions)
'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@clerk/nextjs/server'
import sql from '@/lib/db'
import { getUserRole, canAccessPage } from '@/lib/access'

async function assertCanAccess() {
  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!(await canAccessPage(email, role, 'thomas-car'))) {
    throw new Error('Not authorized')
  }
}

export async function addPayment(formData: FormData) {
  await assertCanAccess()

  const amount = parseFloat(formData.get('amount') as string)
  const note = formData.get('note') as string
  const paid_on = formData.get('paid_on') as string

  if (!amount || amount <= 0) return

  await sql`
    INSERT INTO car_payments (amount, note, paid_on)
    VALUES (${amount}, ${note || null}, ${paid_on})
  `

  revalidatePath('/thomas-car')
}

export async function deletePayment(formData: FormData) {
  await assertCanAccess()

  const id = parseInt(formData.get('id') as string)
  if (!id) return

  await sql`DELETE FROM car_payments WHERE id = ${id}`

  revalidatePath('/thomas-car')
}
