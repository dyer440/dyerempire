# DyerEmpire Bot API (v1)

The website and Neon stay the system of record. Bots read and write through one API with two front doors:

- **REST** at `https://www.dyerempire.com/api/v1/...` for scripts, n8n-style workflows, or anything that speaks HTTP.
- **MCP** at `https://www.dyerempire.com/api/mcp` for AI clients. GrokBot and Cursor both connect here and see the API as a set of tools.

Both doors share one service layer (`lib/api/`), so the same rules apply however a bot connects.

**Use `https://www.dyerempire.com`.** The bare domain redirects to `www`, and some clients drop the request body (the CSV upload, MCP calls) when they follow a redirect.

## Install, in order

Each step can be deployed and checked on its own.

1. **Neon.** Run `migrations/2026-10_bot_api.sql` in the SQL editor. It creates `api_keys` and `mutations_log`. It is idempotent.
2. **Code.** Commit and push. Vercel deploys. Check that `curl https://www.dyerempire.com/api/v1` returns `401` with a JSON body (not a redirect to sign-in). The rest of the site is unchanged and still behind Clerk.
3. **Keys.** Open `/admin`, scroll to **Bot API**, and create one key per bot (for example `GrokBot` and `Cursor`). The key is shown once. Store it in your password manager.
4. **Read-only database role (recommended).** Edit the password placeholder in `migrations/2026-10_bot_readonly_role.sql`, run it, then add `DATABASE_URL_READONLY` in Vercel and redeploy. This makes ad-hoc bot SQL physically unable to write.
5. **Connect the bots** (below).

## Scopes

| Scope | Grants |
|---|---|
| `read` | All lookups, P&L, quarter and capital engines, maintenance checklist, audit log |
| `write` | Record, edit, and confirm transactions, delete scheduled items, regenerate forecasts |
| `sql` | `describe_schema` and read-only SQL |

Give each bot only what it needs. A key can be revoked from `/admin` instantly, and can be set to expire.

## Connecting Cursor

Put this in your global `~/.cursor/mcp.json` so the key never sits in the repo. (A project-level `.cursor/mcp.json` also works and is now gitignored.)

```json
{
  "mcpServers": {
    "dyerempire": {
      "url": "https://www.dyerempire.com/api/mcp",
      "headers": { "Authorization": "Bearer de_YOUR_CURSOR_KEY" }
    }
  }
}
```

Cursor lists the tools under Settings → MCP. Ask it, for example, "Using dyerempire, what was 524's P&L by month this year?"

## Connecting GrokBot

Grok calls remote MCP servers from xAI's side, so the server must be the public HTTPS URL. With the OpenAI-compatible Responses API:

```python
import os
from openai import OpenAI

client = OpenAI(api_key=os.environ["XAI_API_KEY"], base_url="https://api.x.ai/v1")

resp = client.responses.create(
    model="grok-4.7",  # whichever Grok model your bot uses
    input=[{"role": "user", "content": "Run the DyerEmpire weekly maintenance check and summarize what needs me."}],
    tools=[{
        "type": "mcp",
        "server_url": "https://www.dyerempire.com/api/mcp",
        "server_label": "dyerempire",
        "server_description": "Books for six rental properties and their entities",
        "authorization": os.environ["DYER_GROKBOT_KEY"],
        # Optional: keep a read-only bot to read-only tools
        # "allowed_tools": ["get_attention", "get_pnl", "list_transactions"],
    }],
)
print(resp.output_text)
```

The server accepts the key with or without the `Bearer ` prefix, so either form of `authorization` works.

## Tools (MCP) and endpoints (REST)

| MCP tool | REST | Scope |
|---|---|---|
| `get_attention` | `GET /api/v1/attention` | read |
| `list_properties` | `GET /api/v1/properties` | read |
| `list_entities` | `GET /api/v1/entities` | read |
| `list_categories` | `GET /api/v1/categories` | read |
| `list_transactions` | `GET /api/v1/transactions?property_id=&status=&from=&to=&q=&limit=` | read |
| `get_transaction` | `GET /api/v1/transactions/{id}` | read |
| `get_pnl` | `GET /api/v1/pnl?property_id=&from=&to=&group_by=category\|month\|property\|form8825` | read |
| `get_quarter` | `GET /api/v1/properties/{id}/quarters/2026-Q3` | read |
| `get_capital_accounts` | `GET /api/v1/properties/{id}/capital` | read |
| `list_pending_bank_txns` | `GET /api/v1/bank/pending` | read |
| `recent_changes` | `GET /api/v1/changes?actor=bot:GrokBot&detail=true` | read |
| `create_transaction` | `POST /api/v1/transactions` | write |
| `update_transaction` | `PATCH /api/v1/transactions/{id}` | write |
| `confirm_forecast` | `POST /api/v1/transactions/{id}/confirm` | write |
| `delete_forecast` | `DELETE /api/v1/transactions/{id}` | write |
| `void_transaction` | `POST /api/v1/transactions/{id}/void` | write |
| `list_notes` | `GET /api/v1/notes?status=open` | read |
| `resolve_note` | `POST /api/v1/notes/{id}/resolve` | write |
| `import_bank_csv` | `POST /api/v1/bank/import` | write |
| `post_bank_txn` | `POST /api/v1/bank/{id}/post` | write |
| `match_bank_txn` | `POST /api/v1/bank/{id}/match` | write |
| `exclude_bank_txn` | `POST /api/v1/bank/{id}/exclude` | write |
| `revert_bank_txn` | `POST /api/v1/bank/{id}/revert` | write |
| `list_schedules` | `GET /api/v1/schedules` | read |
| `create_schedule` | `POST /api/v1/schedules` | write |
| `update_schedule` | `PATCH /api/v1/schedules/{id}` | write |
| `record_distribution` | `POST /api/v1/properties/{id}/quarters/{period}/distribution` | write |
| `close_period` | `POST /api/v1/properties/{id}/quarters/{period}/close` | write |
| `reopen_period` | `POST /api/v1/properties/{id}/quarters/{period}/reopen` | write |
| `regenerate_forecasts` | `POST /api/v1/forecasts/regenerate` | write |
| `describe_schema` | `GET /api/v1/schema` | sql |
| `run_sql` | `POST /api/v1/query` with `{ "sql": "...", "params": [] }` | sql |

`GET /api/v1` with a key returns the list available to that key.

### REST examples

```bash
KEY=de_...
curl -s -H "Authorization: Bearer $KEY" https://www.dyerempire.com/api/v1/attention

curl -s -H "Authorization: Bearer $KEY" \
  "https://www.dyerempire.com/api/v1/pnl?property_id=4&from=2026-01-01&group_by=month"

curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 2026-10-10-belford-utilities" \
  -d '{"property_id":3,"category":"Utilities","amount":88.50,"txn_date":"2026-10-09","description":"AEP"}' \
  https://www.dyerempire.com/api/v1/transactions
```

Responses are `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message", "details" } }`.

## Rules bots live under

Since October 2026 the website is read-only, so these tools are the only way the books change. The guards below are what keep that safe.

- **Closed periods are locked.** Writes into a closed range return `409 period_closed`.
- **Categories must exist.** Type (income or expense) comes from the category. An unknown name returns the valid list.
- **Deposits** are sent as `is_deposit: true` with `type`, and are excluded from every P&L figure.
- **No double-booking.** An identical actual returns `409 duplicate`. A payment that matches a scheduled item returns `409 forecast_exists` and names the forecast to confirm instead. Send `allow_duplicate: true` only when the second row is real.
- **Retries are safe.** Send an `Idempotency-Key` header (REST) or `idempotency_key` (MCP). The same key never writes twice.
- **Bank-reconciled rows** keep their amount and date. Revert the bank row (`revert_bank_txn`) first.
- **Removing rows.** `delete_forecast` for scheduled items. `void_transaction` for a booked row that should not exist: needs `confirm: true` and a reason, and is refused in a closed quarter or when a bank line is attached (use `revert_bank_txn`).
- **Distributions:** $0 records freely. A positive payout needs `confirm_payout: true` (the owner stated the exact amount) and must pass the lifetime over-distribution guard (`allow_over` to knowingly return capital).
- **Closing a quarter** keeps unpaid rent as the arrears record and removes other leftover scheduled items. Record the distribution first.
- **Bank rows** post with the same rules the old Import screen had: pending only, legs add up to the cent, direction from the bank sign, category must match that direction. Each post, match, exclude and revert is one database transaction.
- **Every write is logged** in `mutations_log` in the same SQL statement as the write, with before and after JSON. `/admin` shows the latest 25.

## Notes from the website

The site has one input, a note box for David and Betsy ("Billy paid $155 cash for 500 West, August"). Notes never touch the ledger. `get_attention` lists open ones first as `open_notes`. For each one, post what it describes with the normal tools, checking the bank first so nothing is entered twice, then call `resolve_note` with `status: done` and a one-line reply naming amounts and transaction ids. Use `dismissed` when nothing needs posting. Ask David about anything ambiguous instead of guessing. The reply shows under the note on the site.

## Error codes

| HTTP | code | Meaning |
|---|---|---|
| 400 | `bad_request`, `bad_json`, `sql_error` | Fix the input. The message says how. |
| 401 | `unauthorized` | Missing, wrong, revoked, or expired key |
| 403 | `insufficient_scope` | Key lacks the scope |
| 404 | `not_found` | No such id |
| 409 | `period_closed`, `duplicate`, `forecast_exists`, `bank_reconciled`, `not_forecast`, `deposit_row` | Refused by a bookkeeping rule |

## Security notes

- Keys are 256-bit random values. Only their SHA-256 hash is stored.
- The API routes are exempt from Clerk in `proxy.ts` and authenticate every request themselves. A source test fails the build if any route handler skips authentication.
- Data a bot reads is sent to that bot's provider. GrokBot's reads go to xAI. Use `allowed_tools` and a `read`-only key for anything that does not need to write.
- `entities.tax_id` is left out of the typed API but is readable with `sql` scope. Leave `sql` off keys that don't need it.

## Testing

Install the test tools without touching `package.json` or the lockfile, then run either suite:

```bash
npm i --no-save vitest@3 pg@8
npx vitest run                                        # unit + source invariants, no database
npx vitest run -c vitest.integration.config.ts        # 45 end-to-end tests, local Postgres
```

The integration suite needs a disposable local Postgres (`PG_TEST_URL` as the owner, `PG_TEST_RO_URL` for the read-only role). Never point it at Neon. It drops and recreates the `public` schema.

## Not in v1

- Wiring the UI's own server actions into `mutations_log`.
- Recording distributions or closing periods from a bot (by design).
