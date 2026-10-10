// app/api/v1/media/[product]/route.ts
import { route } from '@/lib/api/http'
import { getMediaLedger } from '@/lib/api/media'

export const GET = route<{ product: string }>('read', async ({ params, query }) => getMediaLedger({ ...query, product: params.product }))
