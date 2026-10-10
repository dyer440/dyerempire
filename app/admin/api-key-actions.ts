'use server'
// app/admin/api-key-actions.ts
// Create / revoke bot API keys. Admin only, re-checked inside every action (the
// page-level redirect is not a guard for server actions). The plaintext key is
// returned exactly once, to the admin's browser, and never stored.
import { currentUser } from '@clerk/nextjs/server'
import { revalidatePath } from 'next/cache'
import sql from '@/lib/db'
import { ADMIN_EMAIL } from '@/lib/constants'
import { generateApiKey, isScope, type Scope } from '@/lib/api/keys'

async function requireAdmin(): Promise<string> {
  const user = await currentUser()
  const email = (user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress ?? '').toLowerCase()
  if (email !== ADMIN_EMAIL) throw new Error('Not authorized.')
  return email
}

export type CreateKeyState =
  | { status: 'idle' }
  | { status: 'created'; name: string; key: string; scopes: Scope[] }
  | { status: 'error'; message: string }

export async function createApiKey(_prev: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const admin = await requireAdmin()
  const name = String(formData.get('name') || '').trim()
  if (!/^[A-Za-z0-9 _.-]{2,40}$/.test(name)) {
    return { status: 'error', message: 'Name must be 2–40 letters, numbers, spaces, dots, dashes or underscores.' }
  }
  const scopes = formData.getAll('scopes').map(String).filter(isScope)
  if (scopes.length === 0) return { status: 'error', message: 'Pick at least one scope.' }
  const days = Number(formData.get('expires_days') || 0)
  const expiresDays = Number.isInteger(days) && days > 0 ? Math.min(days, 3650) : null

  const { key, prefix, hash } = generateApiKey()
  try {
    await sql`
      INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_by, expires_at)
      VALUES (${name}, ${prefix}, ${hash}, ${scopes}::text[], ${admin},
              CASE WHEN ${expiresDays}::int IS NULL THEN NULL ELSE NOW() + make_interval(days => ${expiresDays}::int) END)
    `
  } catch (e) {
    return { status: 'error', message: `Could not create key. Has migrations/2026-10_bot_api.sql been run? (${(e as Error).message})` }
  }
  revalidatePath('/admin')
  return { status: 'created', name, key, scopes }
}

export async function revokeApiKey(formData: FormData): Promise<void> {
  await requireAdmin()
  const id = Number(formData.get('id'))
  if (!Number.isInteger(id) || id <= 0) return
  await sql`UPDATE api_keys SET revoked_at = NOW() WHERE id = ${id} AND revoked_at IS NULL`
  revalidatePath('/admin')
}
