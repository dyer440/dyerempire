// app/real-estate/[id]/schedules/page.tsx  (NEW — manage recurring schedules)
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import sql from '@/lib/db'
import { getUserRole, canAccessProperty, canEdit } from '@/lib/access'
import { INCOME_CATEGORIES, EXPENSE_CATEGORIES } from '@/lib/categories'
import { FREQUENCIES } from '@/lib/recurring'
import { addSchedule, deleteSchedule, toggleSchedule, regenerateForecasts } from '../../recurring/actions'

export default async function SchedulesPage({ params }: { params: Promise<{ id: string }> }) {
  await auth.protect()
  const { id } = await params
  const propertyId = Number(id)

  const { sessionClaims } = await auth()
  const email = (sessionClaims?.email as string) || ''
  const role = await getUserRole(email)
  if (!(await canAccessProperty(email, role, propertyId))) redirect('/real-estate')
  if (!canEdit(role)) redirect(`/real-estate/${propertyId}`)

  const prop = (await sql`SELECT id, name FROM properties WHERE id = ${propertyId} LIMIT 1`) as
    { id: number; name: string }[]
  if (prop.length === 0) redirect('/real-estate')

  const units = (await sql`SELECT id, label FROM units WHERE property_id = ${propertyId} ORDER BY id`) as
    { id: number; label: string }[]

  const schedules = (await sql`
    SELECT s.*, u.label AS unit_label
    FROM recurring_schedules s LEFT JOIN units u ON u.id = s.unit_id
    WHERE s.property_id = ${propertyId}
    ORDER BY s.type DESC, s.category
  `) as {
    id: number; type: string; category: string; description: string | null; amount: string
    is_estimate: boolean; frequency: string; months_csv: string | null; day_of_month: number
    start_date: string | null; end_date: string | null; status: string; unit_label: string | null
  }[]

  const forecastCount = (await sql`
    SELECT COUNT(*)::int AS n FROM transactions
    WHERE property_id = ${propertyId} AND status = 'forecast' AND txn_date >= CURRENT_DATE
  `) as { n: number }[]

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl tracking-[0.3em] uppercase" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
              Schedules
            </h1>
            <p className="text-white/30 text-xs tracking-widest uppercase mt-1">{prop[0].name} · recurring items</p>
          </div>
          <Link href={`/real-estate/${propertyId}`} className="text-white/30 hover:text-white text-xs tracking-widest uppercase transition-colors">
            ← Property
          </Link>
        </div>

        {/* Regenerate */}
        <form action={regenerateForecasts} className="flex items-center justify-between border border-white/10 p-4 mb-8">
          <div className="text-xs text-white/50">
            {forecastCount[0]?.n ?? 0} forecast rows projected ahead (12-month horizon).
          </div>
          <input type="hidden" name="property_id" value={propertyId} />
          <button type="submit" className="border border-white/30 px-5 py-2 text-xs tracking-widest uppercase hover:bg-white/10 transition-all">
            Regenerate
          </button>
        </form>

        {/* Add schedule */}
        <form action={addSchedule} className="border border-white/10 p-6 mb-8">
          <input type="hidden" name="property_id" value={propertyId} />
          <h2 className="text-xs tracking-widest uppercase text-white/40 mb-4">Add Schedule</h2>

          <div className="grid grid-cols-2 gap-3 mb-3">
            <select name="type" defaultValue="expense" className="bg-white/5 border border-white/20 px-4 py-2 text-white text-sm focus:outline-none focus:border-white/50">
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
            <select name="category" required className="bg-white/5 border border-white/20 px-4 py-2 text-white text-sm focus:outline-none focus:border-white/50">
              <optgroup label="Income">
                {INCOME_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </optgroup>
              <optgroup label="Expense">
                {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </optgroup>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-3">
            <input name="amount" type="number" step="0.01" min="0.01" placeholder="Amount ($)" required
              className="bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 text-sm focus:outline-none focus:border-white/50" />
            <select name="unit_id" className="bg-white/5 border border-white/20 px-4 py-2 text-white text-sm focus:outline-none focus:border-white/50">
              <option value="">Whole property</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </div>

          <input name="description" type="text" placeholder="Description (e.g. Water (Stormwater))"
            className="w-full bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 text-sm focus:outline-none focus:border-white/50 mb-3" />

          <div className="grid grid-cols-3 gap-3 mb-3">
            <select name="frequency" defaultValue="monthly" className="bg-white/5 border border-white/20 px-4 py-2 text-white text-sm focus:outline-none focus:border-white/50">
              {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <input name="months_csv" type="text" placeholder="Months e.g. 1,4,7,10"
              className="bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 text-sm focus:outline-none focus:border-white/50" />
            <input name="day_of_month" type="number" min="1" max="28" defaultValue={15} placeholder="Day"
              className="bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 text-sm focus:outline-none focus:border-white/50" />
          </div>

          <div className="grid grid-cols-3 gap-3 mb-4">
            <input name="start_date" type="date" className="bg-white/5 border border-white/20 px-4 py-2 text-white text-sm focus:outline-none focus:border-white/50" />
            <input name="end_date" type="date" className="bg-white/5 border border-white/20 px-4 py-2 text-white text-sm focus:outline-none focus:border-white/50" />
            <label className="flex items-center gap-2 text-xs text-white/50 px-2">
              <input name="is_estimate" type="checkbox" className="accent-amber-400" />
              Estimate (confirm when paid)
            </label>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-[11px] text-white/30 max-w-md">
              Leave “Months” blank for monthly. For quarterly/semiannual/annual, list the months it fires
              (Fire = 1,4,7,10 · Refuse = 3,6,9,12 · Insurance = 3,9 · Tax = 4). Mark tax/insurance as Estimate.
            </p>
            <button type="submit" className="border border-white/30 px-6 py-2 text-sm tracking-widest uppercase hover:bg-white/10 transition-all">
              Add
            </button>
          </div>
        </form>

        {/* Existing schedules */}
        <div className="border border-white/10">
          <div className="px-6 py-3 border-b border-white/10 text-xs tracking-widest uppercase text-white/40">
            Schedules ({schedules.length})
          </div>
          {schedules.length === 0 && (
            <div className="px-6 py-8 text-center text-white/20 text-sm tracking-widest uppercase">No schedules yet</div>
          )}
          {schedules.map((s) => {
            const income = s.type === 'income'
            const paused = s.status !== 'active'
            return (
              <div key={s.id} className={`flex items-center justify-between px-6 py-4 border-b border-white/5 ${paused ? 'opacity-40' : ''}`}>
                <div className="flex items-center gap-5">
                  <div className={`text-sm w-24 ${income ? 'text-emerald-400' : 'text-rose-400'}`} style={{ fontFamily: 'Georgia, serif' }}>
                    {income ? '+' : '−'}${parseFloat(s.amount).toFixed(2)}
                  </div>
                  <div>
                    <div className="text-sm text-white/70">
                      {s.category}{s.is_estimate ? <span className="text-amber-400/80 text-xs ml-2 tracking-widest uppercase">est</span> : null}
                    </div>
                    <div className="text-xs text-white/40 mt-0.5">
                      {s.frequency}{s.months_csv ? ` · mo ${s.months_csv}` : ''} · day {s.day_of_month}
                      {s.unit_label ? ` · ${s.unit_label}` : ''}{s.description ? ` · ${s.description}` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <form action={toggleSchedule}>
                    <input type="hidden" name="property_id" value={propertyId} />
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="next_status" value={paused ? 'active' : 'paused'} />
                    <button type="submit" className="text-xs text-white/30 hover:text-white tracking-widest uppercase transition-colors">
                      {paused ? 'Resume' : 'Pause'}
                    </button>
                  </form>
                  <form action={deleteSchedule}>
                    <input type="hidden" name="property_id" value={propertyId} />
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" className="text-xs text-white/20 hover:text-red-400 tracking-widest uppercase transition-colors">
                      Remove
                    </button>
                  </form>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </main>
  )
}
