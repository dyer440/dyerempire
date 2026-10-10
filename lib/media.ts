// lib/media.ts
// SL Media's publications (The Coal Trader, The REE Trader, later FuseTrader).
//
// The Coal Trader arrangement: subscriber money from Substack and from
// thecoaltrader.com lands in SL Media's checking account. 87.5% of it belongs
// to Seawolf Research LLC (Matt Warder), paid by Zelle in pieces of up to
// $10,000. SL Media keeps a 12.5% royalty, which David moves to SL Holdings.
//
// Three tables, all owned by this module and created on first use:
//   media_products   one row per publication, with SL Media's percentage
//   media_receipts   each deposit (source, amount, date, revenue month)
//   media_payouts    each payment out: to the partner (Matt) or to the owner
//                    side (SL Holdings, or wherever the royalty went)
// Rows may be tied to a bank line (bank_txn_id). Rows typed in from the old
// spreadsheet carry origin 'sheet' and get tied to the bank when the bank
// export catches up.
//
// The money math is all here (computeLedger), so the page and the bots agree:
//   partner share of a month = round(gross x partner %, cents); owner share = the rest
//   payments are applied oldest month first (FIFO), so "still owed" never
//   depends on which month a payment was labelled with.
import sql from './db'

let ready: Promise<void> | null = null

export const MEDIA_ENTITY_SLUG = 'sl-media'
/** Largest single payment to the partner (Zelle limit). */
export const PAYMENT_LIMIT = 10000

export function ensureMedia(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS media_products (
          id SERIAL PRIMARY KEY,
          slug TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          entity_id INTEGER REFERENCES entities(id),
          owner_pct NUMERIC(6,3) NOT NULL,
          partner_name TEXT,
          owner_destination TEXT,
          sources TEXT NOT NULL DEFAULT 'other',
          sort_order INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`
      await sql`
        CREATE TABLE IF NOT EXISTS media_receipts (
          id SERIAL PRIMARY KEY,
          product_id INTEGER NOT NULL REFERENCES media_products(id),
          source TEXT NOT NULL,
          amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
          received_on DATE NOT NULL,
          period TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
          bank_txn_id INTEGER UNIQUE,
          origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('sheet', 'bank', 'manual')),
          import_key TEXT UNIQUE,
          note TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`
      await sql`
        CREATE TABLE IF NOT EXISTS media_payouts (
          id SERIAL PRIMARY KEY,
          product_id INTEGER NOT NULL REFERENCES media_products(id),
          payee TEXT NOT NULL CHECK (payee IN ('partner', 'owner')),
          amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
          paid_on DATE NOT NULL,
          destination TEXT,
          bank_txn_id INTEGER UNIQUE,
          origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('sheet', 'bank', 'manual')),
          import_key TEXT UNIQUE,
          note TEXT,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`
      await sql`CREATE INDEX IF NOT EXISTS media_receipts_product_idx ON media_receipts (product_id, period)`
      await sql`CREATE INDEX IF NOT EXISTS media_payouts_product_idx ON media_payouts (product_id, paid_on)`
      await sql`
        INSERT INTO media_products (slug, name, entity_id, owner_pct, partner_name, owner_destination, sources, sort_order)
        SELECT v.slug, v.name, (SELECT id FROM entities WHERE slug = ${MEDIA_ENTITY_SLUG}), v.pct, v.partner, v.dest, v.sources, v.ord
        FROM (VALUES
          ('tct', 'The Coal Trader', 12.5::numeric, 'Seawolf Research LLC (Matt Warder)', 'SL Holdings', 'substack,website', 1),
          ('ree', 'The REE Trader', 100::numeric, NULL, 'SL Holdings', 'seawolf', 2)
        ) AS v(slug, name, pct, partner, dest, sources, ord)
        ON CONFLICT (slug) DO NOTHING`
      // SL Media's checking account at US Bank (ending 3758), so GrokBot can
      // import its CSV. The id sequence is synced first: the original account
      // was inserted with an explicit id, which left the sequence behind.
      try {
        await sql`SELECT setval(pg_get_serial_sequence('bank_accounts', 'id'), GREATEST((SELECT max(id) FROM bank_accounts), 1))`
        await sql`
          INSERT INTO bank_accounts (name, entity_id, last4, csv_format)
          SELECT 'US Bank SL Media Checking', e.id, '3758', 'usbank' FROM entities e
          WHERE e.slug = ${MEDIA_ENTITY_SLUG}
            AND NOT EXISTS (SELECT 1 FROM bank_accounts WHERE name = 'US Bank SL Media Checking')`
      } catch (e) {
        console.error('[media] could not create the SL Media bank account:', e)
      }
      // Ledger categories for SL Media's own books. lib/api/service.ts also
      // accepts these as system categories if this insert can't run.
      try {
        await sql`
          INSERT INTO categories (name, kind, sort_order)
          VALUES ('Subscription Revenue', 'income', 50), ('Royalty Income', 'income', 51), ('Licensing Fees', 'expense', 150)
          ON CONFLICT (name) DO NOTHING`
      } catch { /* categories table absent (tests); the service falls back */ }
    })().catch((e) => { ready = null; throw e })
  }
  return ready
}

export const SOURCE_LABEL: Record<string, string> = {
  substack: 'Substack',
  website: 'thecoaltrader.com',
  seawolf: 'Seawolf Research',
  other: 'Other',
}

export type Product = {
  id: number; slug: string; name: string; owner_pct: number; partner_name: string | null
  owner_destination: string | null; sources: string[]; entity_id: number | null
}

export async function listProducts(): Promise<Product[]> {
  await ensureMedia()
  const rows = (await sql`
    SELECT id, slug, name, owner_pct::float8 AS owner_pct, partner_name, owner_destination, sources, entity_id
    FROM media_products WHERE status = 'active' ORDER BY sort_order, id
  `) as (Omit<Product, 'sources'> & { sources: string })[]
  return rows.map((r) => ({ ...r, sources: r.sources.split(',').map((s) => s.trim()).filter(Boolean) }))
}

export async function getProduct(slug: string): Promise<Product | null> {
  return (await listProducts()).find((p) => p.slug === slug) ?? null
}

export type Receipt = {
  id: number; source: string; amount: number; date: string; period: string
  bank_txn_id: number | null; origin: string; note: string | null
}
export type Payout = {
  id: number; payee: 'partner' | 'owner'; amount: number; date: string; destination: string | null
  bank_txn_id: number | null; origin: string; note: string | null
}

export async function loadEntries(productId: number): Promise<{ receipts: Receipt[]; payouts: Payout[] }> {
  await ensureMedia()
  const receipts = (await sql`
    SELECT id, source, amount::float8 AS amount, to_char(received_on, 'YYYY-MM-DD') AS date, period,
           bank_txn_id, origin, note
    FROM media_receipts WHERE product_id = ${productId} ORDER BY received_on, id
  `) as Receipt[]
  const payouts = (await sql`
    SELECT id, payee, amount::float8 AS amount, to_char(paid_on, 'YYYY-MM-DD') AS date, destination,
           bank_txn_id, origin, note
    FROM media_payouts WHERE product_id = ${productId} ORDER BY paid_on, id
  `) as Payout[]
  return { receipts, payouts }
}

// ---------------------------------------------------------------------------
// The math
// ---------------------------------------------------------------------------

const c = (n: number) => Math.round(n * 100) // to cents
const d = (n: number) => n / 100 // to dollars

export type Applied = { payoutId: number; date: string; amount: number; applied: number; destination: string | null }
export type Side = { share: number; paid: number; due: number; payments: Applied[] }
export type Month = {
  period: string
  bySource: Record<string, number>
  receipts: Receipt[]
  gross: number
  partner: Side
  owner: Side
}
export type Ledger = {
  months: Month[] // newest first
  totals: {
    gross: number
    partnerShare: number; partnerPaid: number; partnerDue: number
    ownerShare: number; ownerPaid: number; ownerDue: number
  }
  /** Payments made beyond everything owed so far (applied to future months). */
  partnerCredit: number
  ownerCredit: number
  years: { year: number; received: number; partnerPaid: number; ownerPaid: number; receiptsBySource: Record<string, number> }[]
  /** How the current partner balance would go out under the payment limit. */
  nextPartnerPayments: number[]
  unlinked: { receipts: number; payouts: number }
}

export function computeLedger(ownerPct: number, receipts: Receipt[], payouts: Payout[]): Ledger {
  const partnerPct = 100 - ownerPct
  const byPeriod = new Map<string, Receipt[]>()
  for (const r of receipts) {
    const list = byPeriod.get(r.period) ?? []
    list.push(r)
    byPeriod.set(r.period, list)
  }
  const periods = [...byPeriod.keys()].sort()

  const months: Month[] = periods.map((period) => {
    const rs = byPeriod.get(period)!
    const bySourceC: Record<string, number> = {}
    let grossC = 0
    for (const r of rs) {
      bySourceC[r.source] = (bySourceC[r.source] || 0) + c(r.amount)
      grossC += c(r.amount)
    }
    const partnerC = Math.round((grossC * partnerPct) / 100)
    const ownerC = grossC - partnerC
    const bySource: Record<string, number> = {}
    for (const [k, v] of Object.entries(bySourceC)) bySource[k] = d(v)
    return {
      period, receipts: rs, bySource, gross: d(grossC),
      partner: { share: d(partnerC), paid: 0, due: d(partnerC), payments: [] },
      owner: { share: d(ownerC), paid: 0, due: d(ownerC), payments: [] },
    }
  })

  const allocate = (side: 'partner' | 'owner') => {
    const queue = payouts.filter((p) => p.payee === side).map((p) => ({ p, leftC: c(p.amount) }))
    let qi = 0
    for (const m of months) {
      let dueC = c(m[side].share)
      let paidC = 0
      while (dueC > 0 && qi < queue.length) {
        const q = queue[qi]
        const take = Math.min(dueC, q.leftC)
        if (take > 0) {
          m[side].payments.push({ payoutId: q.p.id, date: q.p.date, amount: q.p.amount, applied: d(take), destination: q.p.destination })
          dueC -= take; paidC += take; q.leftC -= take
        }
        if (q.leftC === 0) qi++
      }
      m[side].paid = d(paidC)
      m[side].due = d(dueC)
    }
    return d(queue.slice(qi).reduce((t, q) => t + q.leftC, 0))
  }
  const partnerCredit = allocate('partner')
  const ownerCredit = allocate('owner')

  const sumC = (xs: number[]) => xs.reduce((t, x) => t + c(x), 0)
  const partnerShareC = sumC(months.map((m) => m.partner.share))
  const ownerShareC = sumC(months.map((m) => m.owner.share))
  const partnerPaidC = sumC(payouts.filter((p) => p.payee === 'partner').map((p) => p.amount))
  const ownerPaidC = sumC(payouts.filter((p) => p.payee === 'owner').map((p) => p.amount))

  // Calendar years by the date money actually moved (the tax basis).
  const ys = new Map<number, { received: number; partnerPaid: number; ownerPaid: number; receiptsBySource: Record<string, number> }>()
  const y = (date: string) => {
    const k = Number(date.slice(0, 4))
    let v = ys.get(k)
    if (!v) { v = { received: 0, partnerPaid: 0, ownerPaid: 0, receiptsBySource: {} }; ys.set(k, v) }
    return v
  }
  for (const r of receipts) {
    const v = y(r.date)
    v.received = d(c(v.received) + c(r.amount))
    v.receiptsBySource[r.source] = d(c(v.receiptsBySource[r.source] || 0) + c(r.amount))
  }
  for (const p of payouts) {
    const v = y(p.date)
    if (p.payee === 'partner') v.partnerPaid = d(c(v.partnerPaid) + c(p.amount))
    else v.ownerPaid = d(c(v.ownerPaid) + c(p.amount))
  }

  const partnerDueC = partnerShareC - partnerPaidC
  const nextPartnerPayments: number[] = []
  // Under a dollar is rounding, not a payment anyone would send.
  for (let left = partnerDueC >= 100 ? partnerDueC : 0; left > 0; left -= c(PAYMENT_LIMIT)) nextPartnerPayments.push(d(Math.min(left, c(PAYMENT_LIMIT))))

  return {
    months: [...months].reverse(),
    totals: {
      gross: d(sumC(months.map((m) => m.gross))),
      partnerShare: d(partnerShareC), partnerPaid: d(partnerPaidC), partnerDue: d(partnerDueC),
      ownerShare: d(ownerShareC), ownerPaid: d(ownerPaidC), ownerDue: d(ownerShareC - ownerPaidC),
    },
    partnerCredit, ownerCredit,
    years: [...ys.entries()].sort((a, b) => b[0] - a[0]).map(([year, v]) => ({ year, ...v })),
    nextPartnerPayments,
    unlinked: {
      receipts: receipts.filter((r) => !r.bank_txn_id).length,
      payouts: payouts.filter((p) => !p.bank_txn_id).length,
    },
  }
}

export async function productLedger(slug: string) {
  const product = await getProduct(slug)
  if (!product) return null
  const { receipts, payouts } = await loadEntries(product.id)
  return { product, ledger: computeLedger(product.owner_pct, receipts, payouts), receipts, payouts }
}
