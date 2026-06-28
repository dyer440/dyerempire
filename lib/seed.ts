// lib/seed.ts  (NEW — runs once when properties table is empty; roles always kept current)
import sql from './db'

export async function seedRealEstate() {
  // Roles / allowlist — always upsert so these three are correct even on an existing DB.
  await sql`INSERT INTO allowed_users (email, name, role) VALUES ('david.dyer.24@gmail.com','David Dyer','admin')
            ON CONFLICT (email) DO UPDATE SET role = 'admin'`
  await sql`INSERT INTO allowed_users (email, name, role) VALUES ('betsyedyer@gmail.com','Betsy Dyer','manager')
            ON CONFLICT (email) DO UPDATE SET role = 'manager'`
  await sql`INSERT INTO allowed_users (email, name, role) VALUES ('zacharyevans@gmail.com','Zachary Evans','partner')
            ON CONFLICT (email) DO UPDATE SET role = 'partner'`

  // Only seed the portfolio once.
  const existing = await sql`SELECT id FROM properties LIMIT 1`
  if ((existing as { id: number }[]).length > 0) return

  // --- owning parties ---
  const owners = [
    { name: 'Black Sevens LLC',          type: 'entity',     email: 'zacharyevans@gmail.com' },
    { name: 'Second Line Holdings LLC',  type: 'entity',     email: 'david.dyer.24@gmail.com' },
    { name: 'David Dyer',                type: 'individual', email: 'david.dyer.24@gmail.com' },
    { name: 'Elizabeth Dyer',            type: 'individual', email: 'betsyedyer@gmail.com' },
  ]
  const ownerId: Record<string, number> = {}
  for (const o of owners) {
    const r = await sql`INSERT INTO owners (name, type, email) VALUES (${o.name}, ${o.type}, ${o.email}) RETURNING id`
    ownerId[o.name] = (r as { id: number }[])[0].id
  }

  async function addProperty(
    p: { name: string; holding: string; type: string; address: string },
    units: { label: string; address: string }[],
    splits: { owner: string; pct: number }[],
  ) {
    const r = await sql`
      INSERT INTO properties (name, holding_entity, property_type, address, city, state, zip, status)
      VALUES (${p.name}, ${p.holding}, ${p.type}, ${p.address}, 'Huntington', 'WV', '25701', 'active')
      RETURNING id`
    const pid = (r as { id: number }[])[0].id
    for (const u of units) {
      await sql`INSERT INTO units (property_id, label, address) VALUES (${pid}, ${u.label}, ${u.address})`
    }
    for (const s of splits) {
      await sql`INSERT INTO property_owners (property_id, owner_id, ownership_pct)
                VALUES (${pid}, ${ownerId[s.owner]}, ${s.pct})`
    }
  }

  await addProperty(
    { name: '500 West', holding: '500 West LLC', type: 'duplex', address: '500 11th Ave West' },
    [{ label: '500 11th Ave W', address: '500 11th Ave West' },
     { label: '500½ 11th Ave W', address: '500 1/2 11th Ave West' }],
    [{ owner: 'Black Sevens LLC', pct: 81.12 }, { owner: 'Second Line Holdings LLC', pct: 18.88 }],
  )

  await addProperty(
    { name: '1219', holding: '1219 LLC', type: 'single_family', address: '1219 9th Street' },
    [{ label: 'Main', address: '1219 9th Street' }],
    [{ owner: 'Black Sevens LLC', pct: 82.31 }, { owner: 'Second Line Holdings LLC', pct: 17.69 }],
  )

  // ⚠️ Personal split assumed 50/50 — change these pct values if different.
  await addProperty(
    { name: '6th St Duplex', holding: 'Personal (David & Elizabeth Dyer)', type: 'duplex', address: '926 6th St' },
    [{ label: '926 6th St', address: '926 6th St' }, { label: '928 6th St', address: '928 6th St' }],
    [{ owner: 'David Dyer', pct: 50 }, { owner: 'Elizabeth Dyer', pct: 50 }],
  )
  await addProperty(
    { name: '524 10th Ave', holding: 'Personal (David & Elizabeth Dyer)', type: 'single_family', address: '524 10th Ave' },
    [{ label: 'Main', address: '524 10th Ave' }],
    [{ owner: 'David Dyer', pct: 50 }, { owner: 'Elizabeth Dyer', pct: 50 }],
  )
  await addProperty(
    { name: 'Belford', holding: 'Personal (David & Elizabeth Dyer)', type: 'single_family', address: '218 Belford Ave' },
    [{ label: 'Main', address: '218 Belford Ave' }],
    [{ owner: 'David Dyer', pct: 50 }, { owner: 'Elizabeth Dyer', pct: 50 }],
  )

  await addProperty(
    { name: '913', holding: '913 LLC', type: 'single_family', address: '913 2nd Street West' },
    [{ label: 'Main', address: '913 2nd Street West' }],
    [{ owner: 'Second Line Holdings LLC', pct: 50 }, { owner: 'Elizabeth Dyer', pct: 50 }],
  )
}
