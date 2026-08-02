// lib/categories.ts
// Canonical category taxonomy. The `categories` table (see
// migrations/2026-08_categories_reference.sql) is the source of truth; these
// constants mirror it so entry forms can render without a DB round-trip, and
// `loadCategories()` is available where a live list is preferable.
//
// Names here MUST match the categories table exactly — lib/form8825.ts maps them
// to tax lines, and the Summary page surfaces an "Unmapped" row if one drifts.
import sql from './db'

export const INCOME_CATEGORIES = [
  'Rental Income',
  'Late Fee',
  'Other Income',
] as const

export const EXPENSE_CATEGORIES = [
  'Cleaning & Maintenance',
  'Insurance',
  'Legal',
  'Payroll Fees',
  'Bank Fees',
  'Mortgage Interest',
  'Repairs & Maintenance',
  'Contractors',
  'Property Taxes',
  'Municipal Fees',
  'Sanitary',
  'Refuse',
  'Fire Fee',
  'Utilities',
  'Payroll',
  'Management Fee',
  'Materials & Supplies',
  'Marketing',
  'Other Expense',
  'Security Deposit',
] as const

export type IncomeCategory = (typeof INCOME_CATEGORIES)[number]
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

export function isIncomeCategory(c: string): boolean {
  return (INCOME_CATEGORIES as readonly string[]).includes(c)
}

/** Live list from the categories table (falls back to the constants above). */
export async function loadCategories(kind?: 'income' | 'expense'): Promise<string[]> {
  try {
    const rows = (await sql`
      SELECT name FROM categories
      WHERE is_active = TRUE AND (${kind ?? null}::text IS NULL OR kind = ${kind ?? null})
      ORDER BY sort_order, name
    `) as { name: string }[]
    if (rows.length) return rows.map((r) => r.name)
  } catch {
    // table not migrated yet — fall through to constants
  }
  return kind === 'income'
    ? [...INCOME_CATEGORIES]
    : kind === 'expense'
    ? [...EXPENSE_CATEGORIES]
    : [...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES]
}
