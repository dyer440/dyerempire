// app/api/v1/properties/[id]/capital/route.ts
import { route } from '@/lib/api/http'
import { getCapital } from '@/lib/api/service'

export const GET = route<{ id: string }>('read', async ({ params }) => getCapital({ property_id: params.id }))
