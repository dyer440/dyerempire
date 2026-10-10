// test/integration/pg-neon.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
// Test double for @neondatabase/serverless backed by a real local Postgres
// (node-postgres). Lets the integration suite run the app's actual SQL —
// tagged templates, sql.query(), and sql.transaction() — without Neon.
// Only used via the alias in vitest.integration.config.ts.
import pg from 'pg'

type Desc = { text: string; params: unknown[] }
type Opts = { fullResults?: boolean; readOnly?: boolean; isolationLevel?: string }

const pools = new Map<string, pg.Pool>()
function pool(url: string) {
  let p = pools.get(url)
  if (!p) { p = new pg.Pool({ connectionString: url, max: 4 }); pools.set(url, p) }
  return p
}
export async function closeAll() { for (const p of pools.values()) await p.end(); pools.clear() }

function build(strings: TemplateStringsArray, values: unknown[]): Desc {
  let text = strings[0]
  for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1]
  return { text, params: values }
}

const shape = (r: pg.QueryResult, full?: boolean) =>
  full ? { rows: r.rows, fields: r.fields, rowCount: r.rowCount, command: r.command } : r.rows

export function neon(url: string, neonOpts: Opts = {}) {
  const exec = async (d: Desc) => shape(await pool(url).query(d.text, d.params as unknown[]), neonOpts.fullResults)

  const lazy = (d: Desc) => {
    const p = { ...d, then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec(d).then(res, rej) }
    return p
  }
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => lazy(build(strings, values))) as any
  sql.query = (text: string, params: unknown[] = []) => lazy({ text, params })
  sql.transaction = async (arg: any, opts: Opts = {}) => {
    const txFn = ((s: TemplateStringsArray, ...v: unknown[]) => build(s, v)) as any
    txFn.query = (text: string, params: unknown[] = []) => ({ text, params })
    const descs: Desc[] = typeof arg === 'function' ? arg(txFn) : arg
    const client = await pool(url).connect()
    const full = opts.fullResults ?? neonOpts.fullResults
    try {
      const iso = opts.isolationLevel ? ` ISOLATION LEVEL ${opts.isolationLevel.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()}` : ''
      await client.query(`BEGIN${iso}${opts.readOnly ? ' READ ONLY' : ''}`)
      const out = []
      for (const d of descs) out.push(shape(await client.query(d.text, d.params as unknown[]), full))
      await client.query('COMMIT')
      return out
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }
  return sql
}
