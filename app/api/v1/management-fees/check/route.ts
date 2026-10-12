// app/api/v1/management-fees/check/route.ts
import { route } from '@/lib/api/http'
import { checkManagementFees } from '@/lib/api/mgmt-fees'

export const GET = route('read', async () => checkManagementFees())
