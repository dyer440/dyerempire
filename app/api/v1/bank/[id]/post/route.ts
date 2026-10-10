// app/api/v1/bank/[id]/post/route.ts
import { route, pathId } from '@/lib/api/http'
import { postBankTxn } from '@/lib/api/bank-post'

export const POST = route<{ id: string }>('write', async ({ params, body, who }) =>
  postBankTxn({ ...(await body()), bank_txn_id: pathId(params.id) }, who),
)
