// lib/api/leases.ts
// Bot tools for lease terms (see lib/leases.ts).
//   list_leases   read
//   upsert_lease  write: set or correct the current lease on a unit; with
//                 new_lease: true the old lease is ended and a new one starts
//   end_lease     write: tenant gone, no new lease yet
// Every write is logged with the before and after rows.
import sql from '@/lib/db'
import { ensureLeases, listLeases } from '@/lib/leases'
import { badRequest, conflict, notFound } from './errors'
import { type Actor, refreshUi } from './service'
import { type Input, reqInt, optInt, optString, optBool, optAmount, optDate } from './validate'

type Row = Record<string, unknown>

export async function listLeasesApi(input: Input) {
  const pid = optInt(input, 'property_id')
  const leases = await listLeases({ propertyIds: pid ? [pid] : undefined, includeEnded: optBool(input, 'include_ended') === true })
  return {
    count: leases.length,
    leases,
    hints: {
      state: "in_term, ending_soon (60 days or less), month_to_month (past the end date, still renting), no_end_date, ended",
      schedule_rent: 'The active rent schedule amount. If it differs from monthly_rent, one of them is out of date. Ask David which.',
    },
  }
}

async function resolveUnit(propertyId: number, unitId: number | null): Promise<{ id: number; label: string }> {
  const units = (await sql`
    SELECT u.id, u.label,
           EXISTS (SELECT 1 FROM transactions t WHERE t.unit_id = u.id AND t.category ILIKE '%rent%') AS has_rent
    FROM units u WHERE u.property_id = ${propertyId} ORDER BY u.id
  `) as { id: number; label: string; has_rent: boolean }[]
  if (!units.length) throw badRequest(`Property ${propertyId} has no units on record.`)
  if (unitId) {
    const u = units.find((x) => x.id === unitId)
    if (!u) throw badRequest(`Unit ${unitId} is not part of property ${propertyId}.`, { units })
    return u
  }
  if (units.length === 1) return units[0]
  const rented = units.filter((u) => u.has_rent)
  if (rented.length === 1) return rented[0]
  throw badRequest('This property has more than one unit. Send unit_id.', { units: units.map(({ id, label }) => ({ id, label })) })
}

export async function upsertLease(input: Input, who: Actor) {
  await ensureLeases()
  const propertyId = reqInt(input, 'property_id')
  const p = (await sql`SELECT id, name FROM properties WHERE id = ${propertyId}`) as Row[]
  if (!p[0]) throw notFound(`Property ${propertyId} not found.`)
  const unit = await resolveUnit(propertyId, optInt(input, 'unit_id'))
  const newLease = optBool(input, 'new_lease') === true

  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== null && input[k] !== ''
  const tenantName = optString(input, 'tenant_name', 200)
  const fields = {
    monthly_rent: optAmount(input, 'monthly_rent'),
    rent_due_day: optInt(input, 'rent_due_day'),
    mtm_rent: optAmount(input, 'mtm_rent'),
    deposit_amount: optAmount(input, 'deposit_amount'),
    start_date: optDate(input, 'start_date'),
    end_date: optDate(input, 'end_date'),
    notes: optString(input, 'notes', 1000),
    plan: optString(input, 'plan', 500),
  }
  if (fields.rent_due_day !== null && (fields.rent_due_day < 1 || fields.rent_due_day > 31)) throw badRequest('rent_due_day must be 1 to 31.')
  if (fields.start_date && fields.end_date && fields.end_date < fields.start_date) throw badRequest('end_date is before start_date.')

  const cur = (await sql`
    SELECT l.*, t.name AS tenant_name FROM leases l LEFT JOIN tenants t ON t.id = l.tenant_id
    WHERE l.unit_id = ${unit.id} AND l.status = 'active'
  `) as Row[]
  const current = cur[0] ?? null

  if (current && tenantName && !newLease && String(current.tenant_name ?? '').toLowerCase() !== tenantName.toLowerCase()) {
    throw conflict('different_tenant',
      `${unit.label} currently has a lease with ${current.tenant_name}. To start a lease with ${tenantName}, resend with new_lease: true (the old one is ended). To fix a misspelled name, use the same spelling plus tenant_rename.`,
      { current_lease_id: current.id })
  }
  if (!current || newLease) {
    if (!tenantName) throw badRequest('tenant_name is required for a new lease.')
  }

  // Tenant: reuse by name, else create. Contact details update in place.
  let tenantId: number | null = current && !newLease ? (current.tenant_id as number | null) : null
  const rename = optString(input, 'tenant_rename', 200)
  if (tenantName && (newLease || !current || !tenantId)) {
    const t = (await sql`SELECT id FROM tenants WHERE lower(name) = lower(${tenantName}) ORDER BY id DESC LIMIT 1`) as { id: number }[]
    tenantId = t[0]?.id ?? ((await sql`INSERT INTO tenants (name) VALUES (${tenantName}) RETURNING id`) as { id: number }[])[0].id
  }
  if (tenantId) {
    const phone = optString(input, 'tenant_phone', 40)
    const email = optString(input, 'tenant_email', 200)
    if (phone || email || rename) {
      await sql`UPDATE tenants SET phone = COALESCE(${phone}, phone), email = COALESCE(${email}, email), name = COALESCE(${rename}, name) WHERE id = ${tenantId}`
    }
  }
  const displayName = rename ?? tenantName ?? (current?.tenant_name as string | null) ?? null

  const before = current ? JSON.stringify(current) : null
  const endOld = current && newLease
  const oldEnd = fields.start_date ?? new Date().toISOString().slice(0, 10)

  const result = (await sql.transaction((tx) => [
    ...(endOld ? [tx`UPDATE leases SET status = 'ended', ended_on = (${oldEnd}::date - 1), updated_by = ${who.actor}, updated_at = now() WHERE id = ${current!.id as number}`] : []),
    current && !newLease
      ? tx`
          UPDATE leases SET
            tenant_id = COALESCE(${tenantId}, tenant_id),
            monthly_rent = CASE WHEN ${has('monthly_rent')} THEN ${fields.monthly_rent} ELSE monthly_rent END,
            rent_due_day = CASE WHEN ${has('rent_due_day')} THEN ${fields.rent_due_day} ELSE rent_due_day END,
            mtm_rent = CASE WHEN ${has('mtm_rent')} THEN ${fields.mtm_rent} ELSE mtm_rent END,
            deposit_amount = CASE WHEN ${has('deposit_amount')} THEN ${fields.deposit_amount} ELSE deposit_amount END,
            start_date = CASE WHEN ${has('start_date')} THEN ${fields.start_date}::date ELSE start_date END,
            end_date = CASE WHEN ${has('end_date')} THEN ${fields.end_date}::date ELSE end_date END,
            notes = CASE WHEN ${has('notes')} THEN ${fields.notes} ELSE notes END,
            plan = CASE WHEN ${has('plan')} THEN ${fields.plan} ELSE plan END,
            updated_by = ${who.actor}, updated_at = now()
          WHERE id = ${current.id as number}
          RETURNING id`
      : tx`
          INSERT INTO leases (property_id, unit_id, tenant_id, monthly_rent, rent_due_day, mtm_rent, deposit_amount,
                              start_date, end_date, notes, plan, status, updated_by, updated_at)
          VALUES (${propertyId}, ${unit.id}, ${tenantId}, ${fields.monthly_rent}, ${fields.rent_due_day ?? 1}, ${fields.mtm_rent},
                  ${fields.deposit_amount}, ${fields.start_date}::date, ${fields.end_date}::date, ${fields.notes}, ${fields.plan},
                  'active', ${who.actor}, now())
          RETURNING id`,
    ...(displayName ? [tx`UPDATE units SET current_tenant = ${displayName} WHERE id = ${unit.id}`] : []),
    tx`
      INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after, note)
      SELECT ${who.actor}, ${who.keyId}, ${who.source}, ${current && !newLease ? 'lease.update' : 'lease.create'}, 'leases',
             l.id, ${before}::jsonb, to_jsonb(l), ${unit.label}
      FROM leases l WHERE l.unit_id = ${unit.id} AND l.status = 'active'`,
  ])) as Row[][]
  void result
  refreshUi()
  const [lease] = (await listLeases({ propertyIds: [propertyId] })).filter((l) => l.unit_id === unit.id)
  return { lease, ended_previous: endOld ? current!.id : null }
}

export async function endLease(input: Input, who: Actor) {
  await ensureLeases()
  const id = reqInt(input, 'lease_id')
  const endedOn = optDate(input, 'ended_on') ?? new Date().toISOString().slice(0, 10)
  const clearTenant = optBool(input, 'unit_vacant') !== false
  const rows = (await sql`
    WITH b AS (SELECT * FROM leases WHERE id = ${id}),
    u AS (UPDATE leases SET status = 'ended', ended_on = ${endedOn}::date, updated_by = ${who.actor}, updated_at = now()
          WHERE id = ${id} AND status = 'active' RETURNING *),
    v AS (UPDATE units SET current_tenant = NULL WHERE ${clearTenant} AND id = (SELECT unit_id FROM u) RETURNING id),
    log AS (INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after)
            SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'lease.end', 'leases', u.id, (SELECT to_jsonb(b) FROM b), to_jsonb(u) FROM u)
    SELECT (SELECT count(*) FROM b)::int AS found, (SELECT count(*) FROM u)::int AS ended
  `) as { found: number; ended: number }[]
  if (!rows[0].found) throw notFound(`Lease ${id} not found.`)
  if (!rows[0].ended) throw conflict('already_ended', `Lease ${id} has already ended.`)
  refreshUi()
  return { lease_id: id, ended_on: endedOn, unit_marked_vacant: clearTenant }
}
