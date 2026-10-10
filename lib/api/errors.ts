// lib/api/errors.ts
// One error type for the whole bot API. Service functions throw ApiError with an
// HTTP status and a stable machine-readable code; the REST wrapper and the MCP
// handler both translate it, so a bot sees the same message on either surface.

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (msg: string, details?: unknown) => new ApiError(400, 'bad_request', msg, details)
export const notFound = (msg: string) => new ApiError(404, 'not_found', msg)
export const conflict = (code: string, msg: string, details?: unknown) => new ApiError(409, code, msg, details)
export const forbidden = (msg: string) => new ApiError(403, 'forbidden', msg)

/** Postgres error code from either the Neon driver or node-postgres. */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; sourceError?: { code?: unknown } } | null
  const c = e?.code ?? e?.sourceError?.code
  return typeof c === 'string' ? c : undefined
}
