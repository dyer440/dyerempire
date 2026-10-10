// app/api/v1/notes/[id]/resolve/route.ts
import { route, pathId } from '@/lib/api/http'
import { resolveBookNote } from '@/lib/api/notes'

export const POST = route<{ id: string }>('write', async ({ params, body, who }) =>
  resolveBookNote({ ...(await body()), id: pathId(params.id) }, who),
)
