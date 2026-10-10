// app/api/v1/media/entries/[kind]/[id]/void/route.ts
import { route, pathId } from '@/lib/api/http'
import { voidMediaEntry } from '@/lib/api/media'

export const POST = route<{ kind: string; id: string }>('write', async ({ params, body, who }) =>
  voidMediaEntry({ ...(await body()), kind: params.kind, id: pathId(params.id) }, who))
