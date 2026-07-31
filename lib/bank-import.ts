// lib/bank-import.ts
// Parsing, counterparty normalization, and dedup hashing for bank-CSV imports.
// Pure functions, no DB access — unit-testable in isolation.
//
// US Bank export format (quoted CSV, newest-first):
//   "Date","Transaction","Name","Memo","Amount"
//   Date: YYYY-MM-DD · Transaction: DEBIT | CREDIT | <check number>
//   Amount: signed decimal (credits +, debits −)
import { createHash } from 'crypto'

export type ParsedBankRow = {
  txnDate: string        // YYYY-MM-DD
  amount: number         // signed, dollars
  nameRaw: string
  memo: string | null
  checkNumber: string | null
  nameNorm: string
}

/** Minimal RFC-4180-ish parser: quoted fields, embedded commas, "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim() !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.some(f => f.trim() !== '')) rows.push(row)
  }
  return rows
}

/**
 * Normalize a counterparty string into a stable key: uppercase, transaction-type
 * prefixes stripped, trailing bank reference codes removed, whitespace collapsed.
 * Case-insensitive by construction (the access.ts lesson).
 */
export function normalizeName(nameRaw: string): string {
  let n = ` ${nameRaw.trim()} `
  n = n.replace(/ZELLE INSTANT PMT (FROM|TO)\s+/i, '')
  n = n.replace(/DEBIT PURCHASE\s*-?VISA\s+/i, '')
  n = n.replace(/RECURRING DEBIT PURCHASE\s+/i, '')
  n = n.replace(/ELECTRONIC (WITHDRAWAL|DEPOSIT)\s+/i, '')
  n = n.replace(/BILL PAY( FOR BUSINESS)? TO\s+/i, '')
  n = n.replace(/WEB AUTHORIZED PMT\s+/i, '')
  n = n.replace(/MOBILE CHECK DEPOSIT/i, 'MOBILE CHECK DEPOSIT')
  n = n.trim()
  // Trailing reference token: long alphanumeric blob glued to the end
  n = n.replace(/\s+[A-Za-z0-9]{9,}$/, '')
  n = n.replace(/\s+/g, ' ').trim().toUpperCase()
  return n || nameRaw.trim().toUpperCase()
}

/** Parse a US Bank CSV export into rows (header row required, order preserved). */
export function parseUsBankCsv(text: string): ParsedBankRow[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const iDate = col('date'), iTxn = col('transaction'), iName = col('name'),
        iMemo = col('memo'), iAmt = col('amount')
  if (iDate < 0 || iName < 0 || iAmt < 0) {
    throw new Error('Unrecognized CSV format — expected US Bank columns Date, Transaction, Name, Memo, Amount.')
  }
  const out: ParsedBankRow[] = []
  for (const r of rows.slice(1)) {
    const dateStr = (r[iDate] || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue // skip malformed/footer lines
    const amount = Number((r[iAmt] || '').replace(/[$,]/g, ''))
    if (!Number.isFinite(amount) || amount === 0) continue
    const txnCol = iTxn >= 0 ? (r[iTxn] || '').trim() : ''
    const checkNumber = txnCol && txnCol !== 'DEBIT' && txnCol !== 'CREDIT' ? txnCol : null
    const nameRaw = (r[iName] || '').trim()
    const memo = iMemo >= 0 ? (r[iMemo] || '').trim() || null : null
    const nameNorm = checkNumber ? `CHECK #${checkNumber}` : normalizeName(nameRaw)
    out.push({ txnDate: dateStr, amount: Math.round(amount * 100) / 100, nameRaw, memo, checkNumber, nameNorm })
  }
  return out
}

/**
 * Assign occurrence numbers (1, 2, 3…) to identical (date, amount, nameNorm)
 * tuples within a batch — same-day identical bank rows (two $7.15 sanitary
 * debits on the same day) are BOTH real and must both survive dedup.
 */
export function withOccurrences(rows: ParsedBankRow[]): (ParsedBankRow & { occurrence: number })[] {
  const seen = new Map<string, number>()
  return rows.map(r => {
    const key = `${r.txnDate}|${r.amount.toFixed(2)}|${r.nameNorm}`
    const n = (seen.get(key) || 0) + 1
    seen.set(key, n)
    return { ...r, occurrence: n }
  })
}

/** Stable dedup hash. Re-uploading an overlapping export is a no-op. */
export function importHash(accountId: number, r: ParsedBankRow & { occurrence: number }): string {
  return createHash('sha256')
    .update(`${accountId}|${r.txnDate}|${r.amount.toFixed(2)}|${r.nameNorm}|${r.occurrence}`)
    .digest('hex')
}

/** Friendly display name for the UI (normalized, but title-ish, with check no.). */
export function displayName(r: { nameRaw: string; checkNumber: string | null; nameNorm: string }): string {
  if (r.checkNumber) {
    const extra = r.nameRaw.replace(/^CHECK\s*/i, '').trim()
    return `Check #${r.checkNumber}${extra ? ` — ${extra}` : ''}`
  }
  return r.nameNorm
}
