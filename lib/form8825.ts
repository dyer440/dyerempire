// lib/form8825.ts
// Maps the ledger's many expense categories onto Form 8825 (Rental Real Estate
// Income and Expenses of a Partnership — filed with Form 1065) line items. The
// ledger uses 24+ free-text categories with near-duplicates (Repairs vs Repairs
// & Maintenance, Management vs Management Fee, Municipal Fees vs Sanitary/Refuse/
// Fire Fee); 8825 has ~15 numbered lines. This consolidates them so the Summary
// rollup reads like a tax return. Lines kept SEPARATE per the form (e.g. Repairs
// line 14 vs Cleaning & maintenance line 3) rather than combined.

export type Form8825Line = {
  line: string // 8825 line number/label
  label: string
  categories: string[] // ledger categories that roll into this line
}

// Order matches Form 8825's expense section.
export const FORM_8825_LINES: Form8825Line[] = [
  { line: '3', label: 'Cleaning & maintenance', categories: ['Cleaning & Maintenance'] },
  { line: '4', label: 'Commissions', categories: [] },
  { line: '5', label: 'Insurance', categories: ['Insurance'] },
  { line: '6', label: 'Legal & other professional fees', categories: ['Legal', 'Payroll Fees', 'Bank Fees'] },
  { line: '7', label: 'Interest (mortgage & other)', categories: ['Mortgage Interest', 'Interest'] },
  { line: '8', label: 'Repairs', categories: ['Repairs & Maintenance', 'Repairs', 'Contractors'] },
  { line: '9', label: 'Taxes', categories: ['Property Taxes', 'Municipal Fees', 'Sanitary', 'Refuse', 'Fire Fee'] },
  { line: '10', label: 'Utilities', categories: ['Utilities'] },
  { line: '11', label: 'Wages & salaries', categories: ['Payroll'] },
  { line: '13', label: 'Management fees', categories: ['Management Fee', 'Management'] },
  { line: '14', label: 'Other (supplies, misc.)', categories: ['Materials & Supplies', 'Supplies', 'Other Expense', 'Other Misc. Expenses', 'Marketing'] },
]

// Categories that must NOT appear in the P&L rollup at all.
export const NON_PL_CATEGORIES = new Set(['Security Deposit'])

// Build a category → line label lookup, and surface any category not yet mapped
// so it can't be silently dropped from the rollup.
const CATEGORY_TO_LINE: Record<string, string> = {}
for (const l of FORM_8825_LINES) for (const c of l.categories) CATEGORY_TO_LINE[c] = l.label

export function lineForCategory(category: string): string | null {
  if (NON_PL_CATEGORIES.has(category)) return null
  return CATEGORY_TO_LINE[category] ?? '__UNMAPPED__'
}
