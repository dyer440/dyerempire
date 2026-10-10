// app/api/v1/leases/[id]/end/route.ts
import { route, pathId } from '@/lib/api/http'
import { endLease } from '@/lib/api/leases'

export const POST = route<{ id: string }>('write', async ({ params, body, who }) =>
  endLease({ ...(await body()), lease_id: pathId(params.id) }, who))
