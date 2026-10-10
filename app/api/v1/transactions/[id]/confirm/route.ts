// app/api/v1/transactions/[id]/confirm/route.ts
import { route, pathId } from '@/lib/api/http'
import { confirmForecast } from '@/lib/api/service'

export const POST = route<{ id: string }>('write', async ({ params, body, who }) =>
  confirmForecast(pathId(params.id), await body(), who),
)
