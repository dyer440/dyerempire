'use server'

import { revalidatePath } from 'next/cache'
import sql from '@/lib/db'

export async function addPayment(formData: FormData) {
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
  const id = parseInt(formData.get('id') as string)
  if (!id) return

  await sql`DELETE FROM car_payments WHERE id = ${id}`

  revalidatePath('/thomas-car')
}
