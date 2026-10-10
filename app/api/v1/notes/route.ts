// app/api/v1/notes/route.ts
import { route } from '@/lib/api/http'
import { listBookNotes } from '@/lib/api/notes'

export const GET = route('read', async ({ query }) => listBookNotes(query))
