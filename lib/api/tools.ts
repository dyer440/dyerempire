// lib/api/tools.ts
// The tool catalogue for MCP clients (GrokBot, Cursor, Claude). Each tool maps
// 1:1 to a service function, carries the scope it needs, and describes its
// inputs as JSON Schema so the model can call it without guessing.
import type { Scope } from './keys'
import type { Actor } from './service'
import * as svc from './service'
import { getPnl } from './reports'
import { getAttention } from './attention'
import { listPendingBank } from './bank'
import { importBankCsv } from './bank-import'
import { postBankTxn, matchBankTxn, excludeBankTxn, revertBankTxn } from './bank-post'
import { listSchedules, updateSchedule, createSchedule } from './schedules'
import { recordDistribution, closePeriod, reopenPeriod } from './periods'
import { describeSchema } from './schema'
import { listBookNotes, resolveBookNote } from './notes'
import { voidTransaction } from './void'
import { runReadOnlySql } from './sql-runner'
import { badRequest } from './errors'
import type { Input } from './validate'

type JsonSchema = Record<string, unknown>

export type Tool = {
  name: string
  title: string
  description: string
  scope: Scope
  inputSchema: JsonSchema
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: false }
  run: (args: Input, who: Actor) => Promise<unknown>
}

const int = (description: string) => ({ type: 'integer', minimum: 1, description })
const date = (description: string) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description })
const str = (description: string) => ({ type: 'string', description })
const money = (description: string) => ({ type: 'number', exclusiveMinimum: 0, description })
const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({
  type: 'object', properties, required, additionalProperties: false,
})

const READ = { readOnlyHint: true, openWorldHint: false } as const

function needId(args: Input): number {
  const id = Number(args.id)
  if (!Number.isInteger(id) || id <= 0) throw badRequest('id must be a positive integer.')
  return id
}

function withoutId(args: Input): Input {
  const { id: _id, ...rest } = args
  void _id
  return rest
}

export const TOOLS: Tool[] = [
  {
    name: 'get_attention',
    title: 'Maintenance checklist',
    description:
      'Start here for daily/weekly maintenance. Returns open notes from the website note box, late rent per unit (tenant, months, total owed), units collecting rent without a schedule, overdue scheduled items, pending bank rows, recent months with no rent, ' +
      'possible duplicate entries, tax/insurance due in 60 days, co-owned properties whose last quarter is not closed, and ' +
      'recurring schedules that need forecasts regenerated. Each section includes ids you can act on with the other tools.',
    scope: 'read',
    inputSchema: obj({}),
    annotations: READ,
    run: () => getAttention(),
  },
  {
    name: 'list_properties',
    title: 'List properties',
    description: 'All properties with id, holding entity, owners and ownership %, units and current tenants. Use the ids in other tools.',
    scope: 'read',
    inputSchema: obj({}),
    annotations: READ,
    run: () => svc.listProperties(),
  },
  {
    name: 'list_entities',
    title: 'List entities',
    description: 'Legal entities (management co SLCM, holding cos, properties, people). entity_id in other tools means that entity\'s own books.',
    scope: 'read',
    inputSchema: obj({}),
    annotations: READ,
    run: () => svc.listEntities(),
  },
  {
    name: 'list_categories',
    title: 'List categories',
    description: 'Valid transaction categories with their kind (income/expense) and Form 8825 line. Use exact names when writing.',
    scope: 'read',
    inputSchema: obj({}),
    annotations: READ,
    run: () => svc.listCategories(),
  },
  {
    name: 'list_transactions',
    title: 'Search transactions',
    description:
      'Search the ledger. Defaults to actual (not scheduled) rows, newest first, 100 per page. ' +
      'Amounts are positive; type says income or expense. entity_id returns that entity\'s own books only.',
    scope: 'read',
    inputSchema: obj({
      property_id: int('Property id'),
      entity_id: int('Entity id (entity-level books only)'),
      status: { type: 'string', enum: ['actual', 'forecast', 'all'], description: 'Default actual' },
      type: { type: 'string', enum: ['income', 'expense'] },
      category: str('Exact category name'),
      from: date('Start date inclusive'),
      to: date('End date inclusive'),
      q: str('Text to find in the description'),
      min_amount: money('Minimum amount'),
      max_amount: money('Maximum amount'),
      deposits: { type: 'string', enum: ['include', 'exclude', 'only'], description: 'Security deposit rows. Default include' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0 },
    }),
    annotations: READ,
    run: (a) => svc.listTransactions(a),
  },
  {
    name: 'get_transaction',
    title: 'Get one transaction',
    description: 'One transaction by id, including whether it is bank-reconciled and its change history.',
    scope: 'read',
    inputSchema: obj({ id: int('Transaction id') }, ['id']),
    annotations: READ,
    run: (a) => svc.getTransaction(needId(a)),
  },
  {
    name: 'get_pnl',
    title: 'Profit and loss',
    description:
      'P&L on actuals with security deposits excluded. Scope: property_id, or entity_id (own books), or neither for all ' +
      'properties combined. Defaults to year-to-date. Returns net_all_in (cash view, governs distributions) and net_operating ' +
      '(before property taxes and insurance). group_by: category | month | property | form8825.',
    scope: 'read',
    inputSchema: obj({
      property_id: int('Property id'),
      entity_id: int('Entity id'),
      from: date('Default Jan 1 of this year'),
      to: date('Default today'),
      group_by: { type: 'string', enum: ['category', 'month', 'property', 'form8825'] },
    }),
    annotations: READ,
    run: (a) => getPnl(a),
  },
  {
    name: 'get_quarter',
    title: 'Quarter close computation',
    description:
      'The Quarter Close & Distribute engine for one property and quarter: income, expenses, reserve, retained cash, ' +
      'runway distributable and the owner split, plus what was recorded and whether the period is closed. Read-only; ' +
      'record the decision with record_distribution.',
    scope: 'read',
    inputSchema: obj({ property_id: int('Property id'), period: { type: 'string', pattern: '^\\d{4}-Q[1-4]$', description: 'e.g. 2026-Q3' } }, ['property_id', 'period']),
    annotations: READ,
    run: (a) => svc.getQuarter(a),
  },
  {
    name: 'get_capital_accounts',
    title: 'Capital accounts',
    description: 'Per-year partner capital accounts for a property (contributions, allocated income, distributions, ratios).',
    scope: 'read',
    inputSchema: obj({ property_id: int('Property id') }, ['property_id']),
    annotations: READ,
    run: (a) => svc.getCapital(a),
  },
  {
    name: 'list_pending_bank_txns',
    title: 'Pending bank rows',
    description: 'Imported bank rows not yet posted to the ledger, oldest first, each with the import rule the app would suggest and candidate ledger rows it may already be (match those with match_bank_txn).',
    scope: 'read',
    inputSchema: obj({ limit: { type: 'integer', minimum: 1, maximum: 500 } }),
    annotations: READ,
    run: (a) => listPendingBank(a),
  },
  {
    name: 'recent_changes',
    title: 'Recent bot changes',
    description: 'The audit log of writes made through the API, newest first. detail=true includes before/after JSON.',
    scope: 'read',
    inputSchema: obj({
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      actor: str('e.g. bot:GrokBot'),
      since: date('Only changes on or after this date'),
      detail: { type: 'boolean' },
    }),
    annotations: READ,
    run: (a) => svc.recentChanges(a),
  },
  {
    name: 'describe_schema',
    title: 'Database schema and conventions',
    description: 'Every table and column, plus the accounting conventions any SQL must follow. Read this before run_sql.',
    scope: 'sql',
    inputSchema: obj({}),
    annotations: READ,
    run: () => describeSchema(),
  },
  {
    name: 'run_sql',
    title: 'Run read-only SQL',
    description:
      'Run one read-only SQL statement (SELECT / WITH / EXPLAIN) against the Neon database and get rows back. Writes are ' +
      'impossible here. Use $1, $2 placeholders with params for values. Follow the conventions from describe_schema: ' +
      'status = \'actual\' and COALESCE(is_deposit, FALSE) = FALSE for any P&L figure.',
    scope: 'sql',
    inputSchema: obj({
      sql: str('A single SELECT/WITH/EXPLAIN statement'),
      params: { type: 'array', items: {}, description: 'Values for $1, $2, ...' },
      max_rows: { type: 'integer', minimum: 1, maximum: 2000, description: 'Default 500' },
    }, ['sql']),
    annotations: READ,
    run: (a) => runReadOnlySql(String(a.sql ?? ''), (a.params as unknown[]) ?? [], Number(a.max_rows ?? 500)),
  },
  {
    name: 'create_transaction',
    title: 'Record a transaction',
    description:
      'Record an ACTUAL income or expense. Send exactly one of property_id or entity_id. Category must be an existing name ' +
      '(type is derived from it). For security deposits send is_deposit=true with type income (collected) or expense ' +
      '(returned) and no category. Refused if the date is in a closed period, if an identical row exists, or if a scheduled ' +
      'item already covers it (then use confirm_forecast). Send allow_duplicate=true only when a second identical row is real. ' +
      'Send an idempotency_key so a retry can never double-book.',
    scope: 'write',
    inputSchema: obj({
      property_id: int('Property books'),
      entity_id: int('Entity books (e.g. SLCM)'),
      category: str('Exact category name from list_categories'),
      type: { type: 'string', enum: ['income', 'expense'], description: 'Optional except for deposits' },
      amount: money('Positive amount in dollars'),
      txn_date: date('Date cash moved'),
      description: str('Payee / memo'),
      unit_id: int('Unit, for multi-unit properties'),
      rental_period: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'Month a rent payment covers (YYYY-MM)' },
      is_deposit: { type: 'boolean' },
      allow_duplicate: { type: 'boolean' },
      idempotency_key: str('Unique per intended write, e.g. grok-2026-10-10-524-rent'),
    }, ['amount', 'txn_date']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (a, who) => svc.createTransaction(a, who),
  },
  {
    name: 'update_transaction',
    title: 'Edit a transaction',
    description:
      'Change category, amount, txn_date, description, rental_period or unit_id on an existing row. Status and direction ' +
      'cannot change. Refused for closed periods, and amount/date are fixed on bank-reconciled rows.',
    scope: 'write',
    inputSchema: obj({
      id: int('Transaction id'),
      category: str('New category (same income/expense kind)'),
      amount: money('New amount'),
      txn_date: date('New date'),
      description: { type: ['string', 'null'] },
      rental_period: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}$' },
      unit_id: { type: ['integer', 'null'] },
    }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (a, who) => svc.updateTransaction(needId(a), withoutId(a), who),
  },
  {
    name: 'confirm_forecast',
    title: 'Confirm a scheduled item',
    description:
      'Turn a scheduled (forecast) row into an actual, optionally correcting amount, date, description or category to what ' +
      'actually cleared. This is the right tool when a recurring bill or rent shows up in the bank.',
    scope: 'write',
    inputSchema: obj({
      id: int('Forecast transaction id'),
      amount: money('Actual amount, if different'),
      txn_date: date('Actual date, if different'),
      description: str('Description'),
      category: str('Category, if different'),
    }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (a, who) => svc.confirmForecast(needId(a), withoutId(a), who),
  },
  {
    name: 'delete_forecast',
    title: 'Delete a scheduled item',
    description: 'Delete a scheduled (forecast) row that will not happen. For a booked (actual) row use void_transaction.',
    scope: 'write',
    inputSchema: obj({ id: int('Forecast transaction id') }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (a, who) => svc.deleteForecast(needId(a), who),
  },
  {
    name: 'void_transaction',
    title: 'Void a booked transaction',
    description:
      'Remove an ACTUAL transaction that should not exist (a typo or a double entry). Needs confirm: true after David agrees, ' +
      'and a reason, which is logged with the full row. Refused inside a closed quarter and when a bank line is attached ' +
      '(use revert_bank_txn on that bank row instead). Prefer update_transaction when the row is real but wrong.',
    scope: 'write',
    inputSchema: obj({
      id: int('Transaction id'),
      confirm: { type: 'boolean', description: 'Must be true' },
      reason: str('Why it is being removed, e.g. "Duplicate of txn 2231"'),
    }, ['id', 'confirm', 'reason']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (a, who) => voidTransaction(a, who),
  },
  {
    name: 'import_bank_csv',
    title: 'Import a bank CSV',
    description:
      'Load a US Bank CSV export (columns Date, Transaction, Name, Memo, Amount) into the bank import queue. Pass the ' +
      'whole file text as csv. Rows already imported are skipped, so overlapping date ranges are safe. Nothing is ' +
      'booked to the ledger; rows wait as pending. account_id defaults to 1 (US Bank Checking 7848).',
    scope: 'write',
    inputSchema: obj({
      csv: str('Full CSV text including the header row'),
      account_id: int('bank_accounts.id, default 1'),
    }, ['csv']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (a, who) => importBankCsv(a, who),
  },
  {
    name: 'post_bank_txn',
    title: 'Post a bank row',
    description:
      'Book a pending bank row to the ledger as new actual transaction(s). Direction comes from the bank sign. One leg ' +
      'with no amount takes the whole bank amount; to split (e.g. a payment covering two properties) send several legs ' +
      'that add up exactly. Each leg: property_id or entity_id, category (must match direction), optional unit_id, ' +
      'rental_period (YYYY-MM, rent), description, is_deposit (security deposit collected). Pass rule_id when using the ' +
      'suggested rule. If a candidate in list_pending_bank_txns is the same item, use match_bank_txn instead.',
    scope: 'write',
    inputSchema: obj({
      bank_txn_id: int('Pending bank row id'),
      legs: {
        type: 'array', minItems: 1, maxItems: 20,
        items: obj({
          property_id: int('Property books'),
          entity_id: int('Entity books (SLCM, SL Media...)'),
          category: str('Exact category name'),
          amount: money('Leg amount; omit for a single leg'),
          unit_id: int('Unit'),
          rental_period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
          description: str('Memo; defaults to the bank counterparty'),
          is_deposit: { type: 'boolean' },
        }),
      },
      rule_id: int('Import rule that suggested this posting'),
    }, ['bank_txn_id', 'legs']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (a, who) => postBankTxn(a, who),
  },
  {
    name: 'match_bank_txn',
    title: 'Match a bank row to the ledger',
    description:
      'Tie a pending bank row to what is already in the ledger. If transaction_id is a scheduled (forecast) item it is ' +
      'confirmed at the amount and date that actually cleared. If it is an existing actual (or several, via ' +
      'transaction_ids) they must add up to the bank amount and are linked as-is.',
    scope: 'write',
    inputSchema: obj({
      bank_txn_id: int('Pending bank row id'),
      transaction_id: int('Forecast or actual to match'),
      transaction_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Several actuals that together equal the bank row' },
    }, ['bank_txn_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (a, who) => matchBankTxn(a, who),
  },
  {
    name: 'exclude_bank_txn',
    title: 'Exclude a bank row',
    description: 'Mark a pending bank row as not business (personal spending, a transfer between your own accounts). Nothing is booked.',
    scope: 'write',
    inputSchema: obj({ bank_txn_id: int('Pending bank row id'), reason: str('Why'), rule_id: int('Rule that suggested excluding') }, ['bank_txn_id', 'reason']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (a, who) => excludeBankTxn(a, who),
  },
  {
    name: 'revert_bank_txn',
    title: 'Undo a bank posting',
    description:
      'Put a posted, matched or excluded bank row back to pending: ledger rows it created are removed, a confirmed ' +
      'scheduled item goes back to scheduled, links are dropped. Refused if it touches a closed period.',
    scope: 'write',
    inputSchema: obj({ bank_txn_id: int('Bank row id') }, ['bank_txn_id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (a, who) => revertBankTxn(a, who),
  },
  {
    name: 'list_schedules',
    title: 'List recurring schedules',
    description: 'Recurring schedules (rent, fees, taxes, insurance, subscriptions) with next due date, last confirmed payment and overdue count.',
    scope: 'read',
    inputSchema: obj({
      property_id: int('Property id'),
      entity_id: int('Entity id (own books)'),
      status: { type: 'string', enum: ['active', 'paused', 'all'] },
    }),
    annotations: READ,
    run: (a) => listSchedules(a),
  },
  {
    name: 'update_schedule',
    title: 'Edit or pause a schedule',
    description:
      'Change a recurring schedule (amount, day_of_month, frequency, months_csv, description, category, start_date, ' +
      'end_date, unit_id) or pause it with status "paused". Its future scheduled rows are rebuilt to match; actuals ' +
      'and closed periods are never touched.',
    scope: 'write',
    inputSchema: obj({
      id: int('Schedule id'),
      amount: money('Amount'),
      day_of_month: { type: 'integer', minimum: 1, maximum: 31 },
      frequency: { type: 'string', enum: ['monthly', 'quarterly', 'semiannual', 'annual'] },
      months_csv: { type: ['string', 'null'], description: 'Months it falls in, e.g. "1,4,7,10"; null for the frequency default' },
      description: { type: ['string', 'null'] },
      category: str('Same income/expense kind'),
      status: { type: 'string', enum: ['active', 'paused'] },
      start_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      end_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      unit_id: { type: ['integer', 'null'] },
    }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (a, who) => updateSchedule(a, who),
  },
  {
    name: 'create_schedule',
    title: 'Create a recurring schedule',
    description:
      'Add a recurring item to a property (optionally a unit) or an entity, e.g. a unit\'s monthly rent so late payments ' +
      'get flagged. Type comes from the category. Creates the next 12 months of scheduled rows.',
    scope: 'write',
    inputSchema: obj({
      property_id: int('Property'),
      entity_id: int('Entity'),
      unit_id: int('Unit'),
      category: str('Exact category name'),
      amount: money('Amount'),
      frequency: { type: 'string', enum: ['monthly', 'quarterly', 'semiannual', 'annual'] },
      months_csv: str('Optional months, e.g. "3,9"'),
      day_of_month: { type: 'integer', minimum: 1, maximum: 31 },
      description: str('Label'),
      start_date: date('First date it applies'),
      end_date: date('Last date it applies'),
    }, ['category', 'amount']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (a, who) => createSchedule(a, who),
  },
  {
    name: 'record_distribution',
    title: 'Record a quarter distribution',
    description:
      'Record what a property distributed for a quarter, split across owners by the engine percentages. $0 can always ' +
      'be recorded. A positive amount moves real cash: send it only after the owner states the exact amount, with ' +
      'confirm_payout: true; it must also pass the lifetime over-distribution guard (allow_over: true only if the owner ' +
      'knowingly returns capital). Run get_quarter first. Refused once the quarter is closed.',
    scope: 'write',
    inputSchema: obj({
      property_id: int('Property id'),
      period: { type: 'string', pattern: '^\\d{4}-Q[1-4]$', description: 'e.g. 2026-Q3' },
      amount: { type: 'number', minimum: 0, description: 'Total for the property; 0 for none' },
      confirm_payout: { type: 'boolean', description: 'Required for amounts above 0' },
      allow_over: { type: 'boolean', description: 'Required to exceed lifetime retained cash' },
    }, ['property_id', 'period', 'amount']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (a, who) => recordDistribution(a, who),
  },
  {
    name: 'close_period',
    title: 'Close a quarter',
    description:
      'Lock a finished quarter for a property so nothing can be posted or edited inside it. Unpaid rent stays as the ' +
      'arrears record; other leftover scheduled items in the quarter are removed. Record the distribution first.',
    scope: 'write',
    inputSchema: obj({ property_id: int('Property id'), period: { type: 'string', pattern: '^\\d{4}-Q[1-4]$' } }, ['property_id', 'period']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (a, who) => closePeriod(a, who),
  },
  {
    name: 'reopen_period',
    title: 'Reopen a quarter',
    description: 'Remove the lock on a closed quarter so corrections can be made. Close it again afterwards.',
    scope: 'write',
    inputSchema: obj({ property_id: int('Property id'), period: { type: 'string', pattern: '^\\d{4}-Q[1-4]$' } }, ['property_id', 'period']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (a, who) => reopenPeriod(a, who),
  },
  {
    name: 'regenerate_forecasts',
    title: 'Regenerate forecasts',
    description:
      'Rebuild the next 12 months of scheduled rows from the recurring schedules for one property or entity. Never touches ' +
      'actuals, closed periods, or months already confirmed.',
    scope: 'write',
    inputSchema: obj({ property_id: int('Property id'), entity_id: int('Entity id') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (a, who) => svc.regenerateForecasts(a, who),
  },
  {
    name: 'list_notes',
    title: 'Notes left on the site',
    description:
      'Notes Betsy or David typed into the website note box, e.g. "Billy paid $155 cash for 500 West, August". ' +
      'Open notes are work to do: post what each describes with the normal tools (match the bank first so nothing is entered twice), ' +
      'then resolve_note. Never post a note that is ambiguous; ask David instead.',
    scope: 'read',
    inputSchema: obj({
      status: { type: 'string', enum: ['open', 'done', 'dismissed', 'all'], description: "Default 'open'" },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    }),
    annotations: READ,
    run: (a) => listBookNotes(a),
  },
  {
    name: 'resolve_note',
    title: 'Resolve a note',
    description:
      "Mark a site note handled. status 'done' when you posted or fixed what it describes, 'dismissed' when nothing needs posting. " +
      'reply is shown to the author on the Notes page: say what you did in a sentence, with amounts and transaction ids.',
    scope: 'write',
    inputSchema: obj({
      id: int('Note id'),
      status: { type: 'string', enum: ['done', 'dismissed'] },
      reply: str('One or two sentences for the author'),
    }, ['id', 'status', 'reply']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (a, who) => resolveBookNote(a, who),
  },
]

export function toolsFor(scopes: Scope[]): Tool[] {
  return TOOLS.filter((t) => scopes.includes(t.scope))
}
