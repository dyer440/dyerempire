// app/api/v1/query/route.ts
// Read-only SQL. Body: { "sql": "SELECT ...", "params": [..], "max_rows": 500 }
import { route } from '@/lib/api/http'
import { runReadOnlySql } from '@/lib/api/sql-runner'

export const POST = route('sql', async ({ body }) => {
  const b = await body()
  return runReadOnlySql(String(b.sql ?? ''), (b.params as unknown[]) ?? [], Number(b.max_rows ?? 500))
})
