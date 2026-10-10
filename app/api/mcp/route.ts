// app/api/mcp/route.ts
// MCP endpoint (Streamable HTTP, stateless, JSON responses).
//   Cursor:  .cursor/mcp.json → { "url": "https://www.dyerempire.com/api/mcp",
//                                 "headers": { "Authorization": "Bearer de_..." } }
//   Grok:    remote MCP tool with server_url https://www.dyerempire.com/api/mcp and
//            authorization "Bearer de_..." (see docs/bot-api.md).
import { authenticate } from '@/lib/api/keys'
import { handleMcpPayload } from '@/lib/api/mcp'

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

export async function POST(req: Request): Promise<Response> {
  const principal = await authenticate(req)
  if (!principal) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing or invalid API key' } }),
      { status: 401, headers: { ...JSON_HEADERS, 'WWW-Authenticate': 'Bearer realm="dyerempire"' } },
    )
  }
  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      { status: 400, headers: JSON_HEADERS },
    )
  }
  const result = await handleMcpPayload(payload, principal)
  if (result === null) return new Response(null, { status: 202 })
  return new Response(JSON.stringify(result), { status: 200, headers: JSON_HEADERS })
}

// No server-initiated stream and no sessions: tell clients plainly.
export async function GET(): Promise<Response> {
  return new Response('This MCP server does not offer an SSE stream. Use POST.', {
    status: 405, headers: { Allow: 'POST' },
  })
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } })
}
