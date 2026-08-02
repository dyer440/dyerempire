// test/finance-rules.test.ts
// Encodes the financial FACTS validated by hand in Aug 2026. If a refactor changes
// what any of these numbers mean, these fail — which is the point. The Q2-2026
// over-distribution happened because "retained cash" silently switched from all-in
// to operating NOI with nothing asserting the difference.
import { describe, it, expect } from 'vitest'
import {
  FIVE_HUNDRED_WEST_H1, TWELVE_NINETEEN_H1,
  income, operatingExpense, reservedExpense, operatingNet, allInNet,
} from './fixtures'
import { quarterBounds, isValidPeriod, RESERVED_CATEGORIES } from '@/lib/distributions'
import { lineForCategory, FORM_8825_LINES } from '@/lib/form8825'

describe('500 West H1 2026 — validated against bank + county bills', () => {
  it('income excludes nothing (no deposits) and totals 9750.00', () => {
    expect(income(FIVE_HUNDRED_WEST_H1)).toBeCloseTo(9750.0, 2)
  })
  it('operating expense excludes tax & insurance', () => {
    expect(operatingExpense(FIVE_HUNDRED_WEST_H1)).toBeCloseTo(591.6, 2)
  })
  it('tax/insurance paid in H1 is 3538.06 (2025 bill, paid in arrears)', () => {
    expect(reservedExpense(FIVE_HUNDRED_WEST_H1)).toBeCloseTo(3538.06, 2)
  })
  it('operating NOI is 9158.40', () => {
    expect(operatingNet(FIVE_HUNDRED_WEST_H1)).toBeCloseTo(9158.4, 2)
  })
  it('ALL-IN net is 5620.34 — this is distributable cash, NOT operating NOI', () => {
    expect(allInNet(FIVE_HUNDRED_WEST_H1)).toBeCloseTo(5620.34, 2)
  })
  it('all-in and operating differ by exactly the tax/insurance paid', () => {
    const d = operatingNet(FIVE_HUNDRED_WEST_H1) - allInNet(FIVE_HUNDRED_WEST_H1)
    expect(d).toBeCloseTo(reservedExpense(FIVE_HUNDRED_WEST_H1), 2)
  })
})

describe('1219 H1 2026 — vacancy quarter', () => {
  it('the $2,000 security deposit is EXCLUDED from income', () => {
    expect(income(TWELVE_NINETEEN_H1)).toBeCloseTo(7400.0, 2)
  })
  it('all-in net is negative (-1501.65) — nothing is distributable', () => {
    expect(allInNet(TWELVE_NINETEEN_H1)).toBeCloseTo(-1501.65, 2)
    expect(allInNet(TWELVE_NINETEEN_H1)).toBeLessThan(0)
  })
})

describe('reserve category definition', () => {
  it('only Property Taxes and Insurance are reserved (they fund the runway hold-back)', () => {
    expect([...RESERVED_CATEGORIES].sort()).toEqual(['Insurance', 'Property Taxes'])
  })
})

describe('quarter bounds', () => {
  it('Q2 spans Apr 1 → Jun 30', () => {
    const b = quarterBounds('2026-Q2')
    expect(b.start).toBe('2026-04-01')
    expect(b.end).toBe('2026-06-30')
  })
  it('Q4 ends Dec 31 and year-start is Jan 1', () => {
    const b = quarterBounds('2026-Q4')
    expect(b.end).toBe('2026-12-31')
    expect(b.yearStart).toBe('2026-01-01')
  })
  it('validates period labels', () => {
    expect(isValidPeriod('2026-Q1')).toBe(true)
    expect(isValidPeriod('2026-Q5')).toBe(false)
    expect(isValidPeriod('nonsense')).toBe(false)
  })
})

describe('Form 8825 mapping', () => {
  // Every category the ledger can produce must land on a line, or the Summary
  // silently under-reports expenses.
  const LIVE_CATEGORIES = [
    'Cleaning & Maintenance', 'Insurance', 'Legal', 'Payroll Fees', 'Bank Fees',
    'Mortgage Interest', 'Repairs & Maintenance', 'Contractors', 'Property Taxes',
    'Municipal Fees', 'Sanitary', 'Refuse', 'Fire Fee', 'Utilities', 'Payroll',
    'Management Fee', 'Materials & Supplies', 'Marketing', 'Other Expense',
    // legacy names still present in pre-migration history
    'Repairs', 'Management', 'Supplies', 'Other Misc. Expenses', 'Interest',
  ]
  it('maps every live category to an 8825 line', () => {
    const unmapped = LIVE_CATEGORIES.filter((c) => lineForCategory(c) === '__UNMAPPED__')
    expect(unmapped).toEqual([])
  })
  it('Security Deposit maps to NO line (it is a liability, not P&L)', () => {
    expect(lineForCategory('Security Deposit')).toBeNull()
  })
  it('Repairs and Cleaning stay on separate lines', () => {
    expect(lineForCategory('Repairs & Maintenance')).not.toBe(lineForCategory('Cleaning & Maintenance'))
  })
  it('interest has its own line, not lumped into Other', () => {
    expect(lineForCategory('Mortgage Interest')).not.toBe(lineForCategory('Other Expense'))
  })
  it('line numbers are unique', () => {
    const nums = FORM_8825_LINES.map((l) => l.line)
    expect(new Set(nums).size).toBe(nums.length)
  })
})
