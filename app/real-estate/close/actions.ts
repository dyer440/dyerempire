// app/real-estate/close/actions.ts
'use server'
// Thin wrappers for the Quarter Close & Distribute worksheet. All real logic
// lives in the existing actions (recordDistribution / clearDistribution /
// closePeriod / reopenPeriod) — these just delegate and then revalidate the
// worksheet path so the page reflects each step immediately.
//
// LOAD-BEARING INVARIANT: these wrappers deliberately carry NO auth checks of
// their own — every delegate (recordDistribution, clearDistribution, closePeriod,
// reopenPeriod) re-checks role and property access server-side on entry. If a
// delegate ever loses its own guard, these become unauthenticated mutation
// endpoints. Do not "simplify" a delegate's guard away.
import { revalidatePath } from 'next/cache'
import { recordDistribution, clearDistribution } from '../distributions/actions'
import { closePeriod, reopenPeriod } from '../recurring/actions'
import sql from '@/lib/db'
import { getEditorEmail } from '@/lib/ledger-guard'

function refresh() {
  revalidatePath('/real-estate/close')
}

export async function wsRecordDistribution(formData: FormData) {
  await recordDistribution(formData)
  refresh()
}

export async function wsClearDistribution(formData: FormData) {
  await clearDistribution(formData)
  refresh()
}

export async function wsClosePeriod(formData: FormData) {
  await closePeriod(formData)
  refresh()
}

export async function wsReopenPeriod(formData: FormData) {
  await reopenPeriod(formData)
  refresh()
}

// Dismiss a duplicate-pair audit flag that's been reviewed and is legitimate.
// (Unlike the wrappers above this one owns its mutation, so it guards itself.)
export async function wsDismissPair(formData: FormData) {
  const editor = await getEditorEmail()
  if (!editor) throw new Error('Not authorized.')
  const a = Number(formData.get('txn_id_a'))
  const b = Number(formData.get('txn_id_b'))
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('Bad request.')
  const [lo, hi] = a < b ? [a, b] : [b, a]
  await sql`
    INSERT INTO reviewed_pairs (txn_id_a, txn_id_b, reviewed_by)
    VALUES (${lo}, ${hi}, ${editor})
    ON CONFLICT (txn_id_a, txn_id_b) DO NOTHING
  `
  refresh()
}
