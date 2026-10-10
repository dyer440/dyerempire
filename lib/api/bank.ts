// lib/api/bank.ts
// Read-only view of the bank import queue, with the same rule suggestion and
// match candidates for each pending row. Posting is in
// lib/api/bank-post.ts.
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

  // Ledger rows this bank line probably IS: same amount and direction within ±5
  // days, not yet tied to a bank row. Same query as the Import screen.
  const cands = (await sql`
    SELECT b.id AS bank_id, t.id, t.status, t.category, t.amount::float8 AS amount,
           to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date, t.description,
           COALESCE(p.name, e.name) AS books
    FROM bank_txns b
    JOIN transactions t
      ON t.amount = ABS(b.amount)
     AND t.txn_date BETWEEN b.txn_date - 5 AND b.txn_date + 5
     AND t.status IN ('actual', 'forecast')
     AND ((b.amount > 0 AND t.type = 'income') OR (b.amount < 0 AND t.type = 'expense'))
    LEFT JOIN properties p ON p.id = t.property_id
    LEFT JOIN entities e ON e.id = t.entity_id AND t.property_id IS NULL
    WHERE b.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM bank_txn_legs l WHERE l.transaction_id = t.id)
    ORDER BY t.status DESC, t.txn_date
  `) as { bank_id: number; id: number; status: string; category: string; amount: number; txn_date: string; description: string | null; books: string | null }[]
  const candOf = new Map<number, typeof cands>()
  for (const c of cands) candOf.set(c.bank_id, [...(candOf.get(c.bank_id) || []), c])

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
        candidates: (candOf.get(b.id) || []).map(({ bank_id: _b, ...c }) => { void _b; return c }),
      }
    }),
    note:
      'For each row: if a candidate is the same item, match_bank_txn to it (a forecast is confirmed at the cleared ' +
      'amount). Otherwise post_bank_txn using the suggestion, or exclude_bank_txn if it is not business.',
  }
}
