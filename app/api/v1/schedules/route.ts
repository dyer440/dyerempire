// app/api/v1/schedules/route.ts
import { route } from '@/lib/api/http'
import { listSchedules, createSchedule } from '@/lib/api/schedules'

export const GET = route('read', async ({ query }) => listSchedules(query))

export const POST = route('write', async ({ body, who }) => createSchedule(await body(), who), 201)
