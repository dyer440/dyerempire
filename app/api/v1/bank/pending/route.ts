// app/api/v1/bank/pending/route.ts
import { route } from '@/lib/api/http'
import { listPendingBank } from '@/lib/api/bank'

export const GET = route('read', async ({ query }) => listPendingBank(query))
