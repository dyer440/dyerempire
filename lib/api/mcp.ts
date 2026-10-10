// lib/api/mcp.ts
// A small, dependency-free Model Context Protocol server over Streamable HTTP,
// stateless, JSON responses only (no SSE). That is all GrokBot (xAI remote MCP)
// and Cursor need: initialize → tools/list → tools/call. Auth is the same
// bearer API key as REST; the tool list is filtered to the key's scopes.
import type { BotPrincipal } from './keys'
import { ApiError } from './errors'
import { toolsFor } from './tools'

export const SERVER_INFO = { name: 'dyerempire', title: 'DyerEmpire books', version: '1.0.0' }
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_VERSION = '2025-06-18'

const INSTRUCTIONS =
  'DyerEmpire is the accounting system for six rental properties and their holding entities. ' +
  'For maintenance, call get_attention first. For questions, prefer the typed tools (get_pnl, list_transactions); ' +
  'use describe_schema then run_sql for anything else. Amounts are positive with type income/expense; P&L counts ' +
  'actual rows only and excludes security deposits. Writes respect closed periods and are logged. Never guess a ' +
  'category: use list_categories. When a bill or rent clears that was scheduled, use confirm_forecast rather than ' +
  'create_transaction.'

type JsonRpcId = string | number | null
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> }
type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } }

const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse =>
  ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })

async function handleOne(msg: JsonRpcRequest, principal: BotPrincipal): Promise<JsonRpcResponse | null> {
  const isNotification = msg.id === undefined
  const id: JsonRpcId = msg.id ?? null
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isNotification ? null : rpcError(id, -32600, 'Invalid Request')
  }
  if (isNotification) return null // notifications/initialized, notifications/cancelled, ...

  const who = { actor: principal.actor, keyId: principal.keyId, source: 'mcp' as const }

  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '')
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : DEFAULT_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }

    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: {
          tools: toolsFor(principal.scopes).map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, ...t.annotations },
          })),
        },
      }

    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const tool = toolsFor(principal.scopes).find((t) => t.name === name)
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool or not permitted for this key: ${name}`)
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return rpcError(id, -32602, 'arguments must be an object')
      }
      try {
        const data = await tool.run(args, who)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], isError: false } }
      } catch (e) {
        // Tool failures go back to the model as a result it can read and correct.
        const body = e instanceof ApiError
          ? { error: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) }
          : { error: 'internal_error', message: 'Server error; it has been logged.' }
        if (!(e instanceof ApiError)) console.error('[mcp] tool error', name, e)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true } }
      }
    }

    // Capabilities we don't offer: answer politely so clients don't stall.
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } }
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } }
    case 'logging/setLevel':
      return { jsonrpc: '2.0', id, result: {} }

    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`)
  }
}

/** Handles a single JSON-RPC message or a batch (older clients). Returns null when nothing to send (202). */
export async function handleMcpPayload(payload: unknown, principal: BotPrincipal): Promise<unknown | null> {
  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map((m) => handleOne(m as JsonRpcRequest, principal)))).filter(Boolean)
    return out.length ? out : null
  }
  return handleOne(payload as JsonRpcRequest, principal)
}
