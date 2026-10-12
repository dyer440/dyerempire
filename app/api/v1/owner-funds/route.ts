// app/api/v1/owner-funds/route.ts
import { route } from '@/lib/api/http'
import { getOwnerFunds } from '@/lib/api/mgmt-fees'

export const GET = route('read', async ({ query }) => getOwnerFunds(query))
