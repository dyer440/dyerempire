// lib/import-rules.ts
// Matching logic for import_rules against staged bank rows. Pure functions —
// no DB access — so the ranking is unit-testable. A rule is a candidate when
// its pattern is a substring of the (normalized, upper-cased) counterparty
// (empty pattern = any), its amount matches exactly (null = any), and its
// debit/credit scope fits the sign. Among candidates the most SPECIFIC wins:
// pattern+amount > pattern-only > amount-only, ties broken by longer pattern.
export type ImportRule = {
  id: number
  pattern: string
  amount: number | null
  applies_to: 'any' | 'debit' | 'credit'
  target_kind: 'property' | 'entity' | 'exclude'
  property_id: number | null
  entity_id: number | null
  category: string | null
  is_rent: boolean
  unit_id: number | null
  is_deposit: boolean
  exclude_reason: string | null
  note: string | null
}

export type BankRowLite = { amount: number; name_norm: string }

const cents = (n: number) => Math.round(Math.abs(n) * 100)

export function ruleMatches(rule: ImportRule, row: BankRowLite): boolean {
  if (rule.applies_to === 'debit' && row.amount >= 0) return false
  if (rule.applies_to === 'credit' && row.amount <= 0) return false
  if (rule.amount != null && cents(rule.amount) !== cents(row.amount)) return false
  if (rule.pattern && !row.name_norm.toUpperCase().includes(rule.pattern.toUpperCase())) return false
  return true
}

/** Higher = more specific / preferred. */
export function ruleSpecificity(rule: ImportRule): number {
  const hasPattern = rule.pattern.length > 0
  const hasAmount = rule.amount != null
  let base = 0
  if (hasPattern && hasAmount) base = 3000
  else if (hasPattern) base = 2000
  else base = 1000 // amount-only
  if (rule.applies_to !== 'any') base += 100 // sign-scoped is a touch more specific
  return base + Math.min(rule.pattern.length, 99)
}

/** The single best rule for a row, or null. */
export function bestRule(rules: ImportRule[], row: BankRowLite): ImportRule | null {
  let best: ImportRule | null = null
  let bestScore = -1
  for (const rule of rules) {
    if (!ruleMatches(rule, row)) continue
    const s = ruleSpecificity(rule)
    if (s > bestScore) { best = rule; bestScore = s }
  }
  return best
}

export type Suggestion = {
  ruleId: number
  kind: 'post' | 'exclude'
  // for post:
  target?: string          // 'property:<id>' | 'entity:<id>'
  category?: string
  isRent?: boolean
  unitId?: number | null
  isDeposit?: boolean
  needsProperty?: boolean  // rule set a category but no property — still needs a pick
  // for exclude:
  reason?: string
  note?: string | null
}

/** Translate a matched rule into a concrete UI suggestion for a given row. */
export function ruleToSuggestion(rule: ImportRule): Suggestion {
  if (rule.target_kind === 'exclude') {
    return { ruleId: rule.id, kind: 'exclude', reason: rule.exclude_reason || 'excluded', note: rule.note }
  }
  const target =
    rule.target_kind === 'entity' && rule.entity_id != null ? `entity:${rule.entity_id}`
    : rule.property_id != null ? `property:${rule.property_id}`
    : undefined
  return {
    ruleId: rule.id,
    kind: 'post',
    target,
    category: rule.category || undefined,
    isRent: rule.is_rent,
    unitId: rule.unit_id,
    isDeposit: rule.is_deposit,
    needsProperty: rule.target_kind === 'property' && rule.property_id == null,
    note: rule.note,
  }
}
