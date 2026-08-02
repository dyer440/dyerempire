// test/source-invariants.test.ts
// Guards that read the SOURCE of the financial libs. These catch the class of bug
// that unit tests miss: a query that quietly stops excluding deposits, or a
// distributable that goes back to operating NOI. Cheap, and they fail loudly.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('deposit exclusion', () => {
  const files = ['lib/distributions.ts', 'lib/capital.ts']
  for (const f of files) {
    it(`${f}: every transactions aggregation excludes deposits`, () => {
      const src = read(f)
      // Each SUM over `transactions` must carry the is_deposit guard.
      const blocks = src.split('FROM transactions').slice(1)
      for (const b of blocks) {
        const clause = b.slice(0, 500)
        // Exempt: queries scoped to Property Taxes / Insurance only — a security
        // deposit can never carry those categories, so the guard is moot there.
        if (/category IN \('Property Taxes', 'Insurance'\)/.test(clause)) continue
        expect(clause).toMatch(/COALESCE\(is_deposit, FALSE\) = FALSE|is_deposit, FALSE\) = TRUE/)
      }
    })
  }
})

describe('retained cash definition (the Q2-2026 regression guard)', () => {
  const src = read('lib/distributions.ts')
  it('sums ALL expenses — never filters out reserved categories', () => {
    expect(src).toMatch(/cumExpenseAll/)
    // The bug: `else if (!RESERVED_SET.has(r.category)) cumOpEx += ...` for retained cash.
    const idx = src.indexOf('cumulativeActualNoi')
    const window = src.slice(Math.max(0, idx - 800), idx)
    expect(window).not.toMatch(/RESERVED_SET\.has\(r\.category\)/)
  })
  it('the smoothed distributable is gone', () => {
    expect(src).not.toMatch(/const distributable = operatingNet/)
  })
})

describe('over-distribution guard', () => {
  it('recordDistribution compares against LIFETIME retained, not YTD', () => {
    const src = read('app/real-estate/distributions/actions.ts')
    expect(src).toMatch(/lifetimeRetained/)
    expect(src).toMatch(/allow_over/)
  })
})

describe('auth invariants', () => {
  it('admin mutations guard themselves, not just the page render', () => {
    const src = read('app/admin/page.tsx')
    const addUser = src.slice(src.indexOf('async function addUser'), src.indexOf('async function removeUser'))
    expect(addUser).toMatch(/requireAdmin\(\)/)
  })
  it('ADMIN_EMAIL is defined once, in lib/constants', () => {
    for (const f of ['proxy.ts', 'lib/access.ts', 'app/admin/page.tsx']) {
      expect(read(f)).not.toMatch(/const ADMIN_EMAIL = '/)
    }
    expect(read('lib/constants.ts')).toMatch(/export const ADMIN_EMAIL/)
  })
})
