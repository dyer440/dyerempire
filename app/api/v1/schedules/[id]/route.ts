// app/api/v1/schedules/[id]/route.ts
import { route, pathId } from '@/lib/api/http'
import { updateSchedule } from '@/lib/api/schedules'

export const PATCH = route<{ id: string }>('write', async ({ params, body, who }) =>
  updateSchedule({ ...(await body()), id: pathId(params.id) }, who),
)
