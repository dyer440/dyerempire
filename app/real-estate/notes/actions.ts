'use server'
// The one thing the site writes: a note for the books. It lands in a queue that
// Claude and GrokBot work from; it never posts to the ledger by itself.
import { revalidatePath } from 'next/cache'
import { currentUser } from '@clerk/nextjs/server'
import { getViewer } from '@/lib/viewer'
import { addNote } from '@/lib/notes'

export type NoteState = { ok: boolean; message: string } | null

export async function sendNote(_prev: NoteState, form: FormData): Promise<NoteState> {
  const v = await getViewer()
  if (!v.insider) return { ok: false, message: 'Only David and Betsy can leave notes.' }
  const body = String(form.get('body') || '').trim()
  if (!body) return { ok: false, message: 'Write what happened first, for example who paid, how much, and for which property.' }
  if (body.length > 2000) return { ok: false, message: 'Keep the note under 2,000 characters.' }
  const pid = Number(form.get('property_id'))
  const propertyId = Number.isInteger(pid) && v.properties.some((p) => p.id === pid) ? pid : null
  const user = await currentUser().catch(() => null)
  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || null : null
  await addNote({ body, propertyId, email: v.email, name })
  revalidatePath('/real-estate', 'layout')
  return { ok: true, message: 'Sent. It will show as done here once it has been posted.' }
}
