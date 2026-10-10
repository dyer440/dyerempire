// app/api/v1/properties/[id]/quarters/[period]/route.ts
import { route } from '@/lib/api/http'
import { getQuarter } from '@/lib/api/service'

export const GET = route<{ id: string; period: string }>('read', async ({ params }) =>
  getQuarter({ property_id: params.id, period: params.period }),
)
