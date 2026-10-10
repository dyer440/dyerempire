// app/api/v1/properties/[id]/quarters/[period]/close/route.ts
import { route, pathId } from '@/lib/api/http'
import { closePeriod } from '@/lib/api/periods'

export const POST = route<{ id: string; period: string }>('write', async ({ params, body, who }) =>
  closePeriod({ ...(await body()), property_id: pathId(params.id), period: params.period }, who),
)
