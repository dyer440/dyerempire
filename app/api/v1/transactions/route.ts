// app/api/v1/transactions/route.ts
import { route } from '@/lib/api/http'
import { listTransactions, createTransaction } from '@/lib/api/service'

export const GET = route('read', async ({ query }) => listTransactions(query))

export const POST = route(
  'write',
  async ({ req, body, who }) => createTransaction(await body(), who, req.headers.get('idempotency-key')),
  201,
)
