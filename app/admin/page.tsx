import { auth, currentUser } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
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

const ROLES = ['manager', 'partner', 'viewer'] as const
// Pages granted one by one (page_access). Insiders see all of them anyway.
const PAGES: [string, string][] = [['media-tct', 'The Coal Trader'], ['media-ree', 'The REE Trader'], ['thomas-car', "Thomas's Car"]]
const ROLE_NOTE: Record<string, string> = {
  admin: 'Everything',
  manager: 'Every property and company, and the note box',
  partner: 'Only properties where their email is on the owner record',
  viewer: 'No real-estate pages; only pages granted separately',
}

async function addUser(formData: FormData) {
  'use server'
  await requireAdmin()
  const email = String(formData.get('email') || '').trim().toLowerCase()
  const name = String(formData.get('name') || '').trim()
  const roleIn = String(formData.get('role') || 'viewer')
  const role = (ROLES as readonly string[]).includes(roleIn) ? roleIn : 'viewer'
  if (!email) return
  const pages = formData.getAll('pages').map(String).filter((k) => PAGES.some(([key]) => key === k))
  for (const k of pages) {
    await sql`INSERT INTO page_access (page_key, email) VALUES (${k}, ${email}) ON CONFLICT (page_key, email) DO NOTHING`
  }
  await sql`
    INSERT INTO allowed_users (email, name, role)
    VALUES (${email}, ${name}, ${role})
    ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, name = COALESCE(NULLIF(EXCLUDED.name, ''), allowed_users.name)
  `
  revalidatePath('/admin')
}

async function removeUser(formData: FormData) {
  'use server'
  await requireAdmin()
  const email = formData.get('email') as string
  if (!email || email === ADMIN_EMAIL) return
  await sql`DELETE FROM allowed_users WHERE email = ${email}`
  await sql`DELETE FROM page_access WHERE lower(email) = lower(${email})`
  revalidatePath('/admin')
}

async function removePage(formData: FormData) {
  'use server'
  await requireAdmin()
  await sql`DELETE FROM page_access WHERE lower(email) = lower(${String(formData.get('email'))}) AND page_key = ${String(formData.get('page'))}`
  revalidatePath('/admin')
}

export default async function AdminPage() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')

  const user = await currentUser()
  const email = user?.emailAddresses[0]?.emailAddress

  if (email !== ADMIN_EMAIL) redirect('/')

  const users = await getUsers()
  const access = (await sql`SELECT lower(email) AS email, page_key FROM page_access ORDER BY page_key`) as { email: string; page_key: string }[]
  const pageName = (k: string) => PAGES.find(([key]) => key === k)?.[1] ?? k
  const bot = await getBotData()

  const field = 'rounded-md border border-rule bg-surface px-3 py-2 text-[15px] placeholder:text-faint focus:border-brass focus:outline-none'
  const userRows = users as { email: string; name: string | null; role: string | null }[]

  return (
    <main className="max-w-3xl space-y-12">
      <h1 className="font-serif text-4xl font-medium tracking-tight">Admin</h1>

      <section aria-labelledby="users-h">
        <h2 id="users-h" className="font-serif text-2xl">People</h2>
        <form action={addUser} className="mt-4 grid gap-3 rounded-lg border border-rule bg-surface p-4 sm:grid-cols-[1fr_1.4fr_auto_auto]">
          <label className="sr-only" htmlFor="u-name">Name</label>
          <input id="u-name" name="name" placeholder="Name" className={field} />
          <label className="sr-only" htmlFor="u-email">Email</label>
          <input id="u-email" name="email" type="email" placeholder="Email address" required className={field} />
          <label className="sr-only" htmlFor="u-role">Role</label>
          <select id="u-role" name="role" defaultValue="partner" className={field}>
            {ROLES.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
          </select>
          <button type="submit" className="rounded-md bg-ink px-4 py-2 text-[14px] font-medium text-white hover:bg-ink/90">Add or update</button>
          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px] text-muted sm:col-span-4">
            <legend className="sr-only">Pages</legend>
            <span>Also give access to</span>
            {PAGES.map(([k, label]) => (
              <label key={k} className="flex items-center gap-1.5"><input type="checkbox" name="pages" value={k} className="accent-ink" /> {label}</label>
            ))}
          </fieldset>
        </form>
        <ul className="mt-4 divide-y divide-rule rounded-lg border border-rule bg-surface">
          {userRows.map((u) => {
            const role = u.email === ADMIN_EMAIL ? 'admin' : u.role || 'viewer'
            return (
              <li key={u.email} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[15px]">{u.name || u.email} <span className="text-[13px] text-muted">{role}</span></p>
                  <p className="truncate text-[13px] text-muted">{u.email}. {ROLE_NOTE[role]}.</p>
                  {access.some((a) => a.email === u.email.toLowerCase()) && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {access.filter((a) => a.email === u.email.toLowerCase()).map((a) => (
                        <form key={a.page_key} action={removePage} className="flex items-center gap-1 rounded bg-wash px-2 py-0.5 text-[13px]">
                          <input type="hidden" name="email" value={u.email} /><input type="hidden" name="page" value={a.page_key} />
                          {pageName(a.page_key)}
                          <button type="submit" aria-label={`Remove ${pageName(a.page_key)}`} className="text-muted hover:text-late">&times;</button>
                        </form>
                      ))}
                    </div>
                  )}
                </div>
                {u.email !== ADMIN_EMAIL && (
                  <form action={removeUser}>
                    <input type="hidden" name="email" value={u.email} />
                    <button type="submit" className="text-[14px] text-muted hover:text-late">Remove</button>
                  </form>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="keys-h">
        <h2 id="keys-h" className="font-serif text-2xl">Bot keys</h2>
        {!bot.ready && (
          <p className="mt-2 text-[14px] text-late">Run migrations/2026-10_bot_api.sql in Neon to enable bot keys.</p>
        )}
        <div className="mt-4"><ApiKeyCreator /></div>
        <ul className="mt-4 divide-y divide-rule rounded-lg border border-rule bg-surface">
          {bot.keys.map((k) => (
            <li key={k.id} className={`flex items-center justify-between gap-4 px-4 py-3 ${k.revoked_at ? 'opacity-50' : ''}`}>
              <div className="min-w-0">
                <p className="text-[15px]">{k.name} <span className="text-[13px] text-muted">{k.key_prefix}</span></p>
                <p className="text-[13px] text-muted">
                  Can {k.scopes.join(', ')}. Created {k.created_at}, last used {k.last_used_at ?? 'never'}
                  {k.expires_at ? `, expires ${k.expires_at}` : ''}{k.revoked_at ? `, revoked ${k.revoked_at}` : ''}.
                </p>
              </div>
              {!k.revoked_at && (
                <form action={revokeApiKey}>
                  <input type="hidden" name="id" value={k.id} />
                  <button type="submit" className="text-[14px] text-muted hover:text-late">Revoke</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="changes-h">
        <h2 id="changes-h" className="font-serif text-2xl">Recent bot changes</h2>
        {bot.changes.length === 0 ? <p className="mt-3 text-muted">None yet.</p> : (
          <ul className="mt-4 divide-y divide-rule rounded-lg border border-rule bg-surface text-[14px]">
            {bot.changes.map((c) => (
              <li key={c.id} className="grid grid-cols-[8.5rem_5rem_minmax(0,1fr)] gap-3 px-4 py-2">
                <span className="num text-muted">{c.at}</span>
                <span className="truncate">{c.actor}</span>
                <span className="truncate">{c.action} <span className="text-muted">{c.target_table} {c.target_id ?? ''}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
