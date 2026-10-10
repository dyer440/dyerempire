// app/api/v1/forecasts/regenerate/route.ts
import { route } from '@/lib/api/http'
import { regenerateForecasts } from '@/lib/api/service'

export const POST = route('write', async ({ body, who }) => regenerateForecasts(await body(), who))
