// lib/api/http.ts
// REST plumbing: authenticate the bearer key, check scope, run the handler, and
// turn any error into a consistent JSON body:
//   { ok: false, error: { code, message, details? } }
// Successful responses are { ok: true, data }.
import { authenticate, type BotPrincipal, type Scope } from './keys'
import { ApiError } from './errors'
import type { Actor } from './service'
import { searchParamsToInput, type Input } from './validate'

const NO_STORE = { 'Cache-Control': 'no-store' }

export function ok(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status, headers: NO_STORE })
}

export function fail(status: number, code: string, message: string, details?: unknown, extraHeaders?: Record<string, string>): Response {
  return Response.json(
    { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers: { ...NO_STORE, ...extraHeaders } },
  )
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return fail(e.status, e.code, e.message, e.details)
  console.error('[api] unhandled error', e)
  return fail(500, 'internal_error', 'Something went wrong on the server. The error has been logged.')
}

export type HandlerCtx<P> = {
  req: Request
  url: URL
  query: Input
  params: P
  principal: BotPrincipal
  who: Actor
  body: () => Promise<Input>
}

/**
 * Wrap a route handler with auth + scope + error handling.
 *   export const GET = route('read', async ({ query }) => listThings(query))
 */
export function route<P = Record<string, string>>(scope: Scope, fn: (ctx: HandlerCtx<P>) => Promise<unknown>, okStatus = 200) {
  return async (req: Request, routeCtx?: { params?: Promise<P> }): Promise<Response> => {
    try {
      const principal = await authenticate(req)
      if (!principal) {
        return fail(401, 'unauthorized', 'Missing or invalid API key. Send Authorization: Bearer <key>.', undefined, {
          'WWW-Authenticate': 'Bearer realm="dyerempire"',
        })
      }
      if (!principal.scopes.includes(scope)) {
        return fail(403, 'insufficient_scope', `This key lacks the "${scope}" scope.`)
      }
      const url = new URL(req.url)
      const params = ((await routeCtx?.params) ?? {}) as P
      const ctx: HandlerCtx<P> = {
        req,
        url,
        query: searchParamsToInput(url.searchParams),
        params,
        principal,
        who: { actor: principal.actor, keyId: principal.keyId, source: 'api' },
        body: async () => {
          const text = await req.text()
          if (!text.trim()) return {}
          let parsed: unknown
          try { parsed = JSON.parse(text) } catch { throw new ApiError(400, 'bad_json', 'Request body is not valid JSON.') }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ApiError(400, 'bad_json', 'Request body must be a JSON object.')
          }
          return parsed as Input
        },
      }
      return ok(await fn(ctx), okStatus)
    } catch (e) {
      return errorResponse(e)
    }
  }
}

export function pathId(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'bad_request', 'id in the URL must be a positive integer.')
  return n
}
