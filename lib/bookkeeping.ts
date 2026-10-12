// lib/bookkeeping.ts
// The bookkeeping method adopted in October 2026 (project doc
// bookkeeping-method-mgmt-fee-and-owner-funds-2026-10.md):
//   • SLCM retains a 20% management fee on rent actually collected each month at
//     the properties it manages for the family (524, 6th St, Belford, 913). Each
//     month's fee is a PAIR of journal rows sharing a transfer_group: the
//     property's Management Fee expense and SLCM's Management Fee Income. No cash
//     moves, so neither leg is ever matched to a bank line.
//   • Mortgage payments made from David's personal account post to the property
//     book with method 'owner personal account', split into interest, principal
//     and escrow funding.
//   • An owner's personal spending paid by an entity is an Owner Distribution,
//     never an expense.
import sql from './db'

export const OWNER_PERSONAL_METHOD = 'owner personal account'
export const MGMT_FEE_RATE = 0.2
/** Properties that pay SLCM's fee. 1219 and 500 West do not (third-party partner). */
export const MGMT_FEE_PROPERTY_SLUGS = ['524-10th-ave', '6th-st-duplex', 'belford', '913'] as const
export const SLCM_SLUG = 'second-line-capital-mgmt'

let ready: Promise<void> | null = null

/** Categories and the SL Holdings entity this method needs. Safe to run repeatedly. */
export function ensureBookkeeping(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      try {
        await sql`
          INSERT INTO categories (name, kind, form_8825_line, is_active, sort_order)
          SELECT v.name, v.kind, NULL, TRUE, (SELECT COALESCE(MAX(sort_order), 0) FROM categories) + v.ord
          FROM (VALUES ('Management Fee Income', 'income', 1), ('Escrow Funding', 'expense', 2),
                       ('Owner Distribution', 'expense', 3), ('Payroll Taxes', 'expense', 4)) AS v(name, kind, ord)
          WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.name = v.name)`
      } catch (e) { console.error('[bookkeeping] categories:', e) }
      try {
        await sql`
          INSERT INTO entities (slug, name, legal_name, type, status, notes)
          SELECT 'sl-holdings', 'SL Holdings', 'Second Line Holdings LLC', 'holding_co', 'active',
                 'Holds 50% of 913 and minority interests in 1219 and 500 West. Receives the SL Media royalty sweep.'
          WHERE NOT EXISTS (SELECT 1 FROM entities WHERE slug = 'sl-holdings')`
      } catch (e) { console.error('[bookkeeping] entity:', e) }
    })()
  }
  return ready
}
