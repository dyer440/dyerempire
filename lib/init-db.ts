// lib/init-db.ts  (REWRITE — idempotent; includes future-phase tables so we never migrate)
import sql from './db'

export async function initDb() {
  // --- existing allowlist table (now with role) ---
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

  // --- owning parties (entities or individuals that hold equity) ---
  await sql`
    CREATE TABLE IF NOT EXISTS owners (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'entity',      -- 'entity' | 'individual'
      email TEXT,                                -- login this party maps to (for access)
      created_at TIMESTAMP DEFAULT NOW()
    )
  `

  // --- properties (the building / parcel) ---
  await sql`
    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      holding_entity TEXT,                       -- e.g. '500 West LLC' or 'Personal'
      property_type TEXT,                        -- 'single_family' | 'duplex' | ...
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      status TEXT DEFAULT 'active',
      purchase_date DATE,
      purchase_price DECIMAL(12,2),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `

  // --- rentable units (a duplex has two; an SFH has one) ---
  await sql`
    CREATE TABLE IF NOT EXISTS units (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      address TEXT,
      notes TEXT
    )
  `

  // --- equity splits (drives distributions AND access) ---
  await sql`
    CREATE TABLE IF NOT EXISTS property_owners (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      ownership_pct DECIMAL(7,4) NOT NULL,
      UNIQUE (property_id, owner_id)
    )
  `

  // --- the ledger: one categorized row per dollar in or out ---
  await sql`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
      type TEXT NOT NULL,                         -- 'income' | 'expense'
      category TEXT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      txn_date DATE NOT NULL,
      description TEXT,
      method TEXT,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_txn_property ON transactions(property_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date)`

  // --- Phase 2+ tables (created now so later phases drop in without migration) ---
  await sql`
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL, email TEXT, phone TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS leases (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
      monthly_rent DECIMAL(12,2), rent_due_day INTEGER DEFAULT 1,
      deposit_amount DECIMAL(12,2),
      start_date DATE, end_date DATE,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS rent_charges (
      id SERIAL PRIMARY KEY,
      lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
      period_month DATE NOT NULL,                -- first of the month owed
      amount_due DECIMAL(12,2) NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (lease_id, period_month)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
      amount_held DECIMAL(12,2) NOT NULL,
      received_on DATE, returned_on DATE,
      status TEXT DEFAULT 'held',                -- 'held' | 'returned' | 'forfeited'
      notes TEXT
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS obligations (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      type TEXT NOT NULL,                         -- 'insurance' | 'property_tax' | 'mortgage' | 'other'
      description TEXT, amount DECIMAL(12,2),
      due_date DATE, frequency TEXT DEFAULT 'annual',
      status TEXT DEFAULT 'upcoming',
      paid_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS distributions (
      id SERIAL PRIMARY KEY,
      period TEXT NOT NULL,                       -- e.g. '2026-Q1'
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      amount DECIMAL(12,2) NOT NULL,
      distributed_on DATE, status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
      lease_id INTEGER REFERENCES leases(id) ON DELETE CASCADE,
      doc_type TEXT, filename TEXT, blob_url TEXT,
      uploaded_at TIMESTAMP DEFAULT NOW()
    )
  `
}
