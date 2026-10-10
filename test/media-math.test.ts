// test/media-math.test.ts
// The Coal Trader split and payment matching (lib/media.ts computeLedger).
import { describe, it, expect } from 'vitest'
import { computeLedger, type Receipt, type Payout } from '@/lib/media'

let id = 0
const rc = (period: string, amount: number, source = 'substack', date = `${period}-28`): Receipt =>
  ({ id: ++id, source, amount, date, period, bank_txn_id: null, origin: 'sheet', note: null })
const po = (payee: 'partner' | 'owner', amount: number, date: string): Payout =>
  ({ id: ++id, payee, amount, date, destination: null, bank_txn_id: null, origin: 'sheet', note: null })

describe('the split', () => {
  it('gives the partner 87.5% rounded to the cent and SL Media the exact remainder', () => {
    // Sept 2026 from the spreadsheet: 4,237.33 + 16,545.44
    const L = computeLedger(12.5, [rc('2026-09', 4237.33), rc('2026-09', 16545.44, 'website')], [])
    const m = L.months[0]
    expect(m.gross).toBe(20782.77)
    expect(m.partner.share).toBe(18184.92)
    expect(m.owner.share).toBe(2597.85)
    expect(m.partner.share + m.owner.share).toBeCloseTo(m.gross, 10)
    expect(m.bySource).toEqual({ substack: 4237.33, website: 16545.44 })
  })
  it('a 100% product has no partner share', () => {
    const L = computeLedger(100, [rc('2025-11', 1772.64, 'seawolf')], [po('owner', 1772.64, '2025-11-05')])
    expect(L.months[0].partner.share).toBe(0)
    expect(L.totals.ownerDue).toBe(0)
    expect(L.nextPartnerPayments).toEqual([])
  })
})

describe('payments are applied oldest month first', () => {
  const receipts = [rc('2026-07', 10000), rc('2026-08', 10000), rc('2026-09', 4000)]
  // shares: 8750, 8750, 3500 = 21000
  it('fills months in order, splitting a payment across months', () => {
    const L = computeLedger(12.5, receipts, [po('partner', 10000, '2026-08-05'), po('partner', 5000, '2026-09-02')])
    const [sep, aug, jul] = L.months
    expect(jul.partner).toMatchObject({ paid: 8750, due: 0 })
    expect(jul.partner.payments).toEqual([expect.objectContaining({ amount: 10000, applied: 8750 })])
    expect(aug.partner).toMatchObject({ paid: 6250, due: 2500 })
    expect(aug.partner.payments.map((p) => p.applied)).toEqual([1250, 5000])
    expect(sep.partner).toMatchObject({ paid: 0, due: 3500 })
    expect(L.totals.partnerDue).toBe(6000)
    expect(L.nextPartnerPayments).toEqual([6000])
  })
  it('splits what is owed into payments of at most $10,000', () => {
    const L = computeLedger(12.5, [rc('2026-09', 30000)], [])
    expect(L.totals.partnerDue).toBe(26250)
    expect(L.nextPartnerPayments).toEqual([10000, 10000, 6250])
  })
  it('an overpayment becomes a credit, not a negative month', () => {
    const L = computeLedger(12.5, receipts, [po('partner', 25000, '2026-10-01')])
    expect(L.months.every((m) => m.partner.due === 0)).toBe(true)
    expect(L.partnerCredit).toBe(4000)
    expect(L.totals.partnerDue).toBe(-4000)
    expect(L.nextPartnerPayments).toEqual([])
  })
  it('owner moves are tracked on their own', () => {
    const L = computeLedger(12.5, receipts, [po('owner', 1250, '2026-08-02'), po('partner', 21000, '2026-10-01')])
    expect(L.totals.ownerShare).toBe(3000)
    expect(L.totals.ownerDue).toBe(1750)
    expect(L.totals.partnerDue).toBe(0)
  })
})

describe('calendar years go by the date money moved', () => {
  it('a December month paid in January counts in January for the 1099', () => {
    const L = computeLedger(12.5, [rc('2025-12', 8000, 'substack', '2025-12-29')], [po('partner', 7000, '2026-01-09')])
    expect(L.years).toEqual([
      { year: 2026, received: 0, partnerPaid: 7000, ownerPaid: 0, receiptsBySource: {} },
      { year: 2025, received: 8000, partnerPaid: 0, ownerPaid: 0, receiptsBySource: { substack: 8000 } },
    ])
  })
})
