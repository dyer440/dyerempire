import { auth, currentUser } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'
import { ADMIN_EMAIL } from '@/lib/constants'
import ApiKeyCreator from './ApiKeyCreator'
import { revokeApiKey } from './api-key-actions'

type ApiKeyRow = {
  id: number; name: string; key_prefix: string; scopes: string[]
  created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null
}
type ChangeRow = { id: number; at: string; actor: string; action: string; target_table: string; target_id: number | null }

// Bot keys + recent bot writes. Wrapped so the page still renders before
// migrations/2026-10_bot_api.sql has been run.
async function getBotData(): Promise<{ keys: ApiKeyRow[]; changes: ChangeRow[]; ready: boolean }> {
  try {
    const keys = (await sql`
      SELECT id, name, key_prefix, scopes,
             to_char(created_at, 'YYYY-MM-DD') AS created_at,
             to_char(last_used_at, 'YYYY-MM-DD HH24:MI') AS last_used_at,
             to_char(expires_at, 'YYYY-MM-DD') AS expires_at,
             to_char(revoked_at, 'YYYY-MM-DD') AS revoked_at
      FROM api_keys ORDER BY revoked_at NULLS FIRST, created_at DESC
    `) as ApiKeyRow[]
    const changes = (await sql`
      SELECT id, to_char(at, 'YYYY-MM-DD HH24:MI') AS at, actor, action, target_table, target_id
      FROM mutations_log ORDER BY id DESC LIMIT 25
    `) as ChangeRow[]
    return { keys, changes, ready: true }
  } catch {
    return { keys: [], changes: [], ready: false }
  }
}

async function getUsers() {
  await initDb()
  return await sql`SELECT * FROM allowed_users ORDER BY created_at DESC`
}

async function requireAdmin() {
  const user = await currentUser()
  const email = user?.emailAddresses[0]?.emailAddress
  if (email !== ADMIN_EMAIL) throw new Error('Not authorized.')
}

async function addUser(formData: FormData) {
  'use server'
  await requireAdmin()
  const email = formData.get('email') as string
  const name = formData.get('name') as string
  if (!email) return
  await sql`
    INSERT INTO allowed_users (email, name)
    VALUES (${email}, ${name})
    ON CONFLICT (email) DO NOTHING
  `
}

async function removeUser(formData: FormData) {
  'use server'
  await requireAdmin()
  const email = formData.get('email') as string
  if (!email || email === ADMIN_EMAIL) return
  await sql`DELETE FROM allowed_users WHERE email = ${email}`
}

export default async function AdminPage() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')

  const user = await currentUser()
  const email = user?.emailAddresses[0]?.emailAddress

  if (email !== ADMIN_EMAIL) redirect('/')

  const users = await getUsers()
  const bot = await getBotData()

  return (
    <main className="min-h-screen bg-black text-white p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-10">
          <h1 className="text-2xl tracking-[0.3em] uppercase" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
            Manage Access
          </h1>
          <a href="/" className="text-white/40 hover:text-white text-sm tracking-widest uppercase transition-colors">
            ← Home
          </a>
        </div>

        {/* Add User Form */}
        <form action={addUser} className="mb-10 border border-white/10 p-6">
          <h2 className="text-sm tracking-widest uppercase text-white/50 mb-4">Add User</h2>
          <div className="flex flex-col gap-3">
            <input
              name="name"
              placeholder="Name"
              className="bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 text-sm"
            />
            <input
              name="email"
              type="email"
              placeholder="Email address"
              required
              className="bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 text-sm"
            />
            <button
              type="submit"
              className="border border-white/30 px-6 py-2 text-sm tracking-widest uppercase hover:bg-white/10 transition-all self-start"
            >
              Add
            </button>
          </div>
        </form>

        {/* User List */}
        <div className="border border-white/10">
          <div className="px-6 py-3 border-b border-white/10 text-xs tracking-widest uppercase text-white/40">
            Allowed Users ({users.length})
          </div>
          {(users as { email: string; name: string }[]).map((u) => (
            <div key={u.email} className="flex items-center justify-between px-6 py-4 border-b border-white/5 hover:bg-white/5">
              <div>
                <div className="text-sm text-white">{u.name || '—'}</div>
                <div className="text-xs text-white/40 mt-0.5">{u.email}</div>
              </div>
              {u.email !== ADMIN_EMAIL && (
                <form action={removeUser}>
                  <input type="hidden" name="email" value={u.email} />
                  <button
                    type="submit"
                    className="text-xs text-white/30 hover:text-red-400 tracking-widest uppercase transition-colors"
                  >
                    Remove
                  </button>
                </form>
              )}
              {u.email === ADMIN_EMAIL && (
                <span className="text-xs text-white/20 tracking-widest uppercase">Admin</span>
              )}
            </div>
          ))}
        </div>

        {/* Bot API */}
        <div className="mt-14">
          <h2 className="text-xl tracking-[0.3em] uppercase mb-6" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
            Bot API
          </h2>
          {!bot.ready && (
            <p className="mb-6 text-sm text-amber-300">
              Run <code>migrations/2026-10_bot_api.sql</code> in Neon to enable bot keys.
            </p>
          )}
          <ApiKeyCreator />

          <div className="border border-white/10 mb-10">
            <div className="px-6 py-3 border-b border-white/10 text-xs tracking-widest uppercase text-white/40">
              Keys ({bot.keys.length})
            </div>
            {bot.keys.map((k) => (
              <div key={k.id} className={`flex items-center justify-between px-6 py-4 border-b border-white/5 ${k.revoked_at ? 'opacity-40' : ''}`}>
                <div>
                  <div className="text-sm text-white">
                    {k.name} <span className="text-white/40 font-mono text-xs">{k.key_prefix}…</span>
                  </div>
                  <div className="text-xs text-white/40 mt-0.5">
                    {k.scopes.join(', ')} · created {k.created_at} · last used {k.last_used_at ?? 'never'}
                    {k.expires_at ? ` · expires ${k.expires_at}` : ''}
                    {k.revoked_at ? ` · revoked ${k.revoked_at}` : ''}
                  </div>
                </div>
                {!k.revoked_at && (
                  <form action={revokeApiKey}>
                    <input type="hidden" name="id" value={k.id} />
                    <button type="submit" className="text-xs text-white/30 hover:text-red-400 tracking-widest uppercase transition-colors">
                      Revoke
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>

          <div className="border border-white/10">
            <div className="px-6 py-3 border-b border-white/10 text-xs tracking-widest uppercase text-white/40">
              Recent bot changes
            </div>
            {bot.changes.length === 0 && <div className="px-6 py-4 text-sm text-white/30">None yet.</div>}
            {bot.changes.map((c) => (
              <div key={c.id} className="px-6 py-2 border-b border-white/5 text-xs text-white/60 font-mono">
                {c.at} · {c.actor} · {c.action} · {c.target_table}#{c.target_id ?? '–'}
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}
