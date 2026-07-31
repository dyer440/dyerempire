// app/real-estate/import/page.tsx
// Bank-CSV import screen (Phase A). Upload a US Bank export → rows land in
// bank_txns staging (hash-deduped, so overlapping exports are safe) → assign
// each pending row to a set of books (a property or SL Cap Mgmt), split across
// several, link it to an already-booked manual entry, or exclude it as personal.
// Requires migrations/2026-07_import_infra.sql.
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { displayName } from '@/lib/bank-import'
import { uploadBankCsv } from './actions'
import ImportClient, {
  type PendingRow, type ResolvedRow, type Candidate,
} from './import-client'

export const dynamic = 'force-dynamic'

export default async function ImportPage() {
  const editor = await getEditorEmail()
  if (!editor) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">Bank import</h1>
        <p className="text-gray-600">You need editor access to use the importer.</p>
      </div>
    )
  }

  const accounts = (await sql`
    SELECT a.id, a.name, a.last4 FROM bank_accounts a ORDER BY a.id
  `) as Record<string, any>[]

  if (accounts.length === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">Bank import</h1>
        <p className="text-red-600">
          No bank accounts configured. Run <code>migrations/2026-07_import_infra.sql</code> in Neon, then reload.
        </p>
      </div>
    )
  }

  const pendingRaw = (await sql`
    SELECT b.id, to_char(b.txn_date, 'YYYY-MM-DD') AS txn_date,
           b.amount::float8 AS amount, b.name_raw, b.name_norm,
           b.check_number, b.memo
    FROM bank_txns b
    WHERE b.status = 'pending'
    ORDER BY b.txn_date ASC, b.id ASC
  `) as Record<string, any>[]

  // Match candidates: already-booked actuals at the same |amount| within ±5
  // days, same sign-implied type, not yet tied to any bank row. This is the
  // automated "In the ledger?" check — link these instead of posting twice.
  const candidatesRaw = (await sql`
    SELECT b.id AS bank_id, t.id, t.amount::float8 AS amount,
           to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date,
           t.category, t.type, t.description, p.name AS property
    FROM bank_txns b
    JOIN transactions t
      ON t.amount = ABS(b.amount)
     AND t.txn_date BETWEEN b.txn_date - 5 AND b.txn_date + 5
     AND t.status = 'actual'
     AND ((b.amount > 0 AND t.type = 'income') OR (b.amount < 0 AND t.type = 'expense'))
    LEFT JOIN properties p ON p.id = t.property_id
    WHERE b.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM bank_txn_legs l WHERE l.transaction_id = t.id)
    ORDER BY t.txn_date
  `) as Record<string, any>[]

  const candidatesByBank = new Map<number, Candidate[]>()
  for (const c of candidatesRaw) {
    const list = candidatesByBank.get(c.bank_id) || []
    list.push({
      id: c.id, amount: c.amount, txn_date: c.txn_date, category: c.category,
      type: c.type, description: c.description, property: c.property,
    })
    candidatesByBank.set(c.bank_id, list)
  }

  const pending: PendingRow[] = pendingRaw.map(b => ({
    id: b.id,
    txn_date: b.txn_date,
    amount: b.amount,
    display: displayName({ nameRaw: b.name_raw, checkNumber: b.check_number, nameNorm: b.name_norm }),
    memo: b.memo,
    candidates: candidatesByBank.get(b.id) || [],
  }))

  const resolvedRaw = (await sql`
    SELECT b.id, to_char(b.txn_date, 'YYYY-MM-DD') AS txn_date,
           b.amount::float8 AS amount, b.name_raw, b.name_norm, b.check_number,
           b.status, b.exclude_reason,
           (SELECT string_agg(
              COALESCE(p2.name, e2.name, 'ledger') || ' $' || l.amount::text, ' + ')
            FROM bank_txn_legs l
            LEFT JOIN transactions t2 ON t2.id = l.transaction_id
            LEFT JOIN properties p2 ON p2.id = t2.property_id
            LEFT JOIN entities e2 ON e2.id = t2.entity_id AND t2.property_id IS NULL
            WHERE l.bank_txn_id = b.id) AS legs
    FROM bank_txns b
    WHERE b.status <> 'pending'
    ORDER BY b.resolved_at DESC NULLS LAST, b.id DESC
    LIMIT 40
  `) as Record<string, any>[]

  const resolved: ResolvedRow[] = resolvedRaw.map(b => ({
    id: b.id, txn_date: b.txn_date, amount: b.amount,
    display: displayName({ nameRaw: b.name_raw, checkNumber: b.check_number, nameNorm: b.name_norm }),
    status: b.status, exclude_reason: b.exclude_reason, legs: b.legs,
  }))

  const properties = (await sql`
    SELECT id, name FROM properties ORDER BY name
  `) as { id: number; name: string }[]

  const units = (await sql`
    SELECT id, property_id, label FROM units ORDER BY property_id, id
  `) as { id: number; property_id: number; label: string }[]

  const entities = (await sql`
    SELECT id, name FROM entities WHERE type <> 'property' ORDER BY name
  `) as { id: number; name: string }[]

  const categoriesRaw = (await sql`
    SELECT DISTINCT category FROM transactions
    WHERE txn_date >= (CURRENT_DATE - INTERVAL '3 years')
    ORDER BY category
  `) as Record<string, any>[]
  const categories = categoriesRaw.map(c => String(c.category))

  const counts = (await sql`
    SELECT status, count(*)::int AS n FROM bank_txns GROUP BY status
  `) as Record<string, any>[]
  const countOf = (s: string) => counts.find(c => c.status === s)?.n ?? 0

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Bank import</h1>
        <p className="text-sm text-gray-500">
          Upload a bank CSV, then assign each row to the right books. Re-uploading an
          overlapping export is safe — duplicates are skipped automatically.
        </p>
      </div>

      <form action={uploadBankCsv} className="border rounded p-4 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Account</span>
          <select name="accountId" defaultValue={accounts[0].id} className="border rounded px-2 py-1">
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` …${a.last4}` : ''}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">CSV file</span>
          <input type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
        </label>
        <button type="submit" className="border rounded px-4 py-1.5 bg-gray-900 text-white hover:bg-gray-700">
          Upload
        </button>
        <span className="text-xs text-gray-500 ml-auto">
          {countOf('pending')} pending · {countOf('posted')} posted · {countOf('linked')} linked · {countOf('excluded')} excluded
        </span>
      </form>

      <ImportClient
        pending={pending}
        resolved={resolved}
        properties={properties}
        units={units}
        entities={entities}
        categories={categories}
      />
    </div>
  )
}
