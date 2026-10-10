// app/api/v1/leases/route.ts
import { route } from '@/lib/api/http'
import { listLeasesApi, upsertLease } from '@/lib/api/leases'

export const GET = route('read', async ({ query }) => listLeasesApi(query))
export const POST = route('write', async ({ body, who }) => upsertLease(await body(), who))
