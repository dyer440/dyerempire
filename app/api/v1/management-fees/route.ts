// app/api/v1/management-fees/route.ts
import { route } from '@/lib/api/http'
import { postManagementFees } from '@/lib/api/mgmt-fees'

export const POST = route('write', async ({ body, who }) => postManagementFees(await body(), who))
