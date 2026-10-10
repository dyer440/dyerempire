// lib/api/bank.ts
// Read-only view of the bank import queue, with the same rule suggestion the
// /real-estate/import screen shows. Posting stays in the app for now: postBankTxn
// is tied to the Clerk session, and splitting it out is its own change.
import sql from '@/lib/db'
import { bestRule, ruleToSuggestion, type ImportRule } from '@/lib/import-rules'
import { displayName } from '@/lib/bank-import'
import { type Input, clampInt } from './validate'

export async function listPendingBank(input: Input) {
  const limit = clampInt(input, 'limit', 100, 1, 500)
  const pending = (await sql`
    SELECT b.id, b.account_id, a.name AS account, to_char(b.txn_date, 'YYYY-MM-DD') AS txn_date,
           b.amount::float8 AS amount, b.name_raw, b.name_norm, b.check_number, b.memo
    FROM bank_txns b
    LEFT JOIN bank_accounts a ON a.id = b.account_id
    WHERE b.status = 'pending'
    ORDER BY b.txn_date ASC, b.id ASC
    LIMIT ${limit}
  `) as { id: number; account: string | null; txn_date: string; amount: number; name_raw: string; name_norm: string; check_number: string | null; memo: string | null }[]

  const rules = (await sql`
    SELECT id, pattern, amount::float8 AS amount, applies_to, target_kind,
           property_id, entity_id, category, is_rent, unit_id, is_deposit,
           exclude_reason, note
    FROM import_rules
  `) as ImportRule[]

  return {
    count: pending.length,
    rows: pending.map((b) => {
      const rule = bestRule(rules, { amount: b.amount, name_norm: b.name_norm })
      return {
        id: b.id,
        account: b.account,
        txn_date: b.txn_date,
        amount: b.amount,
        direction: b.amount > 0 ? 'credit' : 'debit',
        counterparty: displayName({ nameRaw: b.name_raw, checkNumber: b.check_number, nameNorm: b.name_norm }),
        memo: b.memo,
        suggestion: rule ? ruleToSuggestion(rule) : null,
      }
    }),
    note: 'Post these in /real-estate/import. Bot posting of bank rows is not enabled yet.',
  }
}
