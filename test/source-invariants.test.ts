// test/source-invariants.test.ts
// Guards that read the SOURCE of the financial libs. These catch the class of bug
// that unit tests miss: a query that quietly stops excluding deposits, or a
// distributable that goes back to operating NOI. Cheap, and they fail loudly.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('deposit exclusion', () => {
  const files = ['lib/distributions.ts', 'lib/capital.ts', 'lib/api/reports.ts']
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

describe('bot API invariants', () => {
  it('every API route authenticates through route() or authenticate()', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f)
        return statSync(p).isDirectory() ? walk(p) : f === 'route.ts' ? [p] : []
      })
    const routes = walk(join(process.cwd(), 'app/api'))
    expect(routes.length).toBeGreaterThan(10)
    for (const r of routes) {
      const src = readFileSync(r, 'utf8')
      const handlers = src.match(/export (const|async function) (GET|POST|PATCH|PUT|DELETE)\b/g) ?? []
      const guarded = (src.match(/= route(<[^>]*>)?\(/g) ?? []).length
      const selfAuth = /await authenticate\(req\)/.test(src)
      // Unauthenticated exports are only allowed when they do nothing (405 stubs).
      const stubs = (src.match(/status: 405/g) ?? []).length
      expect(guarded + (selfAuth ? 1 : 0) + stubs, r).toBeGreaterThanOrEqual(handlers.length)
    }
  })
  it('bots can never delete actual transactions', () => {
    const src = read('lib/api/service.ts')
    const deletes = src.match(/DELETE FROM transactions[^`]*/g) ?? []
    expect(deletes.length).toBeGreaterThan(0)
    for (const d of deletes) expect(d).toMatch(/status = 'forecast'/)
  })
  it('every bot write logs in the same statement', () => {
    const src = read('lib/api/service.ts')
    for (const verb of ['INSERT INTO transactions', 'UPDATE transactions SET', 'DELETE FROM transactions']) {
      for (const block of src.split(verb).slice(1)) {
        expect(block.slice(0, 1500), verb).toMatch(/INSERT INTO mutations_log/)
      }
    }
  })
  it('bot distributions: positive payouts need explicit confirmation and the lifetime guard', () => {
    const src = read('lib/api/periods.ts')
    expect(src).toMatch(/confirm_payout/)
    expect(src).toMatch(/lifetimeRetained/)
    expect(src).toMatch(/allow_over/)
    for (const f of ['lib/api/service.ts', 'lib/api/tools.ts', 'lib/api/bank-post.ts', 'lib/api/schedules.ts']) {
      expect(read(f)).not.toMatch(/INSERT INTO distributions|INSERT INTO period_closes/)
    }
  })
  it('the proxy exempts only the bot API prefixes from Clerk', () => {
    const src = read('proxy.ts')
    expect(src).toMatch(/'\/api\/v1\(\.\*\)'/)
    expect(src).toMatch(/'\/api\/mcp\(\.\*\)'/)
    expect(src).not.toMatch(/'\/api\(\.\*\)'/)
  })
})
