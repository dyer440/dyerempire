// app/api/v1/media/bank/[id]/post/route.ts
import { route, pathId } from '@/lib/api/http'
import { postMediaBankTxn } from '@/lib/api/media'

export const POST = route<{ id: string }>('write', async ({ params, body, who }) =>
  postMediaBankTxn({ ...(await body()), bank_txn_id: pathId(params.id) }, who))
