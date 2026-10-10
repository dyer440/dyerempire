// lib/api/keys.ts
// Bot authentication. Each bot gets its own key ("de_" + 43 url-safe chars,
// 256 bits of randomness). Only the SHA-256 hash is stored, so a database leak
// does not leak usable keys. Keys carry scopes:
//   read  → every GET / read-only MCP tool
//   write → create / edit / confirm / delete-forecast / regenerate
//   sql   → ad-hoc read-only SQL (/query, run_sql)
// Keys are revocable instantly from /admin, and optionally expire.
import { createHash, randomBytes } from 'node:crypto'
import sql from '@/lib/db'

export type Scope = 'read' | 'write' | 'sql'
export const ALL_SCOPES: readonly Scope[] = ['read', 'write', 'sql'] as const

export type BotPrincipal = {
  keyId: number
  name: string
  scopes: Scope[]
  /** What gets written to created_by / mutations_log.actor. */
  actor: string
}

const KEY_PREFIX = 'de_'

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url')
  return { key, prefix: key.slice(0, 11), hash: hashApiKey(key) }
}

export function isScope(s: string): s is Scope {
  return (ALL_SCOPES as readonly string[]).includes(s)
}

/**
 * Accepts `Authorization: Bearer de_...`, a bare `Authorization: de_...` (some
 * MCP clients, e.g. xAI's remote-MCP `authorization` field, may send the token
 * without the scheme), or `X-API-Key: de_...`.
 */
export function extractKey(req: Request): string | null {
  const auth = (req.headers.get('authorization') || '').trim()
  const m = /^Bearer\s+(\S+)$/i.exec(auth)
  const key = m ? m[1] : auth.startsWith(KEY_PREFIX) ? auth : req.headers.get('x-api-key')?.trim() || null
  if (!key || !key.startsWith(KEY_PREFIX) || key.length < 20 || key.length > 200) return null
  return key
}

export async function authenticate(req: Request): Promise<BotPrincipal | null> {
  const key = extractKey(req)
  if (!key) return null
  const rows = (await sql`
    SELECT id, name, scopes
    FROM api_keys
    WHERE key_hash = ${hashApiKey(key)}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `) as { id: number; name: string; scopes: string[] }[]
  const row = rows[0]
  if (!row) return null

  // Cheap usage stamp, at most once a minute per key.
  await sql`
    UPDATE api_keys SET last_used_at = NOW()
    WHERE id = ${row.id} AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')
  `
  return {
    keyId: row.id,
    name: row.name,
    scopes: (row.scopes || []).filter(isScope),
    actor: `bot:${row.name}`,
  }
}
