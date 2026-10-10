// app/api/v1/bank/[id]/revert/route.ts
import { route, pathId } from '@/lib/api/http'
import { revertBankTxn } from '@/lib/api/bank-post'

export const POST = route<{ id: string }>('write', async ({ params, body, who }) =>
  revertBankTxn({ ...(await body()), bank_txn_id: pathId(params.id) }, who),
)
