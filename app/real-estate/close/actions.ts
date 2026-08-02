// app/real-estate/close/actions.ts
'use server'
// Thin wrappers for the Quarter Close & Distribute worksheet. All real logic
// lives in the existing actions (recordDistribution / clearDistribution /
// closePeriod / reopenPeriod) — these just delegate and then revalidate the
// worksheet path so the page reflects each step immediately.
import { revalidatePath } from 'next/cache'
import { recordDistribution, clearDistribution } from '../distributions/actions'
import { closePeriod, reopenPeriod } from '../recurring/actions'

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
