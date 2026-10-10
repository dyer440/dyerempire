// app/api/v1/bank/import/route.ts
// Upload a US Bank CSV export into the import queue. Either:
//   POST JSON  { "account_id": 1, "csv": "<file text>" }
//   POST text/csv body directly, with ?account_id=1 (defaults to 1)
// Overlapping exports are safe; already-imported rows are skipped.
import { route } from '@/lib/api/http'
import { importBankCsv } from '@/lib/api/bank-import'

export const POST = route('write', async ({ req, query, body, who }) => {
  const type = req.headers.get('content-type') || ''
  if (type.includes('text/csv') || type.includes('text/plain')) {
    return importBankCsv({ account_id: query.account_id, csv: await req.text() }, who)
  }
  return importBankCsv(await body(), who)
}, 201)
