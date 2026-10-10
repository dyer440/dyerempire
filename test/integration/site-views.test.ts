// test/integration/site-views.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
// The read-only website's queries (lib/views.ts) against real Postgres.
// Run with vitest.integration.config.ts, like bot-api.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { initDb } from '@/lib/init-db'
import { closeAll } from './pg-neon'
import {
  rentGrid, lateRent, rentMonth, categoryYears, propertyHeadlines, activity, activityYears,
  distributionHistory, monthsEnding, lastEndedQuarter, upcomingBills,
} from '@/lib/views'

const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL! })
const q = async (text: string, params: unknown[] = []) => (await owner.query(text, params)).rows
const ids: Record<string, number> = {}

const today = new Date()
const iso = (d: Date) => d.toISOString().slice(0, 10)
const ymOf = (off: number) => { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + off, 1)); return iso(d).slice(0, 7) }
const dayIn = (off: number, day: number) => `${ymOf(off)}-${String(day).padStart(2, '0')}`
const months6 = monthsEnding(ymOf(0), 6)

beforeAll(async () => {
  await q('DROP SCHEMA IF EXISTS public CASCADE')
  await q('CREATE SCHEMA public')
  await initDb()

  const [w] = await q(`INSERT INTO properties (name, holding_entity, status, address, city) VALUES ('500 West', '500 West LLC', 'active', '500 11th Ave W', 'Huntington') RETURNING id`)
  const [h] = await q(`INSERT INTO properties (name, holding_entity, status, current_tenant) VALUES ('1219', '1219 LLC', 'active', 'Brandon') RETURNING id`)
  const [up] = await q(`INSERT INTO units (property_id, label, current_tenant) VALUES ($1, 'Upstairs', 'Tim') RETURNING id`, [w.id])
  const [dn] = await q(`INSERT INTO units (property_id, label, current_tenant) VALUES ($1, 'Downstairs', 'Natalie') RETURNING id`, [w.id])
  const [main] = await q(`INSERT INTO units (property_id, label) VALUES ($1, 'Main') RETURNING id`, [h.id])
  Object.assign(ids, { w: w.id, h: h.id, up: up.id, dn: dn.id, main: main.id })

  const ins = async (c: Record<string, unknown>) => {
    const k = Object.keys(c)
    await q(`INSERT INTO transactions (${k.join(',')}) VALUES (${k.map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(c))
  }
  const rent = { type: 'income', category: 'Rental Income' }
  // Natalie (downstairs): paid every month of the last six, last month's paid on the 2nd of this month.
  for (let off = -5; off <= 0; off++) {
    if (off === -1) continue
    await ins({ ...rent, property_id: w.id, unit_id: dn.id, amount: 700, txn_date: dayIn(off, 3), status: 'actual' })
  }
  await ins({ ...rent, property_id: w.id, unit_id: dn.id, amount: 700, txn_date: dayIn(0, 2), rental_period: ymOf(-1), status: 'actual' })
  // Tim (upstairs): paid until three months ago, then two months unpaid (late), and this month not due yet.
  for (let off = -5; off <= -3; off++) await ins({ ...rent, property_id: w.id, unit_id: up.id, amount: 750, txn_date: dayIn(off, 1), status: 'actual' })
  await ins({ ...rent, property_id: w.id, unit_id: up.id, amount: 750, txn_date: dayIn(-2, 1), status: 'forecast' })
  await ins({ ...rent, property_id: w.id, unit_id: up.id, amount: 750, txn_date: dayIn(-1, 1), status: 'forecast' })
  // Partial: $400 in and $350 still scheduled, due in the future.
  await ins({ ...rent, property_id: w.id, unit_id: up.id, amount: 400, txn_date: dayIn(0, 1), status: 'actual' })
  await ins({ ...rent, property_id: w.id, unit_id: up.id, amount: 350, txn_date: iso(new Date(today.getTime() + 5 * 86400000)), rental_period: ymOf(0), status: 'forecast' })
  // A security deposit never counts as rent.
  await ins({ ...rent, property_id: w.id, unit_id: up.id, amount: 750, txn_date: dayIn(-4, 15), status: 'actual', is_deposit: true })
  // 1219: whole-property style, rent booked to its single unit.
  await ins({ ...rent, property_id: h.id, unit_id: main.id, amount: 1100, txn_date: dayIn(-1, 5), status: 'actual' })
  // Expenses this year and last.
  const y = today.getUTCFullYear()
  await ins({ property_id: w.id, type: 'expense', category: 'Insurance', amount: 537.6, txn_date: `${y}-01-27`, status: 'actual' })
  await ins({ property_id: w.id, type: 'expense', category: 'Insurance', amount: 500, txn_date: `${y - 1}-09-27`, status: 'actual' })
  await ins({ property_id: w.id, type: 'income', category: 'Rental Income', amount: 650, txn_date: `${y - 1}-09-03`, status: 'actual', description: 'Zelle from Natalie' })
  await ins({ property_id: w.id, type: 'expense', category: 'Property Taxes', amount: 812.4, txn_date: iso(new Date(today.getTime() + 20 * 86400000)), status: 'forecast' })

  const [o1] = await q(`INSERT INTO owners (name, type) VALUES ('David', 'person') RETURNING id`)
  const [o2] = await q(`INSERT INTO owners (name, type) VALUES ('Black Sevens LLC', 'entity') RETURNING id`)
  await q(`INSERT INTO distributions (period, property_id, owner_id, amount, distributed_on) VALUES
           ('2026-Q1', $1, $2, 300, '2026-04-15'), ('2026-Q1', $1, $3, 300, '2026-04-16'),
           ('2026-Q2', $1, $2, 0, NULL), ('2026-Q2', $1, $3, 0, NULL)`, [w.id, o1.id, o2.id])
}, 60_000)

afterAll(async () => {
  await owner.end()
  await closeAll()
})

describe('rent grid', () => {
  it('splits a duplex into one line per unit and keeps a single-unit house as one line', async () => {
    const lines = await rentGrid([ids.h, ids.w], months6)
    expect(lines.map((l) => [l.propertyName, l.unitLabel, l.tenant])).toEqual([
      ['1219', null, 'Brandon'],
      ['500 West', 'Downstairs', 'Natalie'],
      ['500 West', 'Upstairs', 'Tim'],
    ])
    expect((await rentGrid([ids.w, ids.h], months6))[0].propertyName).toBe('500 West')
  })
  it('marks paid, late, partial and empty months, and files rent by the month it was for', async () => {
    const lines = await rentGrid([ids.w, ids.h], months6)
    const nat = lines.find((l) => l.unitLabel === 'Downstairs')!
    expect(nat.cells.map((c) => c.state)).toEqual(['paid', 'paid', 'paid', 'paid', 'paid', 'paid'])
    expect(nat.cells[4].received).toBe(700) // paid on the 2nd of this month, for last month
    const tim = lines.find((l) => l.unitLabel === 'Upstairs')!
    expect(tim.cells.map((c) => c.state)).toEqual(['paid', 'paid', 'paid', 'late', 'late', 'partial'])
    expect(tim.cells[1].received).toBe(750) // the deposit in that month is not rent
    expect(tim.cells[5]).toMatchObject({ received: 400, open: 350 })
    const h = lines.find((l) => l.propertyName === '1219')!
    expect(h.cells.map((c) => c.state)).toEqual(['none', 'none', 'none', 'none', 'paid', 'none'])
  })
  it('only returns the properties asked for', async () => {
    expect((await rentGrid([ids.h], months6)).length).toBe(1)
    expect(await rentGrid([], months6)).toEqual([])
  })
})

describe('late rent and this month', () => {
  it('lists only rent 7+ days past due, per unit, with months and total', async () => {
    const late = await lateRent([ids.w, ids.h])
    expect(late).toEqual([{
      propertyId: ids.w, propertyName: '500 West', unitLabel: 'Upstairs', tenant: 'Tim',
      months: [ymOf(-2), ymOf(-1)], total: 1500,
    }])
    expect(await lateRent([ids.h])).toEqual([])
  })
  it('sums this month received and still expected', async () => {
    expect(await rentMonth([ids.w, ids.h], ymOf(0))).toEqual({ received: 1100, open: 350 })
  })
})

describe('property figures', () => {
  it('category table by year excludes deposits and forecasts', async () => {
    const y = today.getUTCFullYear()
    const c = await categoryYears(ids.w, [y - 1, y])
    expect(c.expense.find((e) => e.category === 'Insurance')!.byYear).toEqual({ [y - 1]: 500, [y]: 537.6 })
    expect(c.expense.find((e) => e.category === 'Property Taxes')).toBeUndefined()
    expect(c.totals[y - 1]).toEqual({ income: 650, expense: 500, net: 150 })
    const rentThisYear = c.income.find((i) => i.category === 'Rental Income')!.byYear[y]
    const { rows } = await owner.query(
      `SELECT SUM(amount)::float8 AS s FROM transactions WHERE property_id = $1 AND status = 'actual' AND type = 'income'
         AND NOT COALESCE(is_deposit, FALSE) AND EXTRACT(YEAR FROM txn_date) = $2`, [ids.w, y])
    expect(rentThisYear).toBe(rows[0].s)
  })
  it('headlines carry net cash this year and the latest distribution', async () => {
    const h = (await propertyHeadlines([ids.w, ids.h], today.getUTCFullYear())).get(ids.w)!
    expect(h.netYtd).toBe(Math.round((h.incomeYtd - h.expenseYtd) * 100) / 100)
    expect(h.lastDistribution).toEqual({ period: '2026-Q2', total: 0 })
    expect((await propertyHeadlines([ids.h], 2026)).get(ids.h)!.lastDistribution).toBeNull()
  })
  it('distribution history is newest first with a column per owner', async () => {
    const d = await distributionHistory(ids.w)
    expect(d.owners.sort()).toEqual(['Black Sevens LLC', 'David'])
    expect(d.periods.map((p) => [p.period, p.total, p.paidOn])).toEqual([['2026-Q2', 0, null], ['2026-Q1', 600, '2026-04-16']])
  })
  it('upcoming bills come from scheduled expenses only', async () => {
    const b = await upcomingBills(ids.w, 90)
    expect(b.map((x) => [x.category, x.amount])).toEqual([['Property Taxes', 812.4]])
  })
})

describe('activity', () => {
  it('lists actuals for a year, newest first, with deposits flagged', async () => {
    const rows = await activity({ propertyId: ids.w, year: today.getUTCFullYear() })
    expect(rows.every((r) => r.date.startsWith(String(today.getUTCFullYear())))).toBe(true)
    expect(rows.some((r) => r.deposit)).toBe(today.getUTCMonth() >= 4) // the deposit was four months ago
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].date >= rows[i].date).toBe(true)
  })
  it('searches description, category, unit and exact amount', async () => {
    const y = today.getUTCFullYear() - 1
    expect((await activity({ propertyId: ids.w, year: y, search: 'zelle' })).length).toBe(1)
    expect((await activity({ propertyId: ids.w, year: y, search: '$650.00' })).length).toBe(1)
    expect((await activity({ propertyId: ids.w, year: y, search: 'insurance' })).length).toBe(1)
    expect((await activity({ propertyId: ids.w, year: y, search: 'nothing like this' })).length).toBe(0)
  })
  it('knows which years have activity', async () => {
    const ys = await activityYears({ propertyId: ids.w })
    expect(ys[0]).toBe(today.getUTCFullYear())
    expect(ys).toContain(today.getUTCFullYear() - 1)
  })
})

describe('helpers', () => {
  it('monthsEnding and lastEndedQuarter', () => {
    expect(monthsEnding('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02'])
    expect(lastEndedQuarter(new Date('2026-10-10T12:00:00'))).toBe('2026-Q3')
    expect(lastEndedQuarter(new Date('2026-02-01T12:00:00'))).toBe('2025-Q4')
  })
})
