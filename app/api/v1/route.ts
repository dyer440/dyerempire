// app/api/v1/route.ts
// Bot API index: who am I, and what can I call. Requires any valid key.
import { route } from '@/lib/api/http'
import { toolsFor } from '@/lib/api/tools'

const ENDPOINTS = [
  ['GET', '/api/v1/attention', 'read', 'Maintenance checklist (start here)'],
  ['GET', '/api/v1/properties', 'read', 'Properties, owners, units'],
  ['GET', '/api/v1/properties/{id}/quarters/{period}', 'read', 'Quarter close computation, e.g. 2026-Q3'],
  ['GET', '/api/v1/properties/{id}/capital', 'read', 'Partner capital accounts'],
  ['GET', '/api/v1/entities', 'read', 'Entities'],
  ['GET', '/api/v1/categories', 'read', 'Valid categories'],
  ['GET', '/api/v1/transactions', 'read', 'Search ledger (property_id, entity_id, status, type, category, from, to, q, limit, offset)'],
  ['GET', '/api/v1/transactions/{id}', 'read', 'One transaction with change history'],
  ['GET', '/api/v1/pnl', 'read', 'P&L (property_id | entity_id, from, to, group_by)'],
  ['GET', '/api/v1/bank/pending', 'read', 'Unposted bank rows with rule suggestions'],
  ['GET', '/api/v1/changes', 'read', 'Audit log of bot writes'],
  ['POST', '/api/v1/transactions', 'write', 'Record an actual (Idempotency-Key header recommended)'],
  ['PATCH', '/api/v1/transactions/{id}', 'write', 'Edit category/amount/date/description/rental_period/unit_id'],
  ['POST', '/api/v1/transactions/{id}/confirm', 'write', 'Confirm a scheduled item as actual'],
  ['DELETE', '/api/v1/transactions/{id}', 'write', 'Delete a scheduled item (forecasts only)'],
  ['POST', '/api/v1/bank/import', 'write', 'Upload a US Bank CSV into the import queue (JSON {account_id, csv} or text/csv)'],
  ['POST', '/api/v1/bank/{id}/post', 'write', 'Post a bank row: { legs: [{ property_id | entity_id, category, amount? }], rule_id? }'],
  ['POST', '/api/v1/bank/{id}/match', 'write', 'Match a bank row: { transaction_id } or { transaction_ids }'],
  ['POST', '/api/v1/bank/{id}/exclude', 'write', 'Exclude a bank row: { reason }'],
  ['POST', '/api/v1/bank/{id}/revert', 'write', 'Undo a posting, match or exclusion'],
  ['GET', '/api/v1/schedules', 'read', 'Recurring schedules (property_id, entity_id, status)'],
  ['POST', '/api/v1/schedules', 'write', 'Create a schedule'],
  ['PATCH', '/api/v1/schedules/{id}', 'write', 'Edit or pause a schedule; its future forecasts are rebuilt'],
  ['POST', '/api/v1/forecasts/regenerate', 'write', 'Rebuild forecasts for property_id or entity_id'],
  ['GET', '/api/v1/schema', 'sql', 'Tables, columns and accounting conventions'],
  ['POST', '/api/v1/query', 'sql', 'Read-only SQL: { sql, params?, max_rows? }'],
  ['POST', '/api/mcp', 'any', 'MCP endpoint (Streamable HTTP) for GrokBot, Cursor, Claude'],
].map(([method, path, scope, description]) => ({ method, path, scope, description }))

export const GET = route('read', async ({ principal }) => ({
  bot: principal.name,
  scopes: principal.scopes,
  endpoints: ENDPOINTS.filter((e) => e.scope === 'any' || principal.scopes.includes(e.scope as 'read')),
  mcp_tools: toolsFor(principal.scopes).map((t) => t.name),
}))
