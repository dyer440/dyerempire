import sql from './db'

export async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS allowed_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `

  // Seed admin user
  await sql`
    INSERT INTO allowed_users (email, name)
    VALUES ('david.dyer.24@gmail.com', 'David Dyer')
    ON CONFLICT (email) DO NOTHING
  `
}
