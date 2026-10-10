// app/api/v1/entities/route.ts
import { route } from '@/lib/api/http'
import { listEntities } from '@/lib/api/service'

export const GET = route('read', async () => listEntities())
