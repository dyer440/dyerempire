// test/sql-guard.test.ts
// The lexical gate in front of the bot SQL endpoint. It is layer 1 of 3 (the
// READ ONLY transaction and the dyer_bot_ro role are layers 2 and 3), so these
// tests are about friendly, predictable rejections, not the security boundary.
import { describe, it, expect } from 'vitest'
import { assertReadOnlySql, stripSqlNoise } from '@/lib/api/sql-runner'

describe('assertReadOnlySql', () => {
  const allowed = [
    'SELECT 1',
    'select * from transactions where status = \'actual\';',
    'WITH t AS (SELECT * FROM transactions) SELECT COUNT(*) FROM t',
    'EXPLAIN SELECT * FROM transactions',
    '(SELECT 1) UNION (SELECT 2)',
    "SELECT 'DELETE FROM x' AS harmless",
    'SELECT 1 -- DROP TABLE x',
    'SELECT 1 /* UPDATE */',
    'SELECT "update" FROM (SELECT 1 AS "update") s',
    'SELECT * FROM transactions ORDER BY id OFFSET 10',
    'SHOW statement_timeout',
    "SELECT $$ DELETE $$ AS dollar",
  ]
  for (const s of allowed) it(`allows: ${s}`, () => expect(() => assertReadOnlySql(s)).not.toThrow())

  const blocked = [
    '',
    'DELETE FROM transactions',
    'INSERT INTO transactions DEFAULT VALUES',
    'WITH d AS (DELETE FROM transactions RETURNING *) SELECT * FROM d',
    'SELECT 1; SELECT 2',
    'SELECT 1; DROP TABLE x',
    'SELECT * FROM transactions FOR UPDATE',
    'EXPLAIN ANALYZE SELECT 1',
    "SELECT set_config('x','y',false)",
    'SELECT pg_sleep(100)',
    "SELECT nextval('transactions_id_seq')",
    'SET statement_timeout = 0',
    'BEGIN',
    'CREATE TABLE x (id int)',
    'COPY transactions TO STDOUT',
    'VACUUM',
  ]
  for (const s of blocked) it(`blocks: ${s || '(empty)'}`, () => expect(() => assertReadOnlySql(s)).toThrow())

  it('strips a trailing semicolon', () => {
    expect(assertReadOnlySql('SELECT 1;  ')).toBe('SELECT 1')
  })
  it('stripSqlNoise blanks literals and comments', () => {
    expect(stripSqlNoise("SELECT 'a;b' -- c;\n")).not.toContain(';')
  })
})
