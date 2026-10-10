// app/api/v1/schema/route.ts
import { route } from '@/lib/api/http'
import { describeSchema } from '@/lib/api/schema'

export const GET = route('sql', async () => describeSchema())
