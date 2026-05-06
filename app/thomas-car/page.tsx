import { auth } from '@clerk/nextjs/server'
import sql from '@/lib/db'
import { addPayment, deletePayment } from './actions'

const PURCHASE_PRICE = 3500

async function getPayments() {
  return await sql`SELECT * FROM car_payments ORDER BY paid_on DESC, created_at DESC`
}

export default async function ThomasCarPage() {
  await auth.protect()

  const payments = await getPayments()
  const totalPaid = (payments as { amount: number }[]).reduce((sum, p) => sum + parseFloat(p.amount as unknown as string), 0)
  const balance = PURCHASE_PRICE - totalPaid
  const percentPaid = Math.min((totalPaid / PURCHASE_PRICE) * 100, 100)

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1
              className="text-2xl tracking-[0.3em] uppercase"
              style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}
            >
              Thomas' Car
            </h1>
            <p className="text-white/30 text-xs tracking-widest uppercase mt-1">Payment Ledger</p>
          </div>
          <a
            href="/"
            className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors"
          >
            ← Home
          </a>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-4 mb-10">
          <div className="border border-white/10 p-4">
            <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Purchase</div>
            <div className="text-xl" style={{ fontFamily: 'Georgia, serif' }}>
              ${PURCHASE_PRICE.toLocaleString()}
            </div>
          </div>
          <div className="border border-white/10 p-4">
            <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Paid</div>
            <div className="text-xl text-emerald-400" style={{ fontFamily: 'Georgia, serif' }}>
              ${totalPaid.toFixed(2)}
            </div>
          </div>
          <div className="border border-white/10 p-4">
            <div className="text-white/30 text-xs tracking-widest uppercase mb-2">Balance</div>
            <div
              className={`text-xl ${balance <= 0 ? 'text-emerald-400' : 'text-amber-400'}`}
              style={{ fontFamily: 'Georgia, serif' }}
            >
              ${Math.max(balance, 0).toFixed(2)}
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mb-10">
          <div className="flex justify-between text-xs text-white/30 tracking-widest uppercase mb-2">
            <span>Progress</span>
            <span>{percentPaid.toFixed(1)}%</span>
          </div>
          <div className="h-1 bg-white/10 w-full">
            <div
              className="h-1 bg-emerald-400 transition-all duration-500"
              style={{ width: `${percentPaid}%` }}
            />
          </div>
        </div>

        {/* Add Payment Form */}
        <form action={addPayment} className="border border-white/10 p-6 mb-8">
          <h2 className="text-xs tracking-widest uppercase text-white/40 mb-4">Add Payment</h2>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="Amount ($)"
              required
              className="bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 text-sm"
            />
            <input
              name="paid_on"
              type="date"
              required
              defaultValue={new Date().toISOString().split('T')[0]}
              className="bg-white/5 border border-white/20 px-4 py-2 text-white focus:outline-none focus:border-white/50 text-sm"
            />
          </div>
          <div className="flex gap-3">
            <input
              name="note"
              type="text"
              placeholder="Note (optional)"
              className="flex-1 bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 text-sm"
            />
            <button
              type="submit"
              className="border border-white/30 px-6 py-2 text-sm tracking-widest uppercase hover:bg-white/10 transition-all whitespace-nowrap"
            >
              Add
            </button>
          </div>
        </form>

        {/* Payment History */}
        <div className="border border-white/10">
          <div className="px-6 py-3 border-b border-white/10 text-xs tracking-widest uppercase text-white/40">
            Payment History ({payments.length})
          </div>
          {payments.length === 0 && (
            <div className="px-6 py-8 text-center text-white/20 text-sm tracking-widest uppercase">
              No payments yet
            </div>
          )}
          {(payments as { id: number; amount: number; note: string; paid_on: string }[]).map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between px-6 py-4 border-b border-white/5 hover:bg-white/5"
            >
              <div className="flex items-center gap-6">
                <div className="text-emerald-400 text-sm" style={{ fontFamily: 'Georgia, serif' }}>
                  +${parseFloat(p.amount as unknown as string).toFixed(2)}
                </div>
                <div>
                  <div className="text-xs text-white/60">
                    {new Date(p.paid_on).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </div>
                  {p.note && <div className="text-xs text-white/30 mt-0.5">{p.note}</div>}
                </div>
              </div>
              <form action={deletePayment}>
                <input type="hidden" name="id" value={p.id} />
                <button
                  type="submit"
                  className="text-xs text-white/20 hover:text-red-400 tracking-widest uppercase transition-colors"
                >
                  Remove
                </button>
              </form>
            </div>
          ))}
        </div>

      </div>
    </main>
  )
}
