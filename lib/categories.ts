// lib/categories.ts  (NEW)
// Expense categories map to IRS Schedule E lines — run the final list past your CPA.
// (Depreciation is handled at tax time, not entered as a cash transaction, so it's not here.)
export const INCOME_CATEGORIES = ['Rent', 'Late Fee', 'Other Income'] as const

export const EXPENSE_CATEGORIES = [
  'Cleaning & Maintenance',
  'Repairs',
  'Insurance',
  'Property Taxes',
  'Mortgage Interest',
  'Management Fees',
  'Utilities',
  'Supplies',
  'Legal & Professional',
  'Advertising',
  'Auto & Travel',
  'Commissions',
  'HOA / Dues',
  'Other Expense',
] as const
