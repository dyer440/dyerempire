// lib/init-db.ts  (adds capital_contributions, depreciation_schedule, annual_income)
import sql from './db'

export async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS allowed_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'viewer',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`ALTER TABLE allowed_users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'viewer'`
  await sql`
    INSERT INTO allowed_users (email, name, role)
    VALUES ('david.dyer.24@gmail.com', 'David Dyer', 'admin')
    ON CONFLICT (email) DO UPDATE SET role = 'admin'
  `

  await sql`
    CREATE TABLE IF NOT EXISTS page_access (
      id SERIAL PRIMARY KEY, page_key TEXT NOT NULL, email TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE (page_key, email)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS owners (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'entity',
      email TEXT, created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, holding_entity TEXT, property_type TEXT,
      address TEXT, city TEXT, state TEXT, zip TEXT, status TEXT DEFAULT 'active',
      purchase_date DATE, purchase_price DECIMAL(12,2), notes TEXT, created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS units (
      id SERIAL PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      label TEXT NOT NULL, address TEXT, notes TEXT
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS property_owners (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      ownership_pct DECIMAL(7,4) NOT NULL, UNIQUE (property_id, owner_id)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
      type TEXT NOT NULL, category TEXT NOT NULL, amount DECIMAL(12,2) NOT NULL,
      txn_date DATE NOT NULL, description TEXT, method TEXT, created_by TEXT,
      status TEXT DEFAULT 'actual', created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'actual'`
  await sql`CREATE INDEX IF NOT EXISTS idx_txn_property ON transactions(property_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date)`
  await sql`CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status)`

  await sql`
    CREATE TABLE IF NOT EXISTS recurring_schedules (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
      type TEXT NOT NULL, category TEXT NOT NULL, description TEXT,
      amount DECIMAL(12,2) NOT NULL, is_estimate BOOLEAN DEFAULT FALSE,
      frequency TEXT NOT NULL, months_csv TEXT, day_of_month INTEGER DEFAULT 15,
      growth_pct DECIMAL(6,2) DEFAULT 0, start_date DATE, end_date DATE,
      status TEXT DEFAULT 'active', created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS period_closes (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      period_start DATE NOT NULL, period_end DATE NOT NULL, label TEXT NOT NULL,
      closed_by TEXT, closed_at TIMESTAMP DEFAULT NOW(), UNIQUE (property_id, label)
    )
  `

  // --- capital accounts ---
  await sql`
    CREATE TABLE IF NOT EXISTS capital_contributions (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) NOT NULL, contributed_on DATE NOT NULL, note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS depreciation_schedule (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      year INTEGER NOT NULL, amount DECIMAL(12,2) NOT NULL, UNIQUE (property_id, year)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS annual_income (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      year INTEGER NOT NULL, real_net_income DECIMAL(12,2) NOT NULL, note TEXT,
      UNIQUE (property_id, year)
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS leases (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
      monthly_rent DECIMAL(12,2), rent_due_day INTEGER DEFAULT 1, deposit_amount DECIMAL(12,2),
      start_date DATE, end_date DATE, status TEXT DEFAULT 'active', created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS rent_charges (
      id SERIAL PRIMARY KEY, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
      period_month DATE NOT NULL, amount_due DECIMAL(12,2) NOT NULL, status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE (lease_id, period_month)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY, lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
      amount_held DECIMAL(12,2) NOT NULL, received_on DATE, returned_on DATE,
      status TEXT DEFAULT 'held', notes TEXT
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS obligations (
      id SERIAL PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      type TEXT NOT NULL, description TEXT, amount DECIMAL(12,2), due_date DATE,
      frequency TEXT DEFAULT 'annual', status TEXT DEFAULT 'upcoming',
      paid_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS distributions (
      id SERIAL PRIMARY KEY, period TEXT NOT NULL,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) NOT NULL, distributed_on DATE, status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
      lease_id INTEGER REFERENCES leases(id) ON DELETE CASCADE,
      doc_type TEXT, filename TEXT, blob_url TEXT, uploaded_at TIMESTAMP DEFAULT NOW()
    )
  `
}
