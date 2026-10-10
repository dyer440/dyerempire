// lib/api/sql-runner.ts
// Ad-hoc SQL for bots, read-only by three independent layers:
//   1. Lexical gate: one statement, must start with SELECT / WITH / EXPLAIN /
//      TABLE / VALUES / SHOW, and no write keywords as top-level verbs.
//   2. Every query runs inside a READ ONLY transaction with a statement timeout.
//   3. In production it connects as dyer_bot_ro (DATABASE_URL_READONLY), a role
//      that only has SELECT grants. See migrations/2026-10_bot_readonly_role.sql.
// Layer 3 is the real wall; 1 and 2 give friendly errors and cover the window
// before the role exists.
import { neon } from '@neondatabase/serverless'
import { badRequest, ApiError } from './errors'

const MAX_ROWS_CAP = 2000
const MAX_SQL_LENGTH = 20_000

/** Strip comments and string/identifier literals so keyword checks see only SQL. */
export function stripSqlNoise(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i], n = text[i + 1]
    if (c === '-' && n === '-') { while (i < text.length && text[i] !== '\n') i++; out += ' '; continue }
    if (c === '/' && n === '*') {
      let depth = 1; i += 2
      while (i < text.length && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2 }
        else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      out += ' '; continue
    }
    if (c === "'" || c === '"') {
      const q = c; i++
      while (i < text.length) {
        if (text[i] === q && text[i + 1] === q) { i += 2; continue }
        if (text[i] === q) { i++; break }
        i++
      }
      out += q === "'" ? " '' " : ' "x" '; continue
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))
      if (m) {
        const tag = m[0]
        const end = text.indexOf(tag, i + tag.length)
        i = end === -1 ? text.length : end + tag.length
        out += " '' "; continue
      }
    }
    out += c; i++
  }
  return out
}

const ALLOWED_START = /^\s*\(*\s*(SELECT|WITH|EXPLAIN|TABLE|VALUES|SHOW)\b/i
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|ANALYZE|CLUSTER|REINDEX|LOCK|LISTEN|NOTIFY|PREPARE|EXECUTE|DEALLOCATE|DISCARD|RESET|SET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|REFRESH|SECURITY|IMPORT|LOAD|CHECKPOINT|COMMENT)\b/i
const FORBIDDEN_FUNCS = /\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink\w*|pg_terminate_backend|pg_cancel_backend|set_config|nextval|setval|pg_advisory\w*)\s*\(/i

export function assertReadOnlySql(text: string): string {
  if (typeof text !== 'string' || !text.trim()) throw badRequest('sql is required.')
  if (text.length > MAX_SQL_LENGTH) throw badRequest(`sql is longer than ${MAX_SQL_LENGTH} characters.`)
  const clean = stripSqlNoise(text).trim().replace(/;\s*$/, '')
  if (clean.includes(';')) throw badRequest('Send one statement at a time (no semicolons).')
  if (!ALLOWED_START.test(clean)) throw badRequest('Only read queries are allowed: SELECT, WITH, EXPLAIN, TABLE, VALUES, SHOW.')
  // SHOW is a single word command; anything else with SET/RESET etc. is rejected.
  const body = clean.replace(/^\s*SHOW\b/i, '')
  const bad = FORBIDDEN.exec(body)
  if (bad) throw badRequest(`"${bad[1].toUpperCase()}" is not allowed. This endpoint is read-only; use the typed write tools for changes.`)
  // EXPLAIN ANALYZE executes the statement; plain EXPLAIN is fine.
  const fn = FORBIDDEN_FUNCS.exec(body)
  if (fn) throw badRequest(`${fn[1]}() is not allowed here.`)
  return text.trim().replace(/;\s*$/, '')
}

function normaliseValue(v: unknown): unknown {
  if (v instanceof Date) {
    const iso = v.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  }
  return v
}

export type SqlResult = {
  columns: string[]
  rows: Record<string, unknown>[]
  row_count: number
  truncated: boolean
  read_only_role: boolean
}

export async function runReadOnlySql(text: string, params: unknown[] = [], maxRows = 500): Promise<SqlResult> {
  const query = assertReadOnlySql(text)
  if (!Array.isArray(params)) throw badRequest('params must be an array.')
  if (params.length > 50) throw badRequest('Too many params.')
  const cap = Math.max(1, Math.min(MAX_ROWS_CAP, Math.floor(Number(maxRows) || 500)))

  const roUrl = process.env.DATABASE_URL_READONLY
  const db = neon(roUrl || process.env.DATABASE_URL!, { fullResults: true })
  try {
    const results = await db.transaction(
      (tx) => [
        tx.query("SET LOCAL statement_timeout = '10s'"),
        tx.query(query, params as never[]),
      ],
      { readOnly: true, isolationLevel: 'RepeatableRead', fullResults: true },
    )
    const res = results[1] as unknown as { rows: Record<string, unknown>[]; fields: { name: string }[] }
    const all = res.rows || []
    const rows = all.slice(0, cap).map((r) => {
      const o: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r)) o[k] = normaliseValue(v)
      return o
    })
    return {
      columns: (res.fields || []).map((f) => f.name),
      rows,
      row_count: all.length,
      truncated: all.length > cap,
      read_only_role: !!roUrl,
    }
  } catch (e) {
    if (e instanceof ApiError) throw e
    const err = e as { message?: string; code?: string }
    throw new ApiError(400, 'sql_error', `Query failed: ${err.message ?? 'unknown error'}`, { pg_code: err.code })
  }
}
