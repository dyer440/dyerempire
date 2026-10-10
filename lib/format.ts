// lib/format.ts — display helpers for the read-only site.

const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** $1,234.56 with a leading minus for negatives. */
export const money = (n: number) => usd2.format(n)
/** $1,235, for headline figures and dense grids. */
export const money0 = (n: number) => usd0.format(n)

/** Oct 6, 2026 */
export function longDate(ymd: string | null) {
  if (!ymd) return ''
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** Oct 6 */
export function shortDate(ymd: string) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** "Oct" or "Oct 2026" from YYYY-MM */
export function monthName(ym: string, withYear = false) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: withYear ? 'long' : 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC',
  })
}

/** "2026-Q3" -> "Q3 2026" */
export const quarterName = (p: string) => `${p.slice(5)} ${p.slice(0, 4)}`
