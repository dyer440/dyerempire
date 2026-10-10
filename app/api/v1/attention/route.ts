// app/api/v1/attention/route.ts
import { route } from '@/lib/api/http'
import { getAttention } from '@/lib/api/attention'

export const GET = route('read', async () => getAttention())
