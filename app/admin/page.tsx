import { auth, currentUser } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import sql from '@/lib/db'
import { initDb } from '@/lib/init-db'

const ADMIN_EMAIL = 'david.dyer.24@gmail.com'

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
      </div>
    </main>
  )
}
