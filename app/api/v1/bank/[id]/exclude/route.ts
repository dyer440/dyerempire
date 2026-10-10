// app/api/v1/bank/[id]/exclude/route.ts
import { route, pathId } from '@/lib/api/http'
import { excludeBankTxn } from '@/lib/api/bank-post'

export const POST = route<{ id: string }>('write', async ({ params, body, who }) =>
  excludeBankTxn({ ...(await body()), bank_txn_id: pathId(params.id) }, who),
)
