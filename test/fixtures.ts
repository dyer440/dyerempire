// test/fixtures.ts
// A small ledger fixture mirroring REAL validated data (500 West & 1219, H1 2026).
// These numbers were reconciled by hand against the bank and the county tax bills
// in Aug 2026; they are the reference the financial rules must keep reproducing.
export type Txn = {
  id: number; property_id: number; type: 'income' | 'expense'
  category: string; amount: number; txn_date: string
  status: 'actual' | 'forecast'; is_deposit?: boolean
}

export const RESERVED = ['Property Taxes', 'Insurance']

// 500 West, H1 2026 — validated: income 9750.00, operating exp 591.60,
// tax/insurance 3538.06 → operating NOI 9158.40, ALL-IN 5620.34.
export const FIVE_HUNDRED_WEST_H1: Txn[] = [
  { id: 1, property_id: 1, type: 'income', category: 'Rental Income', amount: 9750.0, txn_date: '2026-03-01', status: 'actual' },
  { id: 2, property_id: 1, type: 'expense', category: 'Utilities', amount: 591.6, txn_date: '2026-03-05', status: 'actual' },
  { id: 3, property_id: 1, type: 'expense', category: 'Insurance', amount: 370.95, txn_date: '2026-03-30', status: 'actual' },
  { id: 4, property_id: 1, type: 'expense', category: 'Property Taxes', amount: 3167.11, txn_date: '2026-04-30', status: 'actual' },
]

// 1219, H1 2026 — validated: ALL-IN -1501.65 (four-month vacancy + water leak +
// full-year 2025 taxes paid in arrears). Includes a $2,000 security deposit that
// must NOT count as income, and its 2023 forfeiture pair.
export const TWELVE_NINETEEN_H1: Txn[] = [
  { id: 10, property_id: 2, type: 'income', category: 'Rental Income', amount: 7400.0, txn_date: '2026-05-01', status: 'actual' },
  { id: 11, property_id: 2, type: 'income', category: 'Rental Income', amount: 2000.0, txn_date: '2026-04-03', status: 'actual', is_deposit: true },
  { id: 12, property_id: 2, type: 'expense', category: 'Utilities', amount: 2728.29, txn_date: '2026-03-15', status: 'actual' },
  { id: 13, property_id: 2, type: 'expense', category: 'Repairs & Maintenance', amount: 3000.0, txn_date: '2026-02-10', status: 'actual' },
  { id: 14, property_id: 2, type: 'expense', category: 'Property Taxes', amount: 3173.36, txn_date: '2026-04-30', status: 'actual' },
  { id: 15, property_id: 2, type: 'expense', category: 'Insurance', amount: 0.0, txn_date: '2026-04-30', status: 'actual' },
]

// The aggregation RULES under test, expressed exactly as the SQL expresses them.
export const notDeposit = (t: Txn) => !t.is_deposit
export const isActual = (t: Txn) => t.status === 'actual'
export const sum = (rows: Txn[]) => rows.reduce((s, t) => s + t.amount, 0)

export function income(rows: Txn[]) {
  return sum(rows.filter((t) => t.type === 'income' && isActual(t) && notDeposit(t)))
}
export function operatingExpense(rows: Txn[]) {
  return sum(rows.filter((t) => t.type === 'expense' && isActual(t) && notDeposit(t) && !RESERVED.includes(t.category)))
}
export function reservedExpense(rows: Txn[]) {
  return sum(rows.filter((t) => t.type === 'expense' && isActual(t) && notDeposit(t) && RESERVED.includes(t.category)))
}
export const operatingNet = (rows: Txn[]) => income(rows) - operatingExpense(rows)
export const allInNet = (rows: Txn[]) => income(rows) - operatingExpense(rows) - reservedExpense(rows)
