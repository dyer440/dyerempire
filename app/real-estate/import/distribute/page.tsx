// app/real-estate/import/distribute/page.tsx
// Fee-distribute helper. Lists pending debit amounts that repeat across many
// rows (the identical per-property fees no rule can place), and — for a chosen
// amount via ?amount= — opens a grid to spread those rows across properties.
// Companion to the reconciliation view: reconcile shows the gap, this closes it.
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'
import { displayName } from '@/lib/bank-import'
import Link from 'next/link'
import DistributeClient, { type FeeRow } from './distribute-client'

export const dynamic = 'force-dynamic'

const money = (n: number) =>
  Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default async function DistributePage({
  searchParams,
}: {
  searchParams: { amount?: string } | Promise<{ amount?: string }>
}) {
  const params = await Promise.resolve(searchParams)
  const editor = await getEditorEmail()
  if (!editor) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-2">Distribute fees</h1>
        <p className="text-gray-600">You need editor access to use this.</p>
      </div>
    )
  }

  // Pending debit amounts with 2+ rows — the distribute candidates.
  const groups = (await sql`
    SELECT ABS(amount)::float8 AS amount, count(*)::int AS n,
           to_char(min(txn_date), 'YYYY-MM') AS first_month,
           to_char(max(txn_date), 'YYYY-MM') AS last_month
    FROM bank_txns
    WHERE status = 'pending' AND amount < 0
    GROUP BY ABS(amount)
    HAVING count(*) >= 2
    ORDER BY count(*) DESC, ABS(amount)
  `) as Record<string, any>[]

  const selected = params.amount && /^\d+(\.\d+)?$/.test(params.amount) ? Number(params.amount) : null

  let rows: FeeRow[] = []
  if (selected != null) {
    const raw = (await sql`
      SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS txn_date,
             amount::float8 AS amount, name_raw, name_norm, check_number
      FROM bank_txns
      WHERE status = 'pending' AND ABS(amount) = ${selected}
      ORDER BY txn_date, id
    `) as Record<string, any>[]
    rows = raw.map(b => ({
      id: b.id,
      txn_date: b.txn_date,
      amount: b.amount,
      display: displayName({ nameRaw: b.name_raw, checkNumber: b.check_number, nameNorm: b.name_norm }),
    }))
  }

  const properties = (await sql`SELECT id, name FROM properties ORDER BY name`) as { id: number; name: string }[]

  // Sensible default category by amount: the tiny sanitary fee is Utilities-ish,
  // the larger municipal/refuse fees are Municipal Fees.
  const defaultCategory = selected != null && selected < 20 ? 'Utilities' : 'Municipal Fees'

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Distribute fees</h1>
        <p className="text-sm text-gray-500">
          Spread identical per-property fees across the houses that share them.{' '}
          <Link href="/real-estate/import" className="underline">Back to import</Link> ·{' '}
          <Link href="/real-estate/import/reconcile" className="underline">Reconciliation</Link>
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {groups.length === 0 && <p className="text-sm text-gray-500">No repeated pending fee amounts.</p>}
        {groups.map(g => {
          const isSel = selected === g.amount
          return (
            <Link key={g.amount} href={`/real-estate/import/distribute?amount=${g.amount}`}
              className={`border rounded px-3 py-2 text-sm ${isSel ? 'bg-gray-900 text-white' : 'hover:bg-gray-50'}`}>
              <span className="font-medium">{money(g.amount)}</span>
              <span className={isSel ? 'text-gray-300' : 'text-gray-500'}> · {g.n} rows · {g.first_month}–{g.last_month}</span>
            </Link>
          )
        })}
      </div>

      {selected != null && rows.length > 0 && (
        <DistributeClient
          amount={selected}
          rows={rows}
          properties={properties}
          defaultCategory={defaultCategory}
        />
      )}
      {selected != null && rows.length === 0 && (
        <p className="text-sm text-gray-500">No pending rows left at {money(selected)} — all distributed.</p>
      )}
    </div>
  )
}
