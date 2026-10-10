// app/api/v1/properties/route.ts
import { route } from '@/lib/api/http'
import { listProperties } from '@/lib/api/service'

export const GET = route('read', async () => listProperties())
