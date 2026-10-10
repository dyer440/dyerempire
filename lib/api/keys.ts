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
 * Clients differ in which header they let you set, so the key is accepted from
 * any of these, with or without a "Bearer " prefix on the value:
 *   Authorization, X-API-Key, apikey, api-key
 * (Claude's custom-connector UI reserves Authorization for OAuth, so it uses one
 * of the others; xAI's remote-MCP `authorization` field may omit "Bearer ".)
 */
const KEY_HEADERS = ['authorization', 'x-api-key', 'apikey', 'api-key'] as const

export function extractKey(req: Request): string | null {
  for (const h of KEY_HEADERS) {
    const raw = (req.headers.get(h) || '').trim()
    if (!raw) continue
    const key = raw.replace(/^Bearer\s+/i, '').trim()
    if (key.startsWith(KEY_PREFIX) && key.length >= 20 && key.length <= 200 && !/\s/.test(key)) return key
  }
  return null
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
