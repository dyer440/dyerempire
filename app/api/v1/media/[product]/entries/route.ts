// app/api/v1/media/[product]/entries/route.ts
import { route } from '@/lib/api/http'
import { recordMediaEntries } from '@/lib/api/media'

export const POST = route<{ product: string }>('write', async ({ params, body, who }) =>
  recordMediaEntries({ ...(await body()), product: params.product }, who), 201)
