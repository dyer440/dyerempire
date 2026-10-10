// lib/leases.ts
// Current lease terms per rented unit, kept on the existing `leases` and
// `tenants` tables (lib/init-db.ts), with a few columns added on first use:
// month-to-month rent, notes, renewal plan and who last changed it.
//
// One lease per unit is "current" (status 'active'); older ones are 'ended'.
// Whether a current lease is in its term or running month to month is worked
// out from end_date, so nobody has to remember to flip it.
import sql from './db'

let ready: Promise<void> | null = null

export function ensureLeases(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await sql`ALTER TABLE leases ADD COLUMN IF NOT EXISTS mtm_rent NUMERIC(12,2)`
      await sql`ALTER TABLE leases ADD COLUMN IF NOT EXISTS notes TEXT`
      await sql`ALTER TABLE leases ADD COLUMN IF NOT EXISTS plan TEXT`
      await sql`ALTER TABLE leases ADD COLUMN IF NOT EXISTS ended_on DATE`
      await sql`ALTER TABLE leases ADD COLUMN IF NOT EXISTS updated_by TEXT`
      await sql`ALTER TABLE leases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS leases_one_current_per_unit ON leases (unit_id) WHERE status = 'active'`
    })().catch((e) => { ready = null; throw e })
  }
  return ready
}

/** Leases ending within this many days are flagged: time to negotiate a renewal or plan the exit. */
export const EXPIRING_DAYS = 45

export type LeaseState = 'in_term' | 'ending_soon' | 'month_to_month' | 'no_end_date' | 'ended'

export type Lease = {
  id: number
  property_id: number
  property: string
  unit_id: number | null
  unit: string | null
  multi_unit: boolean
  tenant: string | null
  tenant_phone: string | null
  tenant_email: string | null
  monthly_rent: number | null
  rent_due_day: number | null
  mtm_rent: number | null
  deposit_amount: number | null
  start_date: string | null
  end_date: string | null
  status: string
  ended_on: string | null
  notes: string | null
  plan: string | null
  updated_at: string | null
  updated_by: string | null
  /** What the active rent schedule for this unit says, to spot a mismatch. */
  schedule_rent: number | null
  days_left: number | null
  state: LeaseState
}

export async function listLeases(opts: { propertyIds?: number[]; includeEnded?: boolean } = {}): Promise<Lease[]> {
  await ensureLeases()
  const ids = opts.propertyIds ?? null
  const rows = (await sql`
    SELECT l.id, l.property_id, p.name AS property, l.unit_id, u.label AS unit,
           (SELECT count(*) FROM units x WHERE x.property_id = l.property_id) > 1 AS multi_unit,
           t.name AS tenant, t.phone AS tenant_phone, t.email AS tenant_email,
           l.monthly_rent::float8 AS monthly_rent, l.rent_due_day, l.mtm_rent::float8 AS mtm_rent,
           l.deposit_amount::float8 AS deposit_amount,
           to_char(l.start_date, 'YYYY-MM-DD') AS start_date, to_char(l.end_date, 'YYYY-MM-DD') AS end_date,
           l.status, to_char(l.ended_on, 'YYYY-MM-DD') AS ended_on, l.notes, l.plan,
           to_char(l.updated_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS updated_at, l.updated_by,
           (SELECT s.amount::float8 FROM recurring_schedules s
             WHERE s.property_id = l.property_id AND s.status = 'active' AND s.type = 'income'
               AND s.category ILIKE '%rent%' AND (s.unit_id = l.unit_id OR s.unit_id IS NULL)
               AND (s.end_date IS NULL OR s.end_date >= CURRENT_DATE)
             ORDER BY (s.unit_id IS NULL), s.id DESC LIMIT 1) AS schedule_rent,
           (l.end_date - CURRENT_DATE) AS days_left
    FROM leases l
    JOIN properties p ON p.id = l.property_id
    LEFT JOIN units u ON u.id = l.unit_id
    LEFT JOIN tenants t ON t.id = l.tenant_id
    WHERE (${ids}::int[] IS NULL OR l.property_id = ANY(${ids}::int[]))
      AND (${opts.includeEnded ?? false} OR l.status = 'active')
    ORDER BY p.name, u.label NULLS FIRST, l.status, l.start_date DESC NULLS LAST
  `) as (Omit<Lease, 'state'>)[]
  return rows.map((r) => ({ ...r, state: leaseState(r) }))
}

export function leaseState(l: { status: string; end_date: string | null; days_left: number | null }): LeaseState {
  if (l.status !== 'active') return 'ended'
  if (!l.end_date || l.days_left === null) return 'no_end_date'
  if (l.days_left < 0) return 'month_to_month'
  if (l.days_left <= EXPIRING_DAYS) return 'ending_soon'
  return 'in_term'
}
