// app/api/v1/bank/[id]/match/route.ts
import { route, pathId } from '@/lib/api/http'
import { matchBankTxn } from '@/lib/api/bank-post'

export const POST = route<{ id: string }>('write', async ({ params, body, who }) =>
  matchBankTxn({ ...(await body()), bank_txn_id: pathId(params.id) }, who),
)
