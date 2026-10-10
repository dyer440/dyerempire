// app/api/v1/transactions/[id]/void/route.ts
import { route, pathId } from '@/lib/api/http'
import { voidTransaction } from '@/lib/api/void'

export const POST = route<{ id: string }>('write', async ({ params, body, who }) =>
  voidTransaction({ ...(await body()), id: pathId(params.id) }, who),
)
