// lib/api/media.ts
// Bot tools for SL Media's publications (see lib/media.ts for the model).
//
//   get_media_ledger       read: balances, months, years, next payments
//   post_media_bank_txn    write: one bank line → the media ledger AND SL Media's
//                          books in one call (revenue → Subscription Revenue,
//                          payment to Matt → Licensing Fees, royalty moved to
//                          SL Holdings → excluded from the books as an owner
//                          distribution). If the line is already in the media
//                          ledger (typed in from the spreadsheet) it is linked,
//                          not added twice.
//   record_media_entries   write: entries with no bank line (history, or money
//                          that went to personal checking)
//   void_media_entry       write: remove a mistaken entry that has no bank line
import sql from '@/lib/db'
import { ensureMedia, getProduct, listProducts, productLedger, SOURCE_LABEL, type Product } from '@/lib/media'
import { badRequest, conflict, notFound } from './errors'
import { type Actor, refreshUi } from './service'
import { postBankTxn, excludeBankTxn, revertBankTxn, bankResult } from './bank-post'
import { type Input, reqInt, optInt, optString, optBool, optEnum, clampInt, reqDate, reqAmount } from './validate'

type Row = Record<string, unknown>

async function reqProduct(input: Input, dflt = 'tct'): Promise<Product> {
  const slug = optString(input, 'product', 40) ?? dflt
  const p = await getProduct(slug)
  if (!p) throw notFound(`Unknown product "${slug}". Products: tct (The Coal Trader), ree (The REE Trader).`)
  return p
}

function optPeriod(input: Input): string | null {
  const p = optString(input, 'period', 7)
  if (p && !/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) throw badRequest('period must look like 2026-09 (the revenue month).')
  return p
}

// ─── read ────────────────────────────────────────────────────────────────────

export async function getMediaLedger(input: Input) {
  const product = await reqProduct(input)
  const months = clampInt(input, 'months', 12, 1, 120)
  const r = (await productLedger(product.slug))!
  const L = r.ledger
  return {
    product: { slug: product.slug, name: product.name, owner_pct: product.owner_pct, partner: product.partner_name, owner_destination: product.owner_destination },
    balances: {
      owed_to_partner: L.totals.partnerDue,
      royalty_not_yet_moved: L.totals.ownerDue,
      partner_overpaid_credit: L.partnerCredit,
      owner_overmoved_credit: L.ownerCredit,
    },
    next_partner_payments: L.nextPartnerPayments,
    totals: L.totals,
    years: L.years,
    months: L.months.slice(0, months).map((m) => ({
      period: m.period, gross: m.gross, by_source: m.bySource,
      partner: { share: m.partner.share, paid: m.partner.paid, due: m.partner.due },
      owner: { share: m.owner.share, paid: m.owner.paid, due: m.owner.due },
      deposits: m.receipts.map((x) => ({ id: x.id, date: x.date, source: x.source, amount: x.amount, bank_txn_id: x.bank_txn_id })),
    })),
    not_tied_to_bank: L.unlinked,
    hints: {
      owed_to_partner: `Pay in pieces of at most $10,000 (next_partner_payments). Each Zelle to Seawolf is posted with post_media_bank_txn kind pay_partner once it shows in the bank.`,
      royalty_not_yet_moved: 'SL Media\'s share that has not been moved to SL Holdings yet. Each transfer is posted with kind pay_owner.',
    },
  }
}

// ─── bank → media + books ───────────────────────────────────────────────────

const KINDS = ['substack', 'website', 'ree', 'pay_partner', 'pay_owner'] as const
type Kind = (typeof KINDS)[number]

export async function postMediaBankTxn(input: Input, who: Actor) {
  await ensureMedia()
  const bankId = reqInt(input, 'bank_txn_id')
  const kind = optEnum(input, 'kind', KINDS)
  if (!kind) throw badRequest(`kind is required: ${KINDS.join(', ')}.`)
  const product = await reqProduct(input, kind === 'ree' ? 'ree' : 'tct')
  if (!product.entity_id) throw conflict('no_entity', `${product.name} is not tied to SL Media's books.`)

  const bankRows = (await sql`
    SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS date, amount::float8 AS amount, status, name_norm
    FROM bank_txns WHERE id = ${bankId}
  `) as { id: number; date: string; amount: number; status: string; name_norm: string }[]
  const bank = bankRows[0]
  if (!bank) throw notFound(`Bank row ${bankId} not found.`)
  if (bank.status !== 'pending') throw conflict('already_resolved', `Bank row ${bankId} is already ${bank.status}.`)
  const isReceipt = kind === 'substack' || kind === 'website' || kind === 'ree'
  if (isReceipt && bank.amount <= 0) throw badRequest(`Bank row ${bankId} is money out; ${kind} is money in.`)
  if (!isReceipt && bank.amount >= 0) throw badRequest(`Bank row ${bankId} is money in; ${kind} is money out.`)
  const amount = Math.abs(bank.amount)
  const source = kind === 'ree' ? 'seawolf' : kind
  const payee = kind === 'pay_partner' ? 'partner' : 'owner'
  const period = optPeriod(input) ?? bank.date.slice(0, 7)
  const destination = optString(input, 'destination', 100) ?? (kind === 'pay_partner' ? 'Seawolf Research (Zelle)' : product.owner_destination)
  const linkId = optInt(input, 'link_entry_id')
  const createNew = optBool(input, 'create_new') === true
  if (isReceipt && !product.sources.includes(source)) throw badRequest(`${product.name} doesn't take ${source} deposits.`)
  if (kind === 'pay_partner' && !product.partner_name) throw badRequest(`${product.name} has no partner to pay.`)

  // 1. Is this money already in the media ledger (typed in from the spreadsheet)?
  const table = isReceipt ? 'receipt' : 'payout'
  let linkTo: Row | null = null
  if (linkId) {
    const r = isReceipt
      ? ((await sql`SELECT id, amount::float8 AS amount, bank_txn_id FROM media_receipts WHERE id = ${linkId} AND product_id = ${product.id} AND source = ${source}`) as Row[])
      : ((await sql`SELECT id, amount::float8 AS amount, bank_txn_id FROM media_payouts WHERE id = ${linkId} AND product_id = ${product.id} AND payee = ${payee}`) as Row[])
    if (!r[0]) throw notFound(`No ${product.slug} ${table} ${linkId} of that kind.`)
    if (r[0].bank_txn_id) throw conflict('already_linked', `Entry ${linkId} is already tied to bank row ${r[0].bank_txn_id}.`)
    linkTo = r[0]
  } else {
    const exact = isReceipt
      ? ((await sql`
          SELECT id, amount::float8 AS amount, to_char(received_on, 'YYYY-MM-DD') AS date FROM media_receipts
          WHERE product_id = ${product.id} AND source = ${source} AND bank_txn_id IS NULL AND amount = ${amount}
            AND abs(received_on - ${bank.date}::date) <= 21
          ORDER BY abs(received_on - ${bank.date}::date), id LIMIT 1`) as Row[])
      : ((await sql`
          SELECT id, amount::float8 AS amount, to_char(paid_on, 'YYYY-MM-DD') AS date FROM media_payouts
          WHERE product_id = ${product.id} AND payee = ${payee} AND bank_txn_id IS NULL AND amount = ${amount}
            AND abs(paid_on - ${bank.date}::date) <= 21
          ORDER BY abs(paid_on - ${bank.date}::date), id LIMIT 1`) as Row[])
    if (exact[0]) linkTo = exact[0]
    else if (!createNew) {
      const near = isReceipt
        ? ((await sql`
            SELECT id, amount::float8 AS amount, to_char(received_on, 'YYYY-MM-DD') AS date, period, origin FROM media_receipts
            WHERE product_id = ${product.id} AND source = ${source} AND bank_txn_id IS NULL
              AND abs(received_on - ${bank.date}::date) <= 45 ORDER BY received_on`) as Row[])
        : ((await sql`
            SELECT id, amount::float8 AS amount, to_char(paid_on, 'YYYY-MM-DD') AS date, origin FROM media_payouts
            WHERE product_id = ${product.id} AND payee = ${payee} AND bank_txn_id IS NULL
              AND abs(paid_on - ${bank.date}::date) <= 45 ORDER BY paid_on`) as Row[])
      if (near.length) {
        throw conflict('check_existing',
          `There are ${near.length} ${table}(s) near ${bank.date} not yet tied to the bank, but none for exactly $${amount.toFixed(2)}. ` +
          'If one of them is this money, resend with link_entry_id (its amount is corrected to the bank). If this is new money, resend with create_new: true.',
          { candidates: near })
      }
    }
  }

  // 2. SL Media's books: revenue and partner payments are posted; royalty moves are excluded.
  const label = isReceipt ? `${product.name}: ${SOURCE_LABEL[source] ?? source}` : `${product.name}: ${kind === 'pay_partner' ? 'payment to ' + product.partner_name : 'royalty to ' + destination}`
  if (kind === 'pay_owner') {
    await excludeBankTxn({ bank_txn_id: bankId, reason: `Owner distribution: ${product.name} royalty to ${destination}` }, who)
  } else {
    const category = kind === 'pay_partner' ? 'Licensing Fees' : kind === 'ree' ? 'Royalty Income' : 'Subscription Revenue'
    await postBankTxn({ bank_txn_id: bankId, legs: [{ entity_id: product.entity_id, category, description: label }] }, who)
  }

  // 3. The media ledger. If this fails, put the bank row back so nothing is half-done.
  try {
    let entryId: number
    if (linkTo) {
      entryId = Number(linkTo.id)
      const before = JSON.stringify(linkTo)
      if (isReceipt) {
        await sql`
          WITH u AS (
            UPDATE media_receipts SET bank_txn_id = ${bankId}, amount = ${amount}::numeric, received_on = ${bank.date}::date,
                   note = CASE WHEN amount <> ${amount}::numeric THEN concat_ws(' ', note, ${`(was $${Number(linkTo.amount).toFixed(2)} in the sheet)`}::text) ELSE note END
            WHERE id = ${entryId} AND bank_txn_id IS NULL RETURNING *)
          INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after, note)
          SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'media.link', 'media_receipts', u.id, ${before}::jsonb, to_jsonb(u), ${String(bankId)}::text FROM u`
      } else {
        await sql`
          WITH u AS (
            UPDATE media_payouts SET bank_txn_id = ${bankId}, amount = ${amount}::numeric, paid_on = ${bank.date}::date,
                   note = CASE WHEN amount <> ${amount}::numeric THEN concat_ws(' ', note, ${`(was $${Number(linkTo.amount).toFixed(2)} in the sheet)`}::text) ELSE note END
            WHERE id = ${entryId} AND bank_txn_id IS NULL RETURNING *)
          INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after, note)
          SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'media.link', 'media_payouts', u.id, ${before}::jsonb, to_jsonb(u), ${String(bankId)}::text FROM u`
      }
    } else {
      const rows = isReceipt
        ? ((await sql`
            WITH i AS (
              INSERT INTO media_receipts (product_id, source, amount, received_on, period, bank_txn_id, origin, note, created_by)
              VALUES (${product.id}, ${source}, ${amount}, ${bank.date}::date, ${period}, ${bankId}, 'bank', ${bank.name_norm}, ${who.actor})
              RETURNING *), l AS (
              INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after)
              SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'media.record', 'media_receipts', i.id, to_jsonb(i) FROM i)
            SELECT id FROM i`) as Row[])
        : ((await sql`
            WITH i AS (
              INSERT INTO media_payouts (product_id, payee, amount, paid_on, destination, bank_txn_id, origin, note, created_by)
              VALUES (${product.id}, ${payee}, ${amount}, ${bank.date}::date, ${destination}, ${bankId}, 'bank', ${bank.name_norm}, ${who.actor})
              RETURNING *), l AS (
              INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after)
              SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'media.record', 'media_payouts', i.id, to_jsonb(i) FROM i)
            SELECT id FROM i`) as Row[])
      entryId = Number(rows[0].id)
    }
    refreshUi()
    const L = (await productLedger(product.slug))!.ledger
    return {
      bank: await bankResult(bankId),
      media: { product: product.slug, [table]: entryId, linked_existing: !!linkTo, period: isReceipt ? period : undefined },
      balances: { owed_to_partner: L.totals.partnerDue, royalty_not_yet_moved: L.totals.ownerDue },
    }
  } catch (e) {
    await revertBankTxn({ bank_txn_id: bankId }, who).catch(() => {})
    throw e
  }
}

// ─── entries with no bank line ───────────────────────────────────────────────

export async function recordMediaEntries(input: Input, who: Actor) {
  await ensureMedia()
  const product = await reqProduct(input)
  const origin = optEnum(input, 'origin', ['sheet', 'manual'] as const) ?? 'manual'
  const raw = Array.isArray(input.entries) ? (input.entries as Input[]) : null
  if (!raw || !raw.length) throw badRequest('entries is required: [{ kind: "receipt"|"payout", ... }].')
  if (raw.length > 400) throw badRequest('At most 400 entries per call.')

  type E = { kind: 'receipt' | 'payout'; source?: string; payee?: 'partner' | 'owner'; amount: number; date: string; period?: string; destination?: string | null; note: string | null; key: string | null }
  const entries: E[] = raw.map((e, i) => {
    if (!e || typeof e !== 'object') throw badRequest(`entries[${i}] must be an object.`)
    const kind = optEnum(e, 'kind', ['receipt', 'payout'] as const)
    if (!kind) throw badRequest(`entries[${i}].kind must be receipt or payout.`)
    const amount = reqAmount(e, 'amount')
    const date = reqDate(e, 'date')
    const note = optString(e, 'note', 300)
    const key = optString(e, 'import_key', 100)
    if (kind === 'receipt') {
      const source = optString(e, 'source', 20)
      if (!source || !product.sources.includes(source)) throw badRequest(`entries[${i}].source must be one of ${product.sources.join(', ')}.`)
      const period = optPeriod(e) ?? date.slice(0, 7)
      return { kind, source, amount, date, period, note, key }
    }
    const payee = optEnum(e, 'payee', ['partner', 'owner'] as const)
    if (!payee) throw badRequest(`entries[${i}].payee must be partner or owner.`)
    return { kind, payee, amount, date, destination: optString(e, 'destination', 100) ?? (payee === 'partner' ? 'Seawolf Research (Zelle)' : product.owner_destination), note, key }
  })

  const results = (await sql.transaction((tx) => [
    ...entries.map((e) => e.kind === 'receipt'
      ? tx`INSERT INTO media_receipts (product_id, source, amount, received_on, period, origin, import_key, note, created_by)
           VALUES (${product.id}, ${e.source!}, ${e.amount}, ${e.date}::date, ${e.period!}, ${origin}, ${e.key}, ${e.note}, ${who.actor})
           ON CONFLICT (import_key) DO NOTHING RETURNING id`
      : tx`INSERT INTO media_payouts (product_id, payee, amount, paid_on, destination, origin, import_key, note, created_by)
           VALUES (${product.id}, ${e.payee!}, ${e.amount}, ${e.date}::date, ${e.destination ?? null}, ${origin}, ${e.key}, ${e.note}, ${who.actor})
           ON CONFLICT (import_key) DO NOTHING RETURNING id`),
    tx`INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, after, note)
       VALUES (${who.actor}, ${who.keyId}, ${who.source}, 'media.record_entries', 'media_products', ${product.id},
               ${JSON.stringify({ origin, entries })}::jsonb, ${`${entries.length} entries`})`,
  ])) as Row[][]
  const created = results.slice(0, entries.length).filter((r) => r.length).length
  refreshUi()
  const L = (await productLedger(product.slug))!.ledger
  return {
    product: product.slug, sent: entries.length, created, skipped_already_recorded: entries.length - created,
    balances: { owed_to_partner: L.totals.partnerDue, royalty_not_yet_moved: L.totals.ownerDue },
  }
}

export async function voidMediaEntry(input: Input, who: Actor) {
  await ensureMedia()
  const kind = optEnum(input, 'kind', ['receipt', 'payout'] as const)
  if (!kind) throw badRequest('kind must be receipt or payout.')
  const id = reqInt(input, 'id')
  if (optBool(input, 'confirm') !== true) throw conflict('needs_confirmation', 'Resend with confirm: true once David agrees this entry is wrong.')
  const reason = optString(input, 'reason', 300)
  if (!reason) throw badRequest('reason is required.')
  const rows = kind === 'receipt'
    ? ((await sql`
        WITH t AS (SELECT * FROM media_receipts WHERE id = ${id}),
        del AS (DELETE FROM media_receipts WHERE id = ${id} AND bank_txn_id IS NULL RETURNING *),
        log AS (INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, note)
                SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'media.void', 'media_receipts', del.id, to_jsonb(del), ${reason} FROM del)
        SELECT (SELECT bank_txn_id FROM t) AS bank, (SELECT count(*) FROM t)::int AS found, (SELECT count(*) FROM del)::int AS gone`) as Row[])
    : ((await sql`
        WITH t AS (SELECT * FROM media_payouts WHERE id = ${id}),
        del AS (DELETE FROM media_payouts WHERE id = ${id} AND bank_txn_id IS NULL RETURNING *),
        log AS (INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, note)
                SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'media.void', 'media_payouts', del.id, to_jsonb(del), ${reason} FROM del)
        SELECT (SELECT bank_txn_id FROM t) AS bank, (SELECT count(*) FROM t)::int AS found, (SELECT count(*) FROM del)::int AS gone`) as Row[])
  const r = rows[0]
  if (!r.found) throw notFound(`No ${kind} ${id}.`)
  if (!r.gone) throw conflict('bank_reconciled', `This ${kind} is tied to bank row ${r.bank}. Use revert_bank_txn on that row instead.`)
  refreshUi()
  return { voided: true, kind, id, reason }
}


// ─── corrections ─────────────────────────────────────────────────────────────

/**
 * Correct labels on existing entries: source and revenue month on deposits,
 * destination on payments, and the note on either. Amounts and dates are not
 * editable here; they come from the bank (or void and re-record a sheet row).
 */
export async function updateMediaEntries(input: Input, who: Actor) {
  await ensureMedia()
  const raw = Array.isArray(input.entries) ? (input.entries as Input[]) : null
  if (!raw || !raw.length) throw badRequest('entries is required: [{ kind, id, source?, period?, destination?, note? }].')
  if (raw.length > 400) throw badRequest('At most 400 entries per call.')
  const products = new Map((await listProducts()).map((p) => [p.id, p]))
  const stmts: { kind: 'receipt' | 'payout'; id: number; source: string | null; period: string | null; destination: string | null; note: string | null; hasNote: boolean }[] = []
  for (const [i, e] of raw.entries()) {
    const kind = optEnum(e, 'kind', ['receipt', 'payout'] as const)
    if (!kind) throw badRequest(`entries[${i}].kind must be receipt or payout.`)
    const id = reqInt(e, 'id')
    const source = optString(e, 'source', 20)
    const period = optPeriod(e)
    const destination = optString(e, 'destination', 100)
    const hasNote = Object.prototype.hasOwnProperty.call(e, 'note')
    const note = optString(e, 'note', 300)
    if (kind === 'payout' && (source || period)) throw badRequest(`entries[${i}]: payments have no source or period.`)
    if (kind === 'receipt' && destination) throw badRequest(`entries[${i}]: deposits have no destination.`)
    if (source) {
      const row = (await sql`SELECT product_id FROM media_receipts WHERE id = ${id}`) as { product_id: number }[]
      if (!row[0]) throw notFound(`No receipt ${id}.`)
      if (!products.get(row[0].product_id)?.sources.includes(source)) throw badRequest(`entries[${i}]: ${source} is not a source for that product.`)
    }
    stmts.push({ kind, id, source, period, destination, note, hasNote })
  }
  const res = (await sql.transaction((tx) => stmts.map((s) => s.kind === 'receipt'
    ? tx`
        WITH b AS (SELECT * FROM media_receipts WHERE id = ${s.id}),
        u AS (UPDATE media_receipts SET source = COALESCE(${s.source}, source), period = COALESCE(${s.period}, period),
                     note = CASE WHEN ${s.hasNote} THEN ${s.note} ELSE note END
              WHERE id = ${s.id} RETURNING *),
        l AS (INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after)
              SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'media.update', 'media_receipts', u.id, (SELECT to_jsonb(b) FROM b), to_jsonb(u) FROM u)
        SELECT id FROM u`
    : tx`
        WITH b AS (SELECT * FROM media_payouts WHERE id = ${s.id}),
        u AS (UPDATE media_payouts SET destination = COALESCE(${s.destination}, destination),
                     note = CASE WHEN ${s.hasNote} THEN ${s.note} ELSE note END
              WHERE id = ${s.id} RETURNING *),
        l AS (INSERT INTO mutations_log (actor, api_key_id, source, action, target_table, target_id, before, after)
              SELECT ${who.actor}, ${who.keyId}, ${who.source}, 'media.update', 'media_payouts', u.id, (SELECT to_jsonb(b) FROM b), to_jsonb(u) FROM u)
        SELECT id FROM u`))) as Row[][]
  const missing = stmts.filter((_, i) => !res[i].length).map((s) => `${s.kind} ${s.id}`)
  if (missing.length) return { updated: stmts.length - missing.length, not_found: missing }
  refreshUi()
  return { updated: stmts.length }
}
