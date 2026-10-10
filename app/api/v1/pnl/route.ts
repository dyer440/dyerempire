// app/api/v1/pnl/route.ts
import { route } from '@/lib/api/http'
import { getPnl } from '@/lib/api/reports'

export const GET = route('read', async ({ query }) => getPnl(query))
