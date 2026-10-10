// lib/api/bank-import.ts
// Bot upload of a US Bank CSV export into the import queue (bank_txns), using
// exactly the same parser and dedup hash the retired import screen used.
// Re-sending an overlapping export is harmless: rows already imported are
// skipped by the unique import_hash. Nothing is posted to the ledger here; the
// rows land as 'pending' for the Import screen (or a later bot step) to post.
import sql from '@/lib/db'
import { parseUsBankCsv, withOccurrences, importHash } from '@/lib/bank-import'
import { ApiError, badRequest, notFound } from './errors'
import type { Actor } from './service'
import { type Input, optInt } from './validate'

const MAX_CSV_BYTES = 2_000_000

export async function importBankCsv(input: Input, who: Actor) {
  const accountId = optInt(input, 'account_id') ?? 1
  const csv = typeof input.csv === 'string' ? input.csv : ''
  if (!csv.trim()) throw badRequest('csv is required: the full text of the US Bank export, header row included.')
  if (csv.length > MAX_CSV_BYTES) throw badRequest('CSV is larger than 2 MB. Export a shorter date range.')

  const acct = (await sql`SELECT id, name, last4 FROM bank_accounts WHERE id = ${accountId}`) as
    { id: number; name: string; last4: string | null }[]
  if (!acct[0]) throw notFound(`Bank account ${accountId} not found.`)

  let parsed
  try {
    parsed = withOccurrences(parseUsBankCsv(csv))
  } catch (e) {
    throw new ApiError(400, 'bad_csv', (e as Error).message)
  }
  if (parsed.length === 0) throw new ApiError(400, 'bad_csv', 'No transactions found in that file.')

  let inserted = 0
  const newIds: number[] = []
  for (const r of parsed) {
    const res = (await sql`
      INSERT INTO bank_txns
        (account_id, txn_date, amount, name_raw, memo, check_number, name_norm, occurrence, import_hash)
      VALUES
        (${accountId}, ${r.txnDate}::date, ${r.amount}, ${r.nameRaw}, ${r.memo},
         ${r.checkNumber}, ${r.nameNorm}, ${r.occurrence}, ${importHash(accountId, r)})
      ON CONFLICT (import_hash) DO NOTHING
      RETURNING id
    `) as { id: number }[]
    if (res[0]) { inserted++; newIds.push(res[0].id) }
  }

  const dates = parsed.map((r) => r.txnDate).sort()
  const summary = {
    account: { id: acct[0].id, name: acct[0].name, last4: acct[0].last4 },
    rows_in_file: parsed.length,
    inserted,
    already_imported: parsed.length - inserted,
    file_date_range: { from: dates[0], to: dates[dates.length - 1] },
  }
  await sql`
    INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after)
    VALUES (${who.actor}, ${who.keyId}, ${who.source}, 'bank.import_csv', 'bank_accounts', ${accountId},
            ${JSON.stringify({ ...summary, new_bank_txn_ids: newIds })}::jsonb)
  `
  const pending = (await sql`SELECT COUNT(*)::int AS n FROM bank_txns WHERE status = 'pending'`) as { n: number }[]
  return { ...summary, pending_in_queue: pending[0]?.n ?? 0 }
}
