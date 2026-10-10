// lib/api/validate.ts
// Input coercion for bot requests. Bots (and LLMs especially) send numbers as
// strings, omit fields, and invent formats, so every value is normalised here
// and rejected with a message that tells the bot exactly what to send instead.
import { badRequest } from './errors'

export type Input = Record<string, unknown>

const present = (v: unknown) => v !== undefined && v !== null && v !== ''

export function optInt(input: Input, name: string): number | null {
  const v = input[name]
  if (!present(v)) return null
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name} must be a positive integer.`)
  return n
}

export function reqInt(input: Input, name: string): number {
  const n = optInt(input, name)
  if (n === null) throw badRequest(`${name} is required.`)
  return n
}

export function optDate(input: Input, name: string): string | null {
  const v = input[name]
  if (!present(v)) return null
  const s = String(v).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) {
    throw badRequest(`${name} must be a date in YYYY-MM-DD format.`)
  }
  // Reject impossible dates like 2026-02-31 that Date.parse would roll over.
  const d = new Date(s + 'T00:00:00Z')
  if (d.toISOString().slice(0, 10) !== s) throw badRequest(`${name} is not a real calendar date.`)
  return s
}

export function reqDate(input: Input, name: string): string {
  const d = optDate(input, name)
  if (d === null) throw badRequest(`${name} is required (YYYY-MM-DD).`)
  return d
}

/** Positive money amount rounded to cents. Sign is carried by `type`, never by amount. */
export function optAmount(input: Input, name: string): number | null {
  const v = input[name]
  if (!present(v)) return null
  const n = Number(typeof v === 'string' ? v.replace(/[$,\s]/g, '') : v)
  if (!Number.isFinite(n) || n <= 0) {
    throw badRequest(`${name} must be a positive number. Amounts are always positive; use type income/expense for direction.`)
  }
  if (n >= 10_000_000) throw badRequest(`${name} is implausibly large.`)
  return Math.round(n * 100) / 100
}

export function reqAmount(input: Input, name: string): number {
  const n = optAmount(input, name)
  if (n === null) throw badRequest(`${name} is required.`)
  return n
}

export function optString(input: Input, name: string, max = 500): string | null {
  const v = input[name]
  if (!present(v)) return null
  const s = String(v).trim()
  if (s.length > max) throw badRequest(`${name} is longer than ${max} characters.`)
  return s || null
}

export function optBool(input: Input, name: string): boolean | null {
  const v = input[name]
  if (!present(v)) return null
  if (v === true || v === 'true' || v === '1' || v === 1) return true
  if (v === false || v === 'false' || v === '0' || v === 0) return false
  throw badRequest(`${name} must be true or false.`)
}

export function optEnum<T extends string>(input: Input, name: string, allowed: readonly T[]): T | null {
  const v = input[name]
  if (!present(v)) return null
  const s = String(v).trim()
  if (!(allowed as readonly string[]).includes(s)) {
    throw badRequest(`${name} must be one of: ${allowed.join(', ')}.`)
  }
  return s as T
}

export function optRentalPeriod(input: Input, name = 'rental_period'): string | null {
  const v = optString(input, name, 7)
  if (v === null) return null
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw badRequest(`${name} must be YYYY-MM.`)
  return v
}

export function optPeriod(input: Input, name = 'period'): string | null {
  const v = optString(input, name, 7)
  if (v === null) return null
  if (!/^\d{4}-Q[1-4]$/.test(v)) throw badRequest(`${name} must look like 2026-Q3.`)
  return v
}

export function clampInt(input: Input, name: string, dflt: number, min: number, max: number): number {
  const v = input[name]
  if (!present(v)) return dflt
  const n = Number(v)
  if (!Number.isInteger(n)) throw badRequest(`${name} must be an integer.`)
  return Math.max(min, Math.min(max, n))
}

/** Query-string → plain object (last value wins). */
export function searchParamsToInput(sp: URLSearchParams): Input {
  const out: Input = {}
  sp.forEach((v, k) => { out[k] = v })
  return out
}
