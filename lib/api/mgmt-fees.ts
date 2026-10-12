// lib/api/mgmt-fees.ts
// SLCM's monthly management fee and the owner-funds balance (lib/bookkeeping.ts).
//
//   post_management_fees  write: for each month, 20% of rent actually collected
//                         (by payment date, deposits and late fees excluded) at
//                         524, 6th St, Belford and 913. Each property-month is a
//                         pair of journal rows sharing transfer_group
//                         mgmtfee-YYYY-MM-<slug>: the property's Management Fee
//                         expense and SLCM's Management Fee Income. Re-running a
//                         month brings an existing pair to the right amount, so
//                         late or corrected rent is picked up. Never bank-matched.
//   get_owner_funds       read: what SLCM is holding for the owners of each property.
//   checkManagementFees   used by get_attention: unpaired legs and missing months.
import sql from '@/lib/db'
import { ensureBookkeeping, MGMT_FEE_PROPERTY_SLUGS, MGMT_FEE_RATE, OWNER_PERSONAL_METHOD, SLCM_SLUG } from '@/lib/bookkeeping'
import { badRequest, notFound } from './errors'
import { type Actor, refreshUi, isDateClosed } from './service'
import { type Input, optString, optBool, optDate } from './validate'

type Row = Record<string, unknown>
const pad = (n: number) => String(n).padStart(2, '0')

function monthEnd(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`
}
function monthsBetween(from: string, to: string) {
  const out: string[] = []
  let [y, m] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`)
    m++; if (m > 12) { m = 1; y++ }
  }
  return out
}
const thisMonth = () => new Date().toISOString().slice(0, 7)

async function slcmId(): Promise<number> {
  const r = (await sql`SELECT id FROM entities WHERE slug = ${SLCM_SLUG}`) as { id: number }[]
  if (!r[0]) throw notFound('SLCM entity not found.')
  return r[0].id
}

async function feeProperties() {
  return (await sql`
    SELECT id, slug, name FROM properties WHERE slug = ANY(${[...MGMT_FEE_PROPERTY_SLUGS]}::text[]) ORDER BY name
  `) as { id: number; slug: string; name: string }[]
}

/** Rent collected per fee property per month (cash basis, by payment date). */
async function rentCollected(propertyIds: number[], from: string, to: string) {
  return (await sql`
    SELECT property_id, to_char(txn_date, 'YYYY-MM') AS ym, SUM(amount)::float8 AS rent
    FROM transactions
    WHERE property_id = ANY(${propertyIds}::int[]) AND status = 'actual' AND type = 'income'
      AND category = 'Rental Income' AND COALESCE(is_deposit, FALSE) = FALSE
      AND txn_date BETWEEN ${from + '-01'}::date AND ${monthEnd(to)}::date
    GROUP BY property_id, ym
  `) as { property_id: number; ym: string; rent: number }[]
}

export async function postManagementFees(input: Input, who: Actor) {
  await ensureBookkeeping()
  const month = optString(input, 'month', 7)
  const through = optString(input, 'through', 7) ?? month
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !through || !/^\d{4}-(0[1-9]|1[0-2])$/.test(through)) {
    throw badRequest('month is required (YYYY-MM). Add through (YYYY-MM) to do a range.')
  }
  if (through < month) throw badRequest('through is before month.')
  if (through >= thisMonth()) throw badRequest(`${through} has not finished yet. Fees are posted once a month is over.`)
  const months = monthsBetween(month, through)
  if (months.length > 24) throw badRequest('At most 24 months per call.')
  const dryRun = optBool(input, 'dry_run') === true

  const slcm = await slcmId()
  const props = await feeProperties()
  const rents = await rentCollected(props.map((p) => p.id), month, through)
  const groups = months.flatMap((ym) => props.map((p) => `mgmtfee-${ym}-${p.slug}`))
  const existing = (await sql`
    SELECT id, transfer_group, property_id, entity_id, amount::float8 AS amount
    FROM transactions WHERE transfer_group = ANY(${groups}::text[]) AND status = 'actual'
  `) as { id: number; transfer_group: string; property_id: number | null; entity_id: number | null; amount: number }[]

  const results: Row[] = []
  for (const ym of months) {
    for (const p of props) {
      const group = `mgmtfee-${ym}-${p.slug}`
      const rent = Math.round((rents.find((r) => r.property_id === p.id && r.ym === ym)?.rent ?? 0) * 100) / 100
      const fee = Math.round(rent * MGMT_FEE_RATE * 100) / 100
      const legs = existing.filter((e) => e.transfer_group === group)
      const propLeg = legs.find((l) => l.property_id !== null)
      const slcmLeg = legs.find((l) => l.property_id === null)
      const date = monthEnd(ym)
      const base = { month: ym, property: p.name, rent_collected: rent, fee, transfer_group: group }

      let action: 'create' | 'update' | 'remove' | 'unchanged' | 'none'
      if (!legs.length) action = fee > 0 ? 'create' : 'none'
      else if (fee === 0) action = 'remove'
      else if (propLeg && slcmLeg && legs.length === 2 && propLeg.amount === fee && slcmLeg.amount === fee) action = 'unchanged'
      else action = 'update'

      if (action === 'none' || action === 'unchanged') { results.push({ ...base, action }); continue }
      if (await isDateClosed(p.id, date)) { results.push({ ...base, action: 'skipped_closed', note: `${date} is in a closed quarter for ${p.name}. Reopen it, run again, then close it.` }); continue }
      if (dryRun) { results.push({ ...base, action: `would_${action}` }); continue }

      const propDesc = `SLCM management fee, 20% of ${ym} rent collected`
      const slcmDesc = `Management fee from ${p.name}, ${ym}`
      await sql.transaction((tx) => [
        // Replace whatever is there with exactly one correct pair.
        tx`
          WITH del AS (DELETE FROM transactions WHERE transfer_group = ${group} AND status = 'actual'
                       AND NOT EXISTS (SELECT 1 FROM bank_txn_legs l WHERE l.transaction_id = transactions.id)
                       RETURNING *)
          INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, note)
          SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'mgmtfee.replace', 'transactions', del.id, to_jsonb(del), ${group} FROM del`,
        ...(action === 'remove' ? [] : [
          tx`
            WITH ins AS (
              INSERT INTO transactions (property_id, entity_id, type, category, amount, txn_date, rental_period,
                                        status, method, description, transfer_group, created_by)
              SELECT ${p.id}::int, pr.entity_id, 'expense', 'Management Fee', ${fee}::numeric, ${date}::date, ${ym}::text,
                     'actual', 'journal', ${propDesc}, ${group}, ${who.actor}
              FROM properties pr WHERE pr.id = ${p.id}
              UNION ALL
              SELECT NULL::int, ${slcm}::int, 'income', 'Management Fee Income', ${fee}::numeric, ${date}::date, NULL::text,
                     'actual', 'journal', ${slcmDesc}, ${group}, ${who.actor}
              RETURNING *)
            INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after, note)
            SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'mgmtfee.post', 'transactions', ins.id, to_jsonb(ins), ${group} FROM ins`,
        ]),
      ])
      results.push({ ...base, action })
    }
  }
  if (!dryRun) refreshUi()
  const posted = results.filter((r) => ['create', 'update', 'remove'].includes(String(r.action)))
  return {
    rate: MGMT_FEE_RATE, months, dry_run: dryRun,
    total_fee: Math.round(results.reduce((t, r) => t + Number(r.fee || 0), 0) * 100) / 100,
    changed: posted.length,
    skipped_closed: results.filter((r) => r.action === 'skipped_closed').length,
    results,
    check: await checkManagementFees(),
  }
}

/** Pairs whose two legs differ or are missing, and completed months with rent but no fee. */
export async function checkManagementFees(year = new Date().getFullYear()) {
  const unpaired = (await sql`
    SELECT transfer_group,
           COALESCE(SUM(amount) FILTER (WHERE property_id IS NOT NULL), 0)::float8 AS property_leg,
           COALESCE(SUM(amount) FILTER (WHERE property_id IS NULL), 0)::float8 AS slcm_leg,
           COUNT(*)::int AS rows
    FROM transactions
    WHERE transfer_group LIKE 'mgmtfee-%' AND status = 'actual'
    GROUP BY transfer_group
    HAVING COALESCE(SUM(amount) FILTER (WHERE property_id IS NOT NULL), 0) <> COALESCE(SUM(amount) FILTER (WHERE property_id IS NULL), 0)
        OR COUNT(*) <> 2
  `) as Row[]
  const props = await feeProperties()
  const last = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7) })()
  const missing: { month: string; property: string; rent_collected: number }[] = []
  if (props.length && last >= `${year}-01`) {
    const rents = await rentCollected(props.map((p) => p.id), `${year}-01`, last)
    const have = new Set(((await sql`
      SELECT DISTINCT transfer_group FROM transactions WHERE transfer_group LIKE ${`mgmtfee-${year}-%`} AND status = 'actual'
    `) as { transfer_group: string }[]).map((r) => r.transfer_group))
    for (const r of rents) {
      const p = props.find((x) => x.id === r.property_id)!
      if (r.rent > 0 && !have.has(`mgmtfee-${r.ym}-${p.slug}`)) missing.push({ month: r.ym, property: p.name, rent_collected: r.rent })
    }
  }
  return { unpaired, missing_months: missing.sort((a, b) => a.month.localeCompare(b.month)) }
}

/**
 * Owner funds: what SLCM is holding for the owners of each fee property, from a
 * starting date (opening balance taken as zero):
 *   rent collected − management fee − property expenses SLCM paid − cash sent to owners
 * Rows paid from the owner's personal account are left out (SLCM never held that cash).
 * Security deposits are shown separately: they belong to tenants.
 */
export async function getOwnerFunds(input: Input) {
  await ensureBookkeeping()
  const from = optDate(input, 'from') ?? `${new Date().getFullYear()}-01-01`
  const to = optDate(input, 'to') ?? new Date().toISOString().slice(0, 10)
  if (to < from) throw badRequest('to is before from.')
  const props = await feeProperties()
  const rows = (await sql`
    SELECT t.property_id,
      COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'income' AND NOT COALESCE(t.is_deposit, FALSE)), 0)::float8 AS income,
      COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense' AND t.category = 'Management Fee' AND t.transfer_group LIKE 'mgmtfee-%'), 0)::float8 AS fee,
      COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense' AND NOT COALESCE(t.is_deposit, FALSE)
                                     AND NOT (t.category = 'Management Fee' AND t.transfer_group LIKE 'mgmtfee-%')), 0)::float8 AS expenses,
      COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE -t.amount END) FILTER (WHERE COALESCE(t.is_deposit, FALSE)), 0)::float8 AS deposits
    FROM transactions t
    WHERE t.property_id = ANY(${props.map((p) => p.id)}::int[]) AND t.status = 'actual'
      AND t.txn_date BETWEEN ${from}::date AND ${to}::date
      AND COALESCE(t.method, '') <> ${OWNER_PERSONAL_METHOD}
    GROUP BY t.property_id
  `) as { property_id: number; income: number; fee: number; expenses: number; deposits: number }[]
  const dist = (await sql`
    SELECT property_id, COALESCE(SUM(amount), 0)::float8 AS paid FROM distributions
    WHERE property_id = ANY(${props.map((p) => p.id)}::int[]) AND distributed_on BETWEEN ${from}::date AND ${to}::date
    GROUP BY property_id
  `) as { property_id: number; paid: number }[]
  const r2 = (n: number) => Math.round(n * 100) / 100
  const properties = props.map((p) => {
    const r = rows.find((x) => x.property_id === p.id) ?? { income: 0, fee: 0, expenses: 0, deposits: 0 }
    const sent = dist.find((d) => d.property_id === p.id)?.paid ?? 0
    const held = r2(r.income - r.fee - r.expenses - sent)
    return {
      property: p.name, rent_and_other_income: r2(r.income), management_fee: r2(r.fee),
      expenses_paid_by_slcm: r2(r.expenses), sent_to_owners: r2(sent), held_for_owners: held,
      deposits_held_for_tenants: r2(r.deposits),
      flag: held < 0 ? 'Negative: SLCM has paid out more than it collected. Either a posting error, or SLCM is funding the property, which needs recording as such.' : null,
    }
  })
  return {
    from, to, opening_balance_assumed: 0,
    properties,
    total_held_for_owners: r2(properties.reduce((t, p) => t + p.held_for_owners, 0)),
    note: `Rows paid from the owner's personal account are excluded. Opening balances before ${from} are not included.`,
  }
}

