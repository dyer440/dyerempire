// app/api/v1/categories/route.ts
import { route } from '@/lib/api/http'
import { listCategories } from '@/lib/api/service'

export const GET = route('read', async () => listCategories())
