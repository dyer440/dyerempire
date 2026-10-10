// test/integration/bot-api.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
// End-to-end: real route handlers → service layer → real Postgres.
// Builds the schema with the app's own initDb(), applies both 2026-10
// migrations verbatim, seeds a small portfolio, then drives the API the way a
// bot would. See vitest.integration.config.ts for how to run it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { initDb } from '@/lib/init-db'
import { generateApiKey } from '@/lib/api/keys'
import { closeAll } from './pg-neon'

import * as Index from '@/app/api/v1/route'
import * as Props from '@/app/api/v1/properties/route'
import * as Cats from '@/app/api/v1/categories/route'
import * as Ents from '@/app/api/v1/entities/route'
import * as Txns from '@/app/api/v1/transactions/route'
import * as Txn from '@/app/api/v1/transactions/[id]/route'
import * as Confirm from '@/app/api/v1/transactions/[id]/confirm/route'
import * as Regen from '@/app/api/v1/forecasts/regenerate/route'
import * as Pnl from '@/app/api/v1/pnl/route'
import * as Attention from '@/app/api/v1/attention/route'
import * as Bank from '@/app/api/v1/bank/pending/route'
import * as BankImport from '@/app/api/v1/bank/import/route'
import * as BankPost from '@/app/api/v1/bank/[id]/post/route'
import * as BankMatch from '@/app/api/v1/bank/[id]/match/route'
import * as BankExclude from '@/app/api/v1/bank/[id]/exclude/route'
import * as BankRevert from '@/app/api/v1/bank/[id]/revert/route'
import * as Scheds from '@/app/api/v1/schedules/route'
import * as Dist from '@/app/api/v1/properties/[id]/quarters/[period]/distribution/route'
import * as Close from '@/app/api/v1/properties/[id]/quarters/[period]/close/route'
import * as Reopen from '@/app/api/v1/properties/[id]/quarters/[period]/reopen/route'
import * as Sched from '@/app/api/v1/schedules/[id]/route'
import * as Changes from '@/app/api/v1/changes/route'
import * as Quarter from '@/app/api/v1/properties/[id]/quarters/[period]/route'
import * as Capital from '@/app/api/v1/properties/[id]/capital/route'
import * as Schema from '@/app/api/v1/schema/route'
import * as Query from '@/app/api/v1/query/route'
import * as Mcp from '@/app/api/mcp/route'

const OWNER_URL = process.env.DATABASE_URL!
const RO_URL = process.env.PG_TEST_RO_URL ?? 'postgres://dyer_bot_ro:ro@localhost:54329/neondb'
const owner = new pg.Pool({ connectionString: OWNER_URL })
const q = async (text: string, params: unknown[] = []) => (await owner.query(text, params)).rows

const keys: Record<string, string> = {}
const BASE = 'https://dyerempire.test'

// ── date helpers relative to "today", so the suite never rots ─────────────────
const today = new Date()
const iso = (d: Date) => d.toISOString().slice(0, 10)
const monthStart = (offset: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1))
const ym = (d: Date) => iso(d).slice(0, 7)
const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 86400000))

type Json = { ok: boolean; data?: any; error?: { code: string; message: string; details?: any } }

async function call(
  handler: (req: Request, ctx?: any) => Promise<Response>,
  opts: { method?: string; path?: string; key?: string | null; body?: unknown; params?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  const key = opts.key === undefined ? keys.full : opts.key
  if (key) headers.authorization = `Bearer ${key}`
  const req = new Request(BASE + (opts.path ?? '/api/v1/x'), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : ({} as Json) }
}

async function mcp(body: unknown, key: string | null = keys.full) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (key) headers.authorization = `Bearer ${key}`
  const res = await Mcp.POST(new Request(BASE + '/api/mcp', { method: 'POST', headers, body: JSON.stringify(body) }))
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

const ids: Record<string, number> = {}

beforeAll(async () => {
  // Fresh schema, owned by neondb_owner exactly like Neon.
  await q('DROP SCHEMA IF EXISTS public CASCADE')
  await q('CREATE SCHEMA public')
  const ro = await q(`SELECT 1 FROM pg_roles WHERE rolname = 'dyer_bot_ro'`)
  if (ro.length) await q('DROP ROLE dyer_bot_ro')

  await initDb() // the app's own DDL

  // Tables created by earlier migrations that aren't in initDb (inferred from usage).
  await q(`
    CREATE TABLE categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
                             is_active BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0);
    CREATE TABLE bank_accounts (id SERIAL PRIMARY KEY, name TEXT, last4 TEXT);
    CREATE TABLE bank_txns (id SERIAL PRIMARY KEY, account_id INT REFERENCES bank_accounts(id), txn_date DATE,
      amount NUMERIC(12,2), name_raw TEXT, memo TEXT, check_number TEXT, name_norm TEXT, occurrence INT,
      import_hash TEXT UNIQUE, status TEXT DEFAULT 'pending', exclude_reason TEXT, resolved_by TEXT, resolved_at TIMESTAMP);
    CREATE TABLE bank_txn_legs (id SERIAL PRIMARY KEY, bank_txn_id INT REFERENCES bank_txns(id),
      transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL, link_type TEXT, amount NUMERIC(12,2));
    CREATE TABLE import_rules (id SERIAL PRIMARY KEY, pattern TEXT, amount NUMERIC(12,2), applies_to TEXT DEFAULT 'any',
      target_kind TEXT, property_id INT, entity_id INT, category TEXT, is_rent BOOLEAN DEFAULT FALSE, unit_id INT,
      is_deposit BOOLEAN DEFAULT FALSE, exclude_reason TEXT, note TEXT, created_by TEXT, times_used INT DEFAULT 0,
      last_used TIMESTAMP);
  `)

  // The two migrations, verbatim.
  await q(readFileSync('migrations/2026-10_bot_api.sql', 'utf8'))
  await q(readFileSync('migrations/2026-10_bot_readonly_role.sql', 'utf8').replace('REPLACE_WITH_LONG_RANDOM_PASSWORD', 'ro'))

  // ── seed ───────────────────────────────────────────────────────────────────
  const cats: [string, string][] = [
    ['Rental Income', 'income'], ['Late Fee', 'income'], ['Other Income', 'income'],
    ['Property Taxes', 'expense'], ['Insurance', 'expense'], ['Repairs & Maintenance', 'expense'],
    ['Utilities', 'expense'], ['Mortgage Interest', 'expense'], ['Management Fee', 'expense'], ['Payroll', 'expense'], ['Security Deposit', 'expense'],
  ]
  for (const [i, [n, k]] of cats.entries()) await q('INSERT INTO categories (name, kind, sort_order) VALUES ($1,$2,$3)', [n, k, i])

  const [slcm] = await q(`INSERT INTO entities (slug, name, type) VALUES ('slcm','Second Line Capital Management LLC','management_co') RETURNING id`)
  const [hold] = await q(`INSERT INTO entities (slug, name, type) VALUES ('913-llc','913 LLC','holding_co') RETURNING id`)
  const [pA] = await q(`INSERT INTO properties (name, entity_id, status) VALUES ('913', $1, 'active') RETURNING id`, [hold.id])
  const [pB] = await q(`INSERT INTO properties (name, entity_id, status) VALUES ('Belford', $1, 'active') RETURNING id`, [slcm.id])
  const [unitA] = await q(`INSERT INTO units (property_id, label) VALUES ($1, 'Unit 1') RETURNING id`, [pA.id])
  const [o1] = await q(`INSERT INTO owners (name, type) VALUES ('David', 'person') RETURNING id`)
  const [o2] = await q(`INSERT INTO owners (name, type) VALUES ('Black Sevens LLC', 'entity') RETURNING id`)
  await q('INSERT INTO property_owners (property_id, owner_id, ownership_pct) VALUES ($1,$2,50),($1,$3,50)', [pA.id, o1.id, o2.id])
  await q('INSERT INTO property_owners (property_id, owner_id, ownership_pct) VALUES ($1,$2,100)', [pB.id, o1.id])
  // Q1 2026 closed for 913
  await q(`INSERT INTO period_closes (property_id, period_start, period_end, label) VALUES ($1,'2026-01-01','2026-03-31','2026-Q1')`, [pA.id])

  const ins = async (cols: Record<string, unknown>) => {
    const k = Object.keys(cols)
    const [r] = await q(`INSERT INTO transactions (${k.join(',')}) VALUES (${k.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, Object.values(cols))
    return r.id as number
  }
  // 913: rent in Jan-Mar 2026 (closed), tax, a deposit, rent 3 and 2 months ago (NOT last month → rent gap)
  for (const m of ['2026-01-05', '2026-02-05', '2026-03-05']) {
    await ins({ property_id: pA.id, type: 'income', category: 'Rental Income', amount: 1000, txn_date: m, status: 'actual' })
  }
  await ins({ property_id: pA.id, type: 'expense', category: 'Property Taxes', amount: 724.06, txn_date: '2026-02-20', status: 'actual' })
  await ins({ property_id: pA.id, type: 'expense', category: 'Repairs & Maintenance', amount: 150, txn_date: '2026-03-10', status: 'actual' })
  await ins({ property_id: pA.id, type: 'income', category: 'Rental Income', amount: 2000, txn_date: '2026-03-01', status: 'actual', is_deposit: true })
  for (const off of [-3, -2]) {
    const d = monthStart(off); d.setUTCDate(5)
    await ins({ property_id: pA.id, type: 'income', category: 'Rental Income', amount: 1000, txn_date: iso(d), status: 'actual' })
  }
  // A genuine-looking duplicate pair for the attention check.
  await ins({ property_id: pA.id, type: 'expense', category: 'Utilities', amount: 61.1, txn_date: daysAgo(30), status: 'actual' })
  await ins({ property_id: pA.id, type: 'expense', category: 'Utilities', amount: 61.1, txn_date: daysAgo(27), status: 'actual' })
  ids.overdue = await ins({ property_id: pB.id, type: 'expense', category: 'Insurance', amount: 674.62, txn_date: daysAgo(20), status: 'forecast' })
  ids.future = await ins({ property_id: pB.id, type: 'expense', category: 'Property Taxes', amount: 900, txn_date: iso(new Date(today.getTime() + 30 * 86400000)), status: 'forecast' })
  ids.bankLinked = await ins({ property_id: pB.id, type: 'expense', category: 'Utilities', amount: 88.5, txn_date: daysAgo(10), status: 'actual' })
  ids.actualB = await ins({ property_id: pB.id, type: 'income', category: 'Rental Income', amount: 1350, txn_date: daysAgo(15), status: 'actual' })
  await ins({ entity_id: slcm.id, type: 'income', category: 'Management Fee', amount: 270, txn_date: daysAgo(15), status: 'actual' })

  const [acct] = await q(`INSERT INTO bank_accounts (name, last4) VALUES ('SLCM Checking','1234') RETURNING id`)
  const [bt] = await q(`INSERT INTO bank_txns (account_id, txn_date, amount, name_raw, name_norm, import_hash, status)
                        VALUES ($1, $2, -88.50, 'AEP UTILITY', 'AEP', 'h1', 'posted') RETURNING id`, [acct.id, daysAgo(10)])
  await q(`INSERT INTO bank_txn_legs (bank_txn_id, transaction_id, link_type, amount) VALUES ($1,$2,'created',88.5)`, [bt.id, ids.bankLinked])
  await q(`INSERT INTO bank_txns (account_id, txn_date, amount, name_raw, name_norm, import_hash)
           VALUES ($1, $2, -196.25, 'LIGHTSTREAM LOAN', 'LIGHTSTREAM', 'h2')`, [acct.id, daysAgo(3)])
  await q(`INSERT INTO import_rules (pattern, target_kind, property_id, category, applies_to)
           VALUES ('LIGHTSTREAM', 'property', $1, 'Other Expense', 'debit')`, [pB.id])

  const [sched] = await q(`INSERT INTO recurring_schedules (property_id, type, category, amount, frequency, day_of_month)
                           VALUES ($1, 'expense', 'Insurance', 50, 'monthly', 10) RETURNING id`, [pB.id])
  ids.schedule = sched.id

  ids.pA = pA.id; ids.pB = pB.id; ids.unitA = unitA.id; ids.slcm = slcm.id

  // Keys
  const mk = async (name: string, scopes: string[], revoked = false) => {
    const k = generateApiKey()
    await q(`INSERT INTO api_keys (name, key_prefix, key_hash, scopes, revoked_at) VALUES ($1,$2,$3,$4,$5)`,
      [name, k.prefix, k.hash, scopes, revoked ? new Date() : null])
    return k.key
  }
  keys.full = await mk('TestBot', ['read', 'write', 'sql'])
  keys.read = await mk('Reader', ['read'])
  keys.revoked = await mk('Old', ['read', 'write'], true)
}, 60_000)

afterAll(async () => {
  await owner.end()
  await closeAll()
})

// ─────────────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('rejects missing, malformed, and revoked keys with 401', async () => {
    expect((await call(Props.GET, { key: null })).status).toBe(401)
    expect((await call(Props.GET, { key: 'de_not-a-real-key-at-all-000000' })).status).toBe(401)
    expect((await call(Props.GET, { key: keys.revoked })).status).toBe(401)
  })
  it('enforces scopes (read key cannot write or run SQL)', async () => {
    const r = await call(Txns.POST, { method: 'POST', key: keys.read, body: {} })
    expect(r.status).toBe(403)
    expect(r.json.error?.code).toBe('insufficient_scope')
    expect((await call(Query.POST, { method: 'POST', key: keys.read, body: { sql: 'SELECT 1' } })).status).toBe(403)
  })
  it('accepts X-API-Key and a bare Authorization token as well as Bearer', async () => {
    expect((await call(Props.GET, { key: null, headers: { 'x-api-key': keys.read } })).status).toBe(200)
    expect((await call(Props.GET, { key: null, headers: { authorization: keys.read } })).status).toBe(200)
    // Claude's connector UI: custom header name, value with or without "Bearer "
    expect((await call(Props.GET, { key: null, headers: { apikey: keys.read } })).status).toBe(200)
    expect((await call(Props.GET, { key: null, headers: { apikey: `Bearer ${keys.read}` } })).status).toBe(200)
    expect((await call(Props.GET, { key: null, headers: { 'api-key': keys.read } })).status).toBe(200)
    expect((await call(Props.GET, { key: null, headers: { apikey: 'Bearer nope' } })).status).toBe(401)
  })
  it('index reports the bot and its scopes', async () => {
    const r = await call(Index.GET, { key: keys.read })
    expect(r.json.data.bot).toBe('Reader')
    expect(r.json.data.mcp_tools).not.toContain('create_transaction')
  })
  it('stamps last_used_at', async () => {
    const [row] = await q(`SELECT last_used_at FROM api_keys WHERE name = 'Reader'`)
    expect(row.last_used_at).not.toBeNull()
  })
})

describe('reference reads', () => {
  it('properties carry owners and units', async () => {
    const r = await call(Props.GET)
    const p913 = r.json.data.find((p: any) => p.name === '913')
    expect(p913.owners).toHaveLength(2)
    expect(p913.owners[0].pct).toBe(50)
    expect(p913.units[0].label).toBe('Unit 1')
    expect(p913.has_closed_periods).toBe(true)
  })
  it('categories come from the table with 8825 lines', async () => {
    const r = await call(Cats.GET)
    const tax = r.json.data.find((c: any) => c.name === 'Property Taxes')
    expect(tax).toMatchObject({ kind: 'expense', form_8825_line: 'Taxes' })
  })
  it('entities omit tax_id', async () => {
    const r = await call(Ents.GET)
    expect(r.json.data[0]).not.toHaveProperty('tax_id')
  })
})

describe('create_transaction', () => {
  it('records an actual, derives type, stamps the bot, and logs atomically', async () => {
    const r = await call(Txns.POST, {
      method: 'POST',
      body: { property_id: ids.pB, category: 'repairs & maintenance', amount: '$1,234.50', txn_date: daysAgo(5), description: 'Gutter repair' },
    })
    expect(r.status).toBe(201)
    const t = r.json.data
    expect(t).toMatchObject({ type: 'expense', category: 'Repairs & Maintenance', amount: 1234.5, status: 'actual', method: 'api', created_by: 'bot:TestBot' })
    expect(t.entity_id).toBe(ids.slcm) // inherited from the property, like bank import
    const log = await q(`SELECT * FROM mutations_log WHERE target_id = $1 AND action = 'transaction.create'`, [t.id])
    expect(log).toHaveLength(1)
    expect(log[0].after.amount).toBe(1234.5)
    expect(log[0].source).toBe('api')
    ids.created = t.id
  })
  it('refuses an exact duplicate unless allow_duplicate', async () => {
    const body = { property_id: ids.pB, category: 'Repairs & Maintenance', amount: 1234.5, txn_date: daysAgo(5) }
    const r = await call(Txns.POST, { method: 'POST', body })
    expect(r.status).toBe(409)
    expect(r.json.error?.code).toBe('duplicate')
    const ok = await call(Txns.POST, { method: 'POST', body: { ...body, allow_duplicate: true } })
    expect(ok.status).toBe(201)
    expect(ok.json.data.nearby_similar.length).toBeGreaterThan(0)
  })
  it('steers to confirm_forecast when a scheduled item matches', async () => {
    const r = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, category: 'Insurance', amount: 674.62, txn_date: daysAgo(18) } })
    expect(r.status).toBe(409)
    expect(r.json.error?.code).toBe('forecast_exists')
    expect(r.json.error?.details.matching_forecasts[0].id).toBe(ids.overdue)
  })
  it('is idempotent with Idempotency-Key', async () => {
    const body = { property_id: ids.pB, category: 'Late Fee', amount: 25, txn_date: daysAgo(2) }
    const h = { 'idempotency-key': 'grok-test-latefee-1' }
    const a = await call(Txns.POST, { method: 'POST', body, headers: h })
    const b = await call(Txns.POST, { method: 'POST', body, headers: h })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(b.json.data.idempotent_replay).toBe(true)
    expect(b.json.data.id).toBe(a.json.data.id)
    const rows = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE category = 'Late Fee'`)
    expect(rows[0].n).toBe(1)
  })
  it('refuses closed periods', async () => {
    const r = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pA, category: 'Utilities', amount: 10, txn_date: '2026-02-11' } })
    expect(r.status).toBe(409)
    expect(r.json.error?.code).toBe('period_closed')
  })
  it('rejects unknown categories with the valid list, and type/category mismatch', async () => {
    const r = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, category: 'Snacks', amount: 10, txn_date: daysAgo(1) } })
    expect(r.status).toBe(400)
    expect(r.json.error?.details.valid_categories).toContain('Utilities')
    const m = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, category: 'Utilities', type: 'income', amount: 10, txn_date: daysAgo(1) } })
    expect(m.status).toBe(400)
  })
  it('validates shape: one target, positive amount, real date, unit belongs', async () => {
    const both = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, entity_id: ids.slcm, category: 'Utilities', amount: 1, txn_date: daysAgo(1) } })
    expect(both.status).toBe(400)
    const neg = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, category: 'Utilities', amount: -5, txn_date: daysAgo(1) } })
    expect(neg.status).toBe(400)
    const bad = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, category: 'Utilities', amount: 5, txn_date: '2026-02-31' } })
    expect(bad.status).toBe(400)
    const unit = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, unit_id: ids.unitA, category: 'Utilities', amount: 5, txn_date: daysAgo(1) } })
    expect(unit.status).toBe(400)
  })
  it('records deposits the way the UI does (excluded from P&L)', async () => {
    const r = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, is_deposit: true, type: 'income', amount: 1350, txn_date: daysAgo(4) } })
    expect(r.status).toBe(201)
    expect(r.json.data).toMatchObject({ category: 'Rental Income', is_deposit: true })
    ids.deposit = r.json.data.id
    const sd = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, category: 'Security Deposit', amount: 5, txn_date: daysAgo(1) } })
    expect(sd.status).toBe(400)
  })
  it('posts to entity books', async () => {
    const r = await call(Txns.POST, { method: 'POST', body: { entity_id: ids.slcm, category: 'Payroll', amount: 188.83, txn_date: daysAgo(6) } })
    expect(r.status).toBe(201)
    expect(r.json.data.property_id).toBeNull()
  })
})

describe('update / confirm / delete', () => {
  it('updates fields and logs before/after', async () => {
    const r = await call(Txn.PATCH, { method: 'PATCH', params: { id: String(ids.created) }, body: { description: 'Gutter repair, rear', amount: 1200 } })
    expect(r.status).toBe(200)
    expect(r.json.data.amount).toBe(1200)
    expect(r.json.data.change_history[0].action).toBe('transaction.update')
    const [log] = await q(`SELECT before, after FROM mutations_log WHERE target_id = $1 AND action = 'transaction.update'`, [ids.created])
    expect(log.before.amount).toBe(1234.5)
    expect(log.after.amount).toBe(1200)
  })
  it('refuses to flip direction, change locked fields, or edit bank-reconciled amounts', async () => {
    const dir = await call(Txn.PATCH, { method: 'PATCH', params: { id: String(ids.created) }, body: { category: 'Rental Income' } })
    expect(dir.status).toBe(400)
    const locked = await call(Txn.PATCH, { method: 'PATCH', params: { id: String(ids.created) }, body: { status: 'forecast' } })
    expect(locked.status).toBe(400)
    const bank = await call(Txn.PATCH, { method: 'PATCH', params: { id: String(ids.bankLinked) }, body: { amount: 90 } })
    expect(bank.status).toBe(409)
    expect(bank.json.error?.code).toBe('bank_reconciled')
    const bankDesc = await call(Txn.PATCH, { method: 'PATCH', params: { id: String(ids.bankLinked) }, body: { description: 'AEP electric' } })
    expect(bankDesc.status).toBe(200)
  })
  it('refuses edits that touch a closed period', async () => {
    const [row] = await q(`SELECT id FROM transactions WHERE property_id = $1 AND txn_date = '2026-03-10'`, [ids.pA])
    const r = await call(Txn.PATCH, { method: 'PATCH', params: { id: String(row.id) }, body: { description: 'x' } })
    expect(r.status).toBe(409)
  })
  it('confirms a forecast with the cleared amount, once', async () => {
    const r = await call(Confirm.POST, { method: 'POST', params: { id: String(ids.overdue) }, body: { amount: 674.62, txn_date: daysAgo(19) } })
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({ status: 'actual', method: 'confirmed', created_by: 'bot:TestBot' })
    const again = await call(Confirm.POST, { method: 'POST', params: { id: String(ids.overdue) }, body: {} })
    expect(again.status).toBe(409)
  })
  it('deletes forecasts only', async () => {
    const actual = await call(Txn.DELETE, { method: 'DELETE', params: { id: String(ids.actualB) } })
    expect(actual.status).toBe(409)
    expect(actual.json.error?.code).toBe('not_forecast')
    const fc = await call(Txn.DELETE, { method: 'DELETE', params: { id: String(ids.future) } })
    expect(fc.status).toBe(200)
    const [log] = await q(`SELECT before FROM mutations_log WHERE target_id = $1 AND action = 'transaction.delete_forecast'`, [ids.future])
    expect(log.before.amount).toBe(900)
    expect((await call(Txn.GET, { params: { id: String(ids.future) } })).status).toBe(404)
  })
  it('regenerates forecasts from schedules', async () => {
    const r = await call(Regen.POST, { method: 'POST', body: { property_id: ids.pB } })
    expect(r.status).toBe(200)
    expect(r.json.data.forecasts_created).toBeGreaterThanOrEqual(11)
    const n = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE schedule_id = $1 AND status = 'forecast'`, [ids.schedule])
    expect(n[0].n).toBe(r.json.data.forecasts_created)
  })
})

describe('reports', () => {
  it('913 Q1 2026 P&L: deposit excluded, all-in vs operating split', async () => {
    const r = await call(Pnl.GET, { path: `/api/v1/pnl?property_id=${ids.pA}&from=2026-01-01&to=2026-03-31` })
    // income 3 × 1000 (the 2000 deposit excluded); expenses 724.06 tax + 150 repairs
    expect(r.json.data.totals).toEqual({
      income: 3000, expense: 874.06, reserved_expense: 724.06, net_all_in: 2125.94, net_operating: 2850,
    })
  })
  it('default scope is all property books, excluding entity books', async () => {
    const all = await call(Pnl.GET, { path: `/api/v1/pnl?from=2026-01-01&to=${iso(today)}&group_by=property` })
    expect(all.json.data.groups.map((g: any) => g.property)).not.toContain('(entity books)')
    const ent = await call(Pnl.GET, { path: `/api/v1/pnl?entity_id=${ids.slcm}&from=2026-01-01&to=${iso(today)}` })
    expect(ent.json.data.totals.income).toBe(270)
    expect(ent.json.data.totals.expense).toBe(188.83)
  })
  it('form8825 grouping maps taxes', async () => {
    const r = await call(Pnl.GET, { path: `/api/v1/pnl?property_id=${ids.pA}&from=2026-01-01&to=2026-03-31&group_by=form8825` })
    expect(r.json.data.gross_rents).toBe(3000)
    expect(r.json.data.groups.find((g: any) => g.line === 'Taxes').total).toBe(724.06)
  })
  it('quarter and capital engines run against real SQL', async () => {
    const qr = await call(Quarter.GET, { params: { id: String(ids.pA), period: '2026-Q1' } })
    expect(qr.status).toBe(200)
    expect(qr.json.data.is_closed).toBe(true)
    expect(qr.json.data.computation.income).toBe(3000)
    expect(qr.json.data.computation.split).toHaveLength(2)
    const bad = await call(Quarter.GET, { params: { id: String(ids.pA), period: '2026-Q5' } })
    expect(bad.status).toBe(400)
    const cap = await call(Capital.GET, { params: { id: String(ids.pA) } })
    expect(cap.status).toBe(200)
    expect(cap.json.data.owners).toHaveLength(2)
  })
})

describe('maintenance', () => {
  it('attention surfaces the seeded problems', async () => {
    const r = await call(Attention.GET)
    const a = r.json.data
    expect(a.pending_bank.count).toBe(1)
    expect(a.rent_gaps.some((g: any) => g.property === '913' && g.month === ym(monthStart(-1)))).toBe(true)
    expect(a.unclosed_quarters.properties.map((p: any) => p.property)).toContain('913')
    expect(Array.isArray(a.possible_duplicates)).toBe(true)
    expect(a.possible_duplicates.some((d: any) => d.amount === 61.1 && d.property === '913')).toBe(true)
    expect(a.overdue_forecasts.length).toBe(0) // the one overdue item was confirmed above
    expect(a.schedules_without_forecasts.length).toBe(0) // regenerated above
    for (const v of Object.values(a.summary)) expect(typeof v).toBe('number')
  })
  it('pending bank rows carry the rule suggestion', async () => {
    const r = await call(Bank.GET)
    expect(r.json.data.rows.find((x: any) => x.amount === -196.25)).toMatchObject({ direction: 'debit' })
    expect(r.json.data.rows.find((x: any) => x.amount === -196.25).suggestion).toMatchObject({ kind: 'post', target: `property:${ids.pB}`, category: 'Other Expense' })
  })
  it('imports a US Bank CSV, skips rows already imported, and logs it', async () => {
    const csv = [
      '"Date","Transaction","Name","Memo","Amount"',
      `"${daysAgo(2)}","DEBIT","AEP APPALACHIAN POWER","WEB PMT","-91.20"`,
      `"${daysAgo(2)}","DEBIT","CITY OF HUNTINGTON SANITARY","","-7.15"`,
      `"${daysAgo(2)}","DEBIT","CITY OF HUNTINGTON SANITARY","","-7.15"`,
      `"${daysAgo(1)}","CREDIT","ZELLE FROM TENANT","","1350.00"`,
    ].join('\n')
    const a = await call(BankImport.POST, { method: 'POST', body: { account_id: 1, csv } })
    expect(a.status).toBe(201)
    expect(a.json.data).toMatchObject({ rows_in_file: 4, inserted: 4, already_imported: 0 })
    // same file again as raw text/csv: nothing new
    const req = new Request(BASE + '/api/v1/bank/import?account_id=1', {
      method: 'POST', headers: { authorization: `Bearer ${keys.full}`, 'content-type': 'text/csv' }, body: csv,
    })
    const b = await (await BankImport.POST(req)).json()
    expect(b.data).toMatchObject({ inserted: 0, already_imported: 4 })
    const [log] = await q(`SELECT after FROM mutations_log WHERE action = 'bank.import_csv' ORDER BY id LIMIT 1`)
    expect(log.after.new_bank_txn_ids).toHaveLength(4)
    const bad = await call(BankImport.POST, { method: 'POST', body: { csv: 'a,b\n1,2' } })
    expect(bad.json.error?.code).toBe('bad_csv')
    const ro = await call(BankImport.POST, { method: 'POST', key: keys.read, body: { csv } })
    expect(ro.status).toBe(403)
  })
  it('changes feed lists bot writes', async () => {
    const r = await call(Changes.GET, { path: '/api/v1/changes?actor=bot:TestBot&limit=5' })
    expect(r.json.data.changes.length).toBe(5)
    expect(r.json.data.changes[0].before).toBeNull() // detail off
  })
})

describe('bank posting', () => {
  let n = 0
  const bankRow = async (amount: number, date = daysAgo(3), name = 'TEST PAYEE') => {
    n++
    const [r] = await q(`INSERT INTO bank_txns (account_id, txn_date, amount, name_raw, name_norm, import_hash)
                         VALUES (1, $1, $2, $3, $3, $4) RETURNING id`, [date, amount, name, `t-${n}-${Date.now()}`])
    return String(r.id)
  }
  const post = (id: string, body: unknown, key?: string) => call(BankPost.POST, { method: 'POST', params: { id }, body, key })

  it('the race guard aborts on a row that is no longer pending', async () => {
    const id = await bankRow(-1.23)
    const guard = `SELECT 1 / (CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS ok FROM bank_txns WHERE id = $1`
    expect((await q(guard, [id]))[0].ok).toBe(1)
    await q(`UPDATE bank_txns SET status = 'posted' WHERE id = $1`, [id])
    await expect(q(guard, [id])).rejects.toThrow(/division by zero/)
  })
  it('posts a single leg for the full amount, atomically logged', async () => {
    const id = await bankRow(-91.2, daysAgo(3), 'AEP')
    const r = await post(id, { legs: [{ property_id: ids.pB, category: 'Utilities' }] })
    expect(r.status).toBe(200)
    expect(r.json.data.bank_txn.status).toBe('posted')
    expect(r.json.data.legs).toHaveLength(1)
    expect(r.json.data.legs[0]).toMatchObject({ link_type: 'created', amount: 91.2, category: 'Utilities', type: 'expense', books: 'Belford' })
    const [t] = await q('SELECT method, created_by, description FROM transactions WHERE id = $1', [r.json.data.legs[0].transaction_id])
    expect(t).toEqual({ method: 'import', created_by: 'bot:TestBot', description: 'AEP' })
    const [log] = await q(`SELECT after FROM mutations_log WHERE action = 'bank.post' AND target_id = $1`, [Number(id)])
    expect(log.after.legs).toHaveLength(1)
    const again = await post(id, { legs: [{ property_id: ids.pB, category: 'Utilities' }] })
    expect(again.status).toBe(409)
    expect(again.json.error?.code).toBe('already_resolved')
  })
  it('splits a credit across properties and requires legs to add up', async () => {
    const id = await bankRow(1350, daysAgo(4), 'ZELLE SPLIT')
    const bad = await post(id, { legs: [{ property_id: ids.pA, category: 'Rental Income', amount: 1000 }, { property_id: ids.pB, category: 'Rental Income', amount: 300 }] })
    expect(bad.status).toBe(400)
    const noAmt = await post(id, { legs: [{ property_id: ids.pA, category: 'Rental Income' }, { property_id: ids.pB, category: 'Rental Income' }] })
    expect(noAmt.status).toBe(400)
    const r = await post(id, {
      legs: [
        { property_id: ids.pA, unit_id: ids.unitA, category: 'Rental Income', amount: 1000, rental_period: ym(monthStart(0)) },
        { property_id: ids.pB, category: 'Rental Income', amount: 350 },
      ],
    })
    expect(r.status).toBe(200)
    expect(r.json.data.legs.map((l: any) => l.amount).sort()).toEqual([1000, 350].sort())
    expect(r.json.data.legs.find((l: any) => l.amount === 1000).rental_period).toBe(ym(monthStart(0)))
  })
  it('refuses a category that fights the bank direction, and deposits on debits', async () => {
    const id = await bankRow(-50)
    const r = await post(id, { legs: [{ property_id: ids.pB, category: 'Rental Income' }] })
    expect(r.status).toBe(400)
    const d = await post(id, { legs: [{ property_id: ids.pB, is_deposit: true }] })
    expect(d.status).toBe(400)
    const cred = await bankRow(25)
    const refund = await post(cred, { legs: [{ property_id: ids.pB, category: 'Utilities' }] })
    expect(refund.json.error?.message).toMatch(/Other Income/)
  })
  it('posts a security deposit the UI way (excluded from P&L)', async () => {
    const id = await bankRow(900, daysAgo(2), 'NEW TENANT')
    const r = await post(id, { legs: [{ property_id: ids.pB, is_deposit: true }] })
    expect(r.json.data.legs[0]).toMatchObject({ is_deposit: true, category: 'Rental Income' })
  })
  it('refuses a closed period', async () => {
    const id = await bankRow(-40, '2026-02-15')
    const r = await post(id, { legs: [{ property_id: ids.pA, category: 'Utilities' }] })
    expect(r.status).toBe(409)
    expect(r.json.error?.code).toBe('period_closed')
  })
  it('splits a loan payment into deductible interest and Loan Principal', async () => {
    const id = await bankRow(-196.25, daysAgo(2), 'LIGHTSTREAM')
    const r = await post(id, { legs: [
      { property_id: ids.pB, category: 'Mortgage Interest', amount: 10.19 },
      { property_id: ids.pB, category: 'Loan Principal', amount: 186.06 },
    ] })
    expect(r.status).toBe(200)
    expect(r.json.data.legs.map((l: any) => l.category).sort()).toEqual(['Loan Principal', 'Mortgage Interest'])
    const p = await call(Pnl.GET, { path: `/api/v1/pnl?property_id=${ids.pB}&from=${daysAgo(3)}&to=${daysAgo(1)}&group_by=form8825` })
    const nd = p.json.data.groups.find((g: any) => String(g.line).startsWith('(not deductible'))
    expect(nd.categories).toContain('Loan Principal')
  })
  it('posts to entity books', async () => {
    const id = await bankRow(-47.7, daysAgo(2), 'ADOBE')
    const r = await post(id, { legs: [{ entity_id: ids.slcm, category: 'Payroll' }] })
    expect(r.json.data.legs[0].books).toBe('Second Line Capital Management LLC')
  })
  it('lists candidates and matches a scheduled item at the cleared amount', async () => {
    const [f] = await q(`INSERT INTO transactions (property_id, type, category, amount, txn_date, status, schedule_id, method)
                         VALUES ($1, 'expense', 'Insurance', 7.15, $2, 'forecast', $3, 'scheduled') RETURNING id`, [ids.pB, daysAgo(6), ids.schedule])
    const id = await bankRow(-7.15, daysAgo(4), 'SANITARY')
    const list = await call(Bank.GET)
    const row = list.json.data.rows.find((x: any) => String(x.id) === id)
    expect(row.candidates.map((c: any) => c.id)).toContain(f.id)
    // bank cleared at the forecast amount; also prove amount adoption with a second one
    const r = await call(BankMatch.POST, { method: 'POST', params: { id }, body: { transaction_id: f.id } })
    expect(r.status).toBe(200)
    expect(r.json.data.bank_txn.status).toBe('linked')
    expect(r.json.data.legs[0]).toMatchObject({ link_type: 'confirmed', status: 'actual' })
    const [g] = await q(`INSERT INTO transactions (property_id, type, category, amount, txn_date, status, schedule_id, method)
                         VALUES ($1, 'expense', 'Insurance', 50, $2, 'forecast', $3, 'scheduled') RETURNING id`, [ids.pB, daysAgo(9), ids.schedule])
    const id2 = await bankRow(-52.5, daysAgo(8), 'INSURER')
    const r2 = await call(BankMatch.POST, { method: 'POST', params: { id: id2 }, body: { transaction_id: g.id } })
    expect(r2.json.data.note).toMatch(/booked at 52.50/)
    const [gt] = await q('SELECT amount::float8 AS amount, txn_date::text AS d, status FROM transactions WHERE id = $1', [g.id])
    expect(gt).toEqual({ amount: 52.5, d: daysAgo(8), status: 'actual' })
    ids.matchedForecast = g.id
    ids.matchedBank = Number(id2)
  })
  it('links existing actuals only when they add up', async () => {
    const [a] = await q(`INSERT INTO transactions (property_id, type, category, amount, txn_date, status) VALUES ($1,'expense','Utilities',30,$2,'actual') RETURNING id`, [ids.pB, daysAgo(5)])
    const [b] = await q(`INSERT INTO transactions (property_id, type, category, amount, txn_date, status) VALUES ($1,'expense','Utilities',20,$2,'actual') RETURNING id`, [ids.pB, daysAgo(5)])
    const id = await bankRow(-50)
    const bad = await call(BankMatch.POST, { method: 'POST', params: { id }, body: { transaction_ids: [a.id] } })
    expect(bad.status).toBe(400)
    const ok = await call(BankMatch.POST, { method: 'POST', params: { id }, body: { transaction_ids: [a.id, b.id] } })
    expect(ok.json.data.legs).toHaveLength(2)
    const id2 = await bankRow(-30)
    const dup = await call(BankMatch.POST, { method: 'POST', params: { id: id2 }, body: { transaction_id: a.id } })
    expect(dup.json.error?.code).toBe('already_linked')
  })
  it('excludes with a reason', async () => {
    const id = await bankRow(-500, daysAgo(2), 'TRANSFER TO 3529')
    expect((await call(BankExclude.POST, { method: 'POST', params: { id }, body: {} })).status).toBe(400)
    const r = await call(BankExclude.POST, { method: 'POST', params: { id }, body: { reason: 'transfer between own accounts' } })
    expect(r.json.data.bank_txn).toMatchObject({ status: 'excluded', exclude_reason: 'transfer between own accounts' })
    const back = await call(BankRevert.POST, { method: 'POST', params: { id } })
    expect(back.json.data.bank_txn.status).toBe('pending')
  })
  it('revert undoes a post (rows removed) and a forecast match (back to scheduled)', async () => {
    const id = await bankRow(-61.25, daysAgo(2), 'TO UNDO')
    const p = await post(id, { legs: [{ property_id: ids.pB, category: 'Utilities' }] })
    const created = p.json.data.legs[0].transaction_id
    const r = await call(BankRevert.POST, { method: 'POST', params: { id } })
    expect(r.json.data).toMatchObject({ bank_txn: { status: 'pending' }, legs: [] })
    expect(await q('SELECT 1 FROM transactions WHERE id = $1', [created])).toHaveLength(0)
    const r2 = await call(BankRevert.POST, { method: 'POST', params: { id: String(ids.matchedBank) } })
    expect(r2.status).toBe(200)
    const [f] = await q('SELECT status FROM transactions WHERE id = $1', [ids.matchedForecast])
    expect(f.status).toBe('forecast')
    const [log] = await q(`SELECT before FROM mutations_log WHERE action = 'bank.revert' AND target_id = $1`, [ids.matchedBank])
    expect(log.before.legs[0].link_type).toBe('confirmed')
    expect((await call(BankRevert.POST, { method: 'POST', params: { id } })).json.error?.code).toBe('not_resolved')
  })
  it('read key cannot post; MCP lists the bank tools', async () => {
    const id = await bankRow(-5)
    expect((await post(id, { legs: [{ property_id: ids.pB, category: 'Utilities' }] }, keys.read)).status).toBe(403)
    const list = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = list.json.result.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['post_bank_txn', 'match_bank_txn', 'exclude_bank_txn', 'revert_bank_txn']))
    const viaMcp = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'post_bank_txn', arguments: { bank_txn_id: Number(id), legs: [{ property_id: ids.pB, category: 'Utilities' }] } } })
    expect(viaMcp.json.result.isError).toBe(false)
  })
})

describe('schedules and late rent', () => {
  const futureCount = async (sid: number) =>
    (await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE schedule_id = $1 AND status = 'forecast' AND txn_date >= date_trunc('month', CURRENT_DATE)`, [sid]))[0].n
  it('lists schedules with next due and overdue counts', async () => {
    const r = await call(Scheds.GET, { path: `/api/v1/schedules?property_id=${ids.pB}` })
    const s = r.json.data.find((x: any) => x.id === ids.schedule)
    expect(s).toMatchObject({ books: 'Belford', category: 'Insurance', amount: 50, status: 'active' })
  })
  it('editing a schedule rebuilds only its future forecasts', async () => {
    const before = await futureCount(ids.schedule)
    expect(before).toBeGreaterThan(0)
    const r = await call(Sched.PATCH, { method: 'PATCH', params: { id: String(ids.schedule) }, body: { amount: 55.5, months_csv: '1,4,7,10' } })
    expect(r.status).toBe(200)
    expect(r.json.data.schedule.amount).toBe(55.5)
    const amts = await q(`SELECT DISTINCT amount::float8 AS a, EXTRACT(MONTH FROM txn_date)::int AS m FROM transactions WHERE schedule_id = $1 AND status = 'forecast' AND txn_date >= date_trunc('month', CURRENT_DATE)`, [ids.schedule])
    expect(amts.every((x: any) => x.a === 55.5 && [1, 4, 7, 10].includes(x.m))).toBe(true)
    const [log] = await q(`SELECT before, after FROM mutations_log WHERE action = 'schedule.update' AND target_id = $1`, [ids.schedule])
    expect(log.before.amount).toBe(50)
  })
  it('pausing removes future forecasts; resuming restores them', async () => {
    await call(Sched.PATCH, { method: 'PATCH', params: { id: String(ids.schedule) }, body: { status: 'paused' } })
    expect(await futureCount(ids.schedule)).toBe(0)
    await call(Sched.PATCH, { method: 'PATCH', params: { id: String(ids.schedule) }, body: { status: 'active', months_csv: null } })
    expect(await futureCount(ids.schedule)).toBeGreaterThanOrEqual(11)
  })
  it('validates schedule edits', async () => {
    expect((await call(Sched.PATCH, { method: 'PATCH', params: { id: String(ids.schedule) }, body: { type: 'income' } })).status).toBe(400)
    expect((await call(Sched.PATCH, { method: 'PATCH', params: { id: String(ids.schedule) }, body: { category: 'Rental Income' } })).status).toBe(400)
    expect((await call(Sched.PATCH, { method: 'PATCH', params: { id: String(ids.schedule) }, body: { months_csv: '13' } })).status).toBe(400)
    expect((await call(Sched.PATCH, { method: 'PATCH', params: { id: '99999' }, body: { amount: 1 } })).status).toBe(404)
  })
  it('late rent: an unpaid unit rent 7+ days old is flagged with tenant and total; unscheduled renters are listed', async () => {
    await q(`UPDATE units SET current_tenant = 'Tim Test' WHERE id = $1`, [ids.unitA])
    const r = await call(Scheds.POST, { method: 'POST', body: { property_id: ids.pA, unit_id: ids.unitA, category: 'Rental Income', amount: 750, day_of_month: 1 } })
    expect(r.status).toBe(201)
    expect(r.json.data.forecasts.created).toBeGreaterThanOrEqual(11)
    // two months unpaid
    for (const d of [daysAgo(40), daysAgo(10)]) {
      await q(`INSERT INTO transactions (property_id, unit_id, type, category, amount, txn_date, status, schedule_id, method)
               VALUES ($1, $2, 'income', 'Rental Income', 750, $3, 'forecast', $4, 'scheduled')`, [ids.pA, ids.unitA, d, r.json.data.schedule.id])
    }
    const a = (await call(Attention.GET)).json.data
    const late = a.late_rent.find((u: any) => u.unit_id === ids.unitA)
    // the two inserted months plus this month's (generated, due the 1st) when that is 7+ days ago
    const expected = 1500 + (new Date().getUTCDate() >= 8 ? 750 : 0)
    expect(late).toMatchObject({ property: '913', tenant: 'Tim Test', total_owed: expected })
    expect(late.months.length).toBe(expected / 750)
    expect(late.oldest_days_late).toBe(40)
    expect(a.summary.late_rent_total).toBeGreaterThanOrEqual(1500)
    // Belford collects rent (seeded actuals) with no rent schedule → listed
    expect(a.rent_without_schedule.map((x: any) => x.property)).toContain('Belford')
  })
  it('duplicate check ignores different units and rows backed by different bank lines', async () => {
    const [u2] = await q(`INSERT INTO units (property_id, label) VALUES ($1, 'Unit 2') RETURNING id`, [ids.pA])
    await q(`INSERT INTO transactions (property_id, unit_id, type, category, amount, txn_date, status) VALUES
             ($1, $2, 'income', 'Rental Income', 812.34, $4, 'actual'), ($1, $3, 'income', 'Rental Income', 812.34, $4, 'actual')`,
      [ids.pA, ids.unitA, u2.id, daysAgo(2)])
    const a = (await call(Attention.GET)).json.data
    expect(a.possible_duplicates.some((d: any) => d.amount === 812.34)).toBe(false)
    expect(a.possible_duplicates.some((d: any) => d.amount === 61.1)).toBe(true)
  })
})

describe('distributions and closing', () => {
  // The last fully finished quarter, relative to today.
  const q0 = Math.floor(today.getUTCMonth() / 3) + 1
  const lastQ = q0 === 1 ? { y: today.getUTCFullYear() - 1, q: 4 } : { y: today.getUTCFullYear(), q: q0 - 1 }
  const period = `${lastQ.y}-Q${lastQ.q}`
  const qStart = new Date(Date.UTC(lastQ.y, (lastQ.q - 1) * 3, 1))
  const inQ = (day: number) => iso(new Date(qStart.getTime() + day * 86400000))
  const pid = () => String(ids.pB)
  const dist = (body: unknown, key?: string) => call(Dist.POST, { method: 'POST', params: { id: pid(), period }, body, key })

  it('records $0 freely, split per owner, logged', async () => {
    const r = await dist({ amount: 0 })
    expect(r.status).toBe(200)
    expect(r.json.data.split.every((x: any) => x.amount === 0)).toBe(true)
    const rows = await q(`SELECT amount::float8 AS a FROM distributions WHERE property_id = $1 AND period = $2`, [ids.pB, period])
    expect(rows.length).toBeGreaterThan(0)
    expect((await q(`SELECT 1 FROM mutations_log WHERE action = 'distribution.record' AND target_id = $1`, [ids.pB])).length).toBe(1)
  })
  it('a positive payout needs confirm_payout, then the lifetime guard', async () => {
    const r = await dist({ amount: 10 })
    expect(r.status).toBe(409)
    expect(r.json.error?.code).toBe('needs_confirmation')
    const over = await dist({ amount: 10_000_000 - 1, confirm_payout: true })
    expect(over.json.error?.code).toBe('over_distribution')
  })
  it('splits to the exact cent', async () => {
    // pA is 50/50
    const r = await call(Dist.POST, { method: 'POST', params: { id: String(ids.pA), period }, body: { amount: 100.01, confirm_payout: true, allow_over: true } })
    expect(r.status).toBe(200)
    const amts = r.json.data.split.map((x: any) => x.amount)
    expect(Math.round(amts.reduce((a: number, b: number) => a + b, 0) * 100)).toBe(10001)
    await call(Dist.POST, { method: 'POST', params: { id: String(ids.pA), period }, body: { amount: 0 } })
  })
  it('close keeps unpaid rent as arrears, removes other leftovers, then locks', async () => {
    const [rent] = await q(`INSERT INTO transactions (property_id, type, category, amount, txn_date, status, method) VALUES ($1,'income','Rental Income',1350,$2,'forecast','scheduled') RETURNING id`, [ids.pB, inQ(20)])
    const [fee] = await q(`INSERT INTO transactions (property_id, type, category, amount, txn_date, status, method) VALUES ($1,'expense','Utilities',7.15,$2,'forecast','scheduled') RETURNING id`, [ids.pB, inQ(25)])
    const r = await call(Close.POST, { method: 'POST', params: { id: pid(), period } })
    expect(r.status).toBe(200)
    expect(r.json.data.kept_unpaid_rent.map((x: any) => x.id)).toContain(rent.id)
    expect(r.json.data.removed_forecasts.map((x: any) => x.id)).toContain(fee.id)
    expect(r.json.data.distribution_recorded).toBe(0)
    expect(await q('SELECT 1 FROM transactions WHERE id = $1', [fee.id])).toHaveLength(0)
    expect(await q('SELECT 1 FROM transactions WHERE id = $1', [rent.id])).toHaveLength(1)
    // locked: no posting, no distribution change, no second close
    const post = await call(Txns.POST, { method: 'POST', body: { property_id: ids.pB, category: 'Utilities', amount: 3, txn_date: inQ(30) } })
    expect(post.json.error?.code).toBe('period_closed')
    expect((await dist({ amount: 0 })).json.error?.code).toBe('period_closed')
    expect((await call(Close.POST, { method: 'POST', params: { id: pid(), period } })).json.error?.code).toBe('already_closed')
    const [log] = await q(`SELECT after FROM mutations_log WHERE action = 'period.close' AND target_id = $1`, [ids.pB])
    expect(log.after.kept_unpaid_rent).toHaveLength(1)
  })
  it('reopen unlocks; closing an unfinished quarter is refused', async () => {
    const r = await call(Reopen.POST, { method: 'POST', params: { id: pid(), period } })
    expect(r.json.data.closed).toBe(false)
    expect((await call(Reopen.POST, { method: 'POST', params: { id: pid(), period } })).json.error?.code).toBe('not_closed')
    const cur = `${today.getUTCFullYear()}-Q${q0}`
    expect((await call(Close.POST, { method: 'POST', params: { id: pid(), period: cur } })).status).toBe(400)
  })
  it('read key cannot record or close', async () => {
    expect((await dist({ amount: 0 }, keys.read)).status).toBe(403)
  })
})

describe('read-only SQL', () => {
  it('schema hides api_keys and includes conventions', async () => {
    const r = await call(Schema.GET)
    expect(r.json.data.tables).not.toHaveProperty('api_keys')
    expect(r.json.data.tables.transactions.columns.map((c: any) => c.name)).toContain('is_deposit')
    expect(r.json.data.conventions.join(' ')).toMatch(/is_deposit/)
  })
  it('runs SELECTs with params and normalises dates', async () => {
    const r = await call(Query.POST, {
      method: 'POST',
      body: { sql: `SELECT id, txn_date, amount::float8 AS amount FROM transactions WHERE property_id = $1 AND status = 'actual' ORDER BY txn_date LIMIT 2;`, params: [ids.pA] },
    })
    expect(r.status).toBe(200)
    expect(r.json.data.rows[0].txn_date).toBe('2026-01-05')
    expect(r.json.data.columns).toEqual(['id', 'txn_date', 'amount'])
  })
  it('truncates at max_rows', async () => {
    const r = await call(Query.POST, { method: 'POST', body: { sql: 'SELECT generate_series(1, 50) AS n', max_rows: 10 } })
    expect(r.json.data.rows).toHaveLength(10)
    expect(r.json.data.truncated).toBe(true)
  })
  it('rejects writes at the lexical gate', async () => {
    for (const s of [
      'DELETE FROM transactions',
      "UPDATE transactions SET amount = 0",
      'WITH x AS (DELETE FROM transactions RETURNING *) SELECT * FROM x',
      'SELECT 1; DROP TABLE transactions',
      'SELECT * FROM transactions FOR UPDATE',
      "SELECT set_config('default_transaction_read_only','off',false)",
      'EXPLAIN ANALYZE DELETE FROM transactions',
    ]) {
      const r = await call(Query.POST, { method: 'POST', body: { sql: s } })
      expect(r.status, s).toBe(400)
    }
    const n = await q('SELECT COUNT(*)::int AS n FROM transactions')
    expect(n[0].n).toBeGreaterThan(10)
  })
  it('allows keywords inside strings and comments', async () => {
    const r = await call(Query.POST, { method: 'POST', body: { sql: "SELECT 'please DELETE me' AS s -- UPDATE in a comment" } })
    expect(r.status).toBe(200)
    expect(r.json.data.rows[0].s).toBe('please DELETE me')
  })
  it('layer 2: even a write that slipped past the gate dies in the READ ONLY transaction', async () => {
    const { neon } = await import('./pg-neon')
    const db = neon(OWNER_URL)
    await expect(
      db.transaction((tx: any) => [tx.query("INSERT INTO categories (name, kind) VALUES ('x','expense')")], { readOnly: true }),
    ).rejects.toThrow(/read-only transaction/)
  })
  it('layer 3: the dyer_bot_ro role can read but not write, and cannot see api_keys', async () => {
    const ro = new pg.Pool({ connectionString: RO_URL })
    try {
      const r = await ro.query('SELECT COUNT(*)::int AS n FROM transactions')
      expect(r.rows[0].n).toBeGreaterThan(0)
      await expect(ro.query("INSERT INTO categories (name, kind) VALUES ('y','expense')")).rejects.toThrow(/read-only transaction|permission denied/)
      await expect(ro.query('BEGIN READ WRITE; INSERT INTO categories (name, kind) VALUES (\'y\',\'expense\'); COMMIT')).rejects.toThrow(/permission denied/)
      await expect(ro.query('SELECT * FROM api_keys')).rejects.toThrow(/permission denied/)
      const st = await ro.query('SHOW statement_timeout')
      expect(st.rows[0].statement_timeout).toBe('15s')
    } finally {
      await ro.query('ROLLBACK').catch(() => {})
      await ro.end()
    }
  })
  it('the endpoint uses the read-only role when DATABASE_URL_READONLY is set', async () => {
    process.env.DATABASE_URL_READONLY = RO_URL
    try {
      const ok = await call(Query.POST, { method: 'POST', body: { sql: 'SELECT current_user AS u' } })
      expect(ok.json.data.rows[0].u).toBe('dyer_bot_ro')
      expect(ok.json.data.read_only_role).toBe(true)
      const denied = await call(Query.POST, { method: 'POST', body: { sql: 'SELECT key_hash FROM api_keys' } })
      expect(denied.status).toBe(400)
      expect(denied.json.error?.code).toBe('sql_error')
    } finally {
      delete process.env.DATABASE_URL_READONLY
    }
  })
})

describe('MCP', () => {
  it('handshake: initialize, initialized notification, ping', async () => {
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor', version: '1' } } })
    expect(init.status).toBe(200)
    expect(init.json.result.protocolVersion).toBe('2025-06-18')
    expect(init.json.result.capabilities.tools).toBeDefined()
    expect(init.json.result.serverInfo.name).toBe('dyerempire')
    const note = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(note.status).toBe(202)
    const ping = await mcp({ jsonrpc: '2.0', id: 2, method: 'ping' })
    expect(ping.json.result).toEqual({})
  })
  it('unknown protocol versions fall back to a supported one', async () => {
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    expect(init.json.result.protocolVersion).toBe('2025-06-18')
  })
  it('tools/list is filtered by scope', async () => {
    const full = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    const names = full.json.result.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['get_attention', 'create_transaction', 'run_sql']))
    const read = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, keys.read)
    const rnames = read.json.result.tools.map((t: any) => t.name)
    expect(rnames).not.toContain('create_transaction')
    expect(rnames).not.toContain('run_sql')
    for (const t of full.json.result.tools) expect(t.inputSchema.type).toBe('object')
  })
  it('tools/call returns JSON text, and errors come back as isError results', async () => {
    const ok = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_pnl', arguments: { property_id: ids.pA, from: '2026-01-01', to: '2026-03-31' } } })
    expect(ok.json.result.isError).toBe(false)
    expect(JSON.parse(ok.json.result.content[0].text).totals.net_all_in).toBe(2125.94)
    const bad = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_transaction', arguments: { property_id: ids.pA, category: 'Utilities', amount: 5, txn_date: '2026-02-02' } } })
    expect(bad.json.result.isError).toBe(true)
    expect(JSON.parse(bad.json.result.content[0].text).error).toBe('period_closed')
  })
  it('MCP writes are logged with source=mcp', async () => {
    const r = await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_transaction', arguments: { property_id: ids.pB, category: 'Other Income', amount: 12.34, txn_date: daysAgo(1), idempotency_key: 'mcp-1' } } })
    const t = JSON.parse(r.json.result.content[0].text)
    const [log] = await q(`SELECT source, actor FROM mutations_log WHERE target_id = $1`, [t.id])
    expect(log).toEqual({ source: 'mcp', actor: 'bot:TestBot' })
  })
  it('a read key cannot call write tools even by name', async () => {
    const r = await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delete_forecast', arguments: { id: 1 } } }, keys.read)
    expect(r.json.error.code).toBe(-32602)
  })
  it('auth, parse errors, unknown methods, GET', async () => {
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status).toBe(401)
    const unk = await mcp({ jsonrpc: '2.0', id: 8, method: 'sampling/createMessage' })
    expect(unk.json.error.code).toBe(-32601)
    const res = await Mcp.POST(new Request(BASE + '/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${keys.full}` }, body: '{nope' }))
    expect(res.status).toBe(400)
    expect((await Mcp.GET()).status).toBe(405)
  })
})
