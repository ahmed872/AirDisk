import { ZodError } from 'zod';
import { DomainError, ErrorCode, isDomainError } from '@airdesk/domain';
import { commandSchemas, type AboutDto, type BackupHeaderDto, type AuditEntryDto, type CommandError, type CommandName, type CommandResult, type DashboardSummaryDto, type SystemStatusDto } from '@airdesk/contracts';
import { requirePermission, type Actor } from '../services/context';
import type { AppBackend } from './backend';

export interface DispatchRequest {
  command: string;
  payload: unknown;
  /** Bound by the transport (never supplied by the renderer). */
  sessionId?: string | null;
  workstation: string;
}

export type SessionEffect = { set: string } | { clear: true };
export type DispatchResponse = CommandResult & { session?: SessionEffect };

type Access = { kind: 'public' } | { kind: 'authenticated' } | { kind: 'permission'; anyOf: readonly string[] };

interface Ctx {
  backend: AppBackend;
  actor: Actor | null;
  workstation: string;
}

interface HandlerDef<C extends CommandName> {
  access: Access;
  /** Allowed while the user still has to change a temporary password. */
  duringPasswordChange?: boolean;
  run(ctx: Ctx, input: ReturnType<(typeof commandSchemas)[C]['parse']>): unknown;
}

const PUBLIC: Access = { kind: 'public' };
const AUTH: Access = { kind: 'authenticated' };
const perm = (...anyOf: string[]): Access => ({ kind: 'permission', anyOf });
const actor = (ctx: Ctx): Actor => ctx.actor!;
const alreadyOpen = (): never => {
  throw new DomainError(ErrorCode.CONFLICT, 'The company data is already open', { reason: 'ALREADY_OPEN' });
};

/**
 * The command registry. EVERY command declares its access rule here; the type
 * forces an entry for every command in the contract, and a test asserts that
 * nothing sensitive is public. Services re-check permissions (defence in depth).
 *
 * Deliberately NOT exposed: generic document posting/reversal. In Phase 1 the
 * ledger is written only by internal callers (tests, later business commands).
 */
export const HANDLERS: { [C in CommandName]: HandlerDef<C> } = {
  'system.status': {
    access: PUBLIC,
    run: ({ backend }): SystemStatusDto => {
      const s = backend.svc;
      const setupRequired = s.auth.isSetupRequired();
      return {
        setupRequired,
        appVersion: backend.appVersion,
        schemaVersion: backend.schemaVersionNow,
        companyName: setupRequired ? null : s.company.core().legalNameAr,
        defaultLocale: setupRequired ? 'ar' : s.company.get().defaultLocale,
        ...(setupRequired ? { setupCurrencies: s.currencies.list().map((c) => ({ code: c.code, nameAr: c.nameAr, nameEn: c.nameEn })) } : {}),
        vault: 'READY',
        encrypted: backend.isEncrypted,
      };
    },
  },
  // Launcher commands only make sense before the data is open (AppLauncher answers them); here the data is already open.
  'vault.unlock': { access: PUBLIC, run: () => alreadyOpen() },
  'vault.inspectBackup': { access: PUBLIC, run: () => alreadyOpen() },
  'vault.restoreBackup': { access: PUBLIC, run: () => alreadyOpen() },

  'security.encryptionStatus': { access: perm('settings.system', 'backup.create', 'backup.restore'), run: (ctx) => ctx.backend.encryptionStatus(actor(ctx)) },
  'security.enableEncryption': {
    access: perm('settings.system'),
    run: async (ctx, i) => ({ __session: { clear: true }, ...(await ctx.backend.enableEncryption(actor(ctx), i)) }),
  },
  'security.changeRecoveryPassphrase': { access: perm('settings.system'), run: (ctx, i) => ctx.backend.changeRecoveryPassphrase(actor(ctx), i) },
  'security.purgeUnencryptedBackups': { access: perm('settings.system'), run: (ctx, i) => ctx.backend.purgeUnencryptedBackups(actor(ctx), i.password) },
  'system.setup': {
    access: PUBLIC,
    run: async ({ backend, workstation }, input) => {
      await backend.svc.auth.setup(input, workstation);
      // Every installation starts with a cash account in its base currency (idempotent).
      backend.svc.reference.ensureDefaultMoneyAccount(null);
    },
  },

  'auth.login': {
    access: PUBLIC,
    run: async ({ backend, workstation }, input) => {
      const result = await backend.svc.auth.login(input.username, input.password, workstation);
      return { __session: { set: result.sessionId }, user: result.user };
    },
  },
  'auth.logout': {
    access: AUTH,
    duringPasswordChange: true,
    run: ({ backend, ...ctx }) => {
      backend.svc.auth.logout(actor({ backend, ...ctx }));
      return { __session: { clear: true } };
    },
  },
  'auth.me': { access: AUTH, duringPasswordChange: true, run: (ctx) => ctx.backend.svc.auth.me(actor(ctx).userId) },
  'auth.changePassword': {
    access: AUTH,
    duringPasswordChange: true,
    run: (ctx, input) => ctx.backend.svc.auth.changePassword(actor(ctx), input.currentPassword, input.newPassword),
  },

  'company.get': { access: AUTH, run: (ctx) => ctx.backend.svc.company.get() },
  // Field-group permissions (company.edit / company.branding / company.financial_config) are enforced by the service.
  'company.update': {
    access: perm('company.edit', 'company.branding', 'company.financial_config'),
    run: (ctx, i) => ctx.backend.svc.company.update(actor(ctx), i.profile, i.rowVersion),
  },
  'company.setLockDate': {
    access: perm('finance.lock_period', 'finance.unlock_period'),
    run: (ctx, i) => ctx.backend.svc.company.setLockDate(actor(ctx), i.lockDate, i.reason),
  },

  'currency.list': { access: AUTH, run: (ctx) => ctx.backend.svc.currencies.list() },
  'currency.setRate': { access: perm('finance.exchange_rates'), run: (ctx, i) => ctx.backend.svc.currencies.setRate(actor(ctx), i) },

  'users.list': { access: perm('user.view'), run: (ctx, i) => ctx.backend.svc.users.listUsers(actor(ctx), i) },
  'users.create': { access: perm('user.create'), run: (ctx, i) => ctx.backend.svc.users.createUser(actor(ctx), i) },
  'users.update': { access: perm('user.edit'), run: (ctx, i) => ctx.backend.svc.users.updateUser(actor(ctx), i) },
  'users.setRoles': { access: perm('user.assign_roles'), run: (ctx, i) => ctx.backend.svc.users.setUserRoles(actor(ctx), i.userId, i.roleCodes) },
  'users.setActive': { access: perm('user.disable'), run: (ctx, i) => ctx.backend.svc.users.setUserActive(actor(ctx), i.userId, i.active) },
  'users.resetPassword': { access: perm('user.reset_credentials'), run: (ctx, i) => ctx.backend.svc.users.resetPassword(actor(ctx), i.userId, i.newPassword) },
  'users.unlock': { access: perm('user.reset_credentials'), run: (ctx, i) => ctx.backend.svc.users.unlockUser(actor(ctx), i.userId) },

  'roles.list': { access: perm('role.view', 'user.assign_roles'), run: (ctx) => ctx.backend.svc.users.listRoles(actor(ctx)) },
  'roles.create': { access: perm('role.create'), run: (ctx, i) => ctx.backend.svc.users.createRole(actor(ctx), i) },
  'roles.update': { access: perm('role.edit'), run: (ctx, i) => ctx.backend.svc.users.updateRole(actor(ctx), i) },
  'roles.setPermissions': { access: perm('role.manage_permissions'), run: (ctx, i) => ctx.backend.svc.users.setRolePermissions(actor(ctx), i.roleId, i.permissions) },
  'permissions.list': { access: perm('role.view', 'user.assign_roles'), run: (ctx) => ctx.backend.svc.users.listPermissions(actor(ctx)) },

  'customers.list': { access: perm('customer.view'), run: (ctx, i) => ctx.backend.svc.customers.list(actor(ctx), i) },
  'customers.get': { access: perm('customer.view'), run: (ctx, i) => ctx.backend.svc.customers.get(actor(ctx), i.id) },
  'customers.checkDuplicates': {
    access: perm('customer.view', 'customer.create', 'customer.edit'),
    run: (ctx, i) => ctx.backend.svc.customers.checkDuplicates(actor(ctx), i.customer, i.excludeId),
  },
  'customers.create': { access: perm('customer.create'), run: (ctx, i) => ctx.backend.svc.customers.create(actor(ctx), i.customer, i.confirmDuplicates) },
  'customers.update': {
    access: perm('customer.edit'),
    run: (ctx, i) => ctx.backend.svc.customers.update(actor(ctx), i.id, i.customer, i.rowVersion, i.confirmDuplicates),
  },
  'customers.archive': { access: perm('customer.archive'), run: (ctx, i) => ctx.backend.svc.customers.setStatus(actor(ctx), i.id, 'ARCHIVED', i.reason) },
  'customers.restore': { access: perm('customer.archive'), run: (ctx, i) => ctx.backend.svc.customers.setStatus(actor(ctx), i.id, 'ACTIVE', i.reason) },

  'suppliers.list': { access: perm('supplier.view'), run: (ctx, i) => ctx.backend.svc.suppliers.list(actor(ctx), i) },
  'suppliers.get': { access: perm('supplier.view'), run: (ctx, i) => ctx.backend.svc.suppliers.get(actor(ctx), i.id) },
  'suppliers.create': { access: perm('supplier.create'), run: (ctx, i) => ctx.backend.svc.suppliers.create(actor(ctx), i.supplier, i.confirmDuplicates) },
  'suppliers.update': {
    access: perm('supplier.edit'),
    run: (ctx, i) => ctx.backend.svc.suppliers.update(actor(ctx), i.id, i.supplier, i.rowVersion, i.confirmDuplicates),
  },
  'suppliers.archive': { access: perm('supplier.archive'), run: (ctx, i) => ctx.backend.svc.suppliers.setStatus(actor(ctx), i.id, 'ARCHIVED', i.reason) },
  'suppliers.restore': { access: perm('supplier.archive'), run: (ctx, i) => ctx.backend.svc.suppliers.setStatus(actor(ctx), i.id, 'ACTIVE', i.reason) },

  'airlines.list': { access: perm('airline.view'), run: (ctx, i) => ctx.backend.svc.airlines.list(actor(ctx), i) },
  'airlines.get': { access: perm('airline.view'), run: (ctx, i) => ctx.backend.svc.airlines.get(actor(ctx), i.id) },
  'airlines.create': { access: perm('airline.create'), run: (ctx, i) => ctx.backend.svc.airlines.create(actor(ctx), i.airline, i.confirmDuplicates) },
  'airlines.update': {
    access: perm('airline.edit'),
    run: (ctx, i) => ctx.backend.svc.airlines.update(actor(ctx), i.id, i.airline, i.rowVersion, i.confirmDuplicates),
  },
  'airlines.archive': { access: perm('airline.archive'), run: (ctx, i) => ctx.backend.svc.airlines.setStatus(actor(ctx), i.id, 'ARCHIVED', i.reason) },
  'airlines.restore': { access: perm('airline.archive'), run: (ctx, i) => ctx.backend.svc.airlines.setStatus(actor(ctx), i.id, 'ACTIVE', i.reason) },

  'dashboard.summary': {
    access: perm('dashboard.operational', 'dashboard.financial'),
    run: (ctx): DashboardSummaryDto => {
      const db = ctx.backend.svc.deps.db;
      const a = actor(ctx);
      const counts = (table: string) =>
        db.prepare(`SELECT SUM(is_active = 1) AS active, SUM(is_active = 0) AS archived FROM ${table}`).get() as { active: number | null; archived: number | null };
      const pair = (table: string, perm: string) => {
        if (!a.permissions.has(perm)) return null;
        const c = counts(table);
        return { active: c.active ?? 0, archived: c.archived ?? 0 };
      };
      const users = a.permissions.has('user.view') ? counts('app_user') : null;
      const lastBackup = a.permissions.has('backup.create')
        ? ((db.prepare(`SELECT MAX(finished_at) AS t FROM backup_record WHERE status = 'SUCCEEDED'`).get() as { t: string | null }).t)
        : null;
      return {
        customers: pair('customer', 'customer.view'),
        suppliers: pair('supplier', 'supplier.view'),
        airlines: pair('airline', 'airline.view'),
        users: users ? { active: users.active ?? 0, disabled: users.archived ?? 0 } : null,
        lastBackupAt: lastBackup,
      };
    },
  },

  'ledger.summary': { access: perm('report.profit'), run: (ctx, i) => ctx.backend.svc.ledger.summary(actor(ctx), i.from, i.to) },
  'ledger.trialBalance': { access: perm('report.profit'), run: (ctx, i) => ctx.backend.svc.ledger.trialBalance(actor(ctx), i.asOf) },

  'integrity.run': { access: perm('integrity.run'), run: (ctx) => ctx.backend.runIntegrity(actor(ctx)) },

  'backup.create': {
    access: perm('backup.create'),
    run: async (ctx, i) => {
      const r = await ctx.backend.createBackup(actor(ctx), 'MANUAL', i.destinationDir);
      return { id: r.id, filePath: r.filePath, sha256: r.sha256, sizeBytes: r.sizeBytes };
    },
  },
  'backup.list': { access: perm('backup.create', 'backup.restore'), run: (ctx) => ctx.backend.listBackups(actor(ctx)) },
  'backup.schedule': { access: perm('backup.create', 'backup.restore', 'settings.system'), run: (ctx) => ctx.backend.backupSchedule(actor(ctx)) },
  'backup.setSchedule': { access: perm('settings.system'), run: (ctx, i) => ctx.backend.setBackupSchedule(actor(ctx), i) },
  'backup.restore': {
    access: perm('backup.restore'),
    run: async (ctx, i) => {
      const r = await ctx.backend.restore(actor(ctx), i.filePath, i.password, i.backupPassphrase);
      return { __session: { clear: true }, preRestoreBackup: r.preRestoreBackup };
    },
  },
  'backup.inspect': {
    access: perm('backup.restore'),
    run: async (ctx, i): Promise<BackupHeaderDto> => {
      const h = await ctx.backend.inspectBackup(actor(ctx), i.filePath);
      return { format: h.format, encrypted: h.encrypted, appVersion: h.appVersion, schemaVersion: h.schemaVersion, createdAt: h.createdAt, kind: h.kind, keyCreatedAt: h.keyCreatedAt, sameKey: !!h.keyId && h.keyId === ctx.backend.vault.recoveryWrap?.keyId };
    },
  },

  'audit.list': {
    access: perm('audit.view'),
    run: (ctx, i): AuditEntryDto[] => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (cond: string, v: unknown) => {
        where.push(cond);
        params.push(v);
      };
      if (i.beforeSeq) add('a.seq < ?', i.beforeSeq);
      if (i.entityType) add('a.entity_type = ?', i.entityType);
      if (i.entityId) add('a.entity_id = ?', i.entityId);
      if (i.action) add(`a.action LIKE ? ESCAPE '\\'`, `${i.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      if (i.userId) add('a.user_id = ?', i.userId);
      if (i.from) add('a.occurred_at >= ?', `${i.from}T00:00:00.000Z`);
      if (i.to) add('a.occurred_at <= ?', `${i.to}T23:59:59.999Z`);
      const rows = ctx.backend.svc.deps.db
        .prepare(
          `SELECT a.seq, a.occurred_at, a.user_id, u.username, a.workstation, a.action, a.entity_type, a.entity_id, a.before_json, a.after_json, a.metadata_json
           FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.seq DESC LIMIT ?`,
        )
        .all(...params, i.limit) as {
          seq: number; occurred_at: string; user_id: string | null; username: string | null; workstation: string | null; action: string;
          entity_type: string; entity_id: string | null; before_json: string | null; after_json: string | null; metadata_json: string | null;
        }[];
      const parse = (j: string | null) => (j ? JSON.parse(j) : null);
      return rows.map((r) => ({
        seq: r.seq, occurredAt: r.occurred_at, userId: r.user_id, username: r.username, workstation: r.workstation, action: r.action,
        entityType: r.entity_type, entityId: r.entity_id, before: parse(r.before_json), after: parse(r.after_json), metadata: parse(r.metadata_json),
      }));
    },
  },

  // ── Operations ─────────────────────────────────────────────────────────
  'system.about': {
    access: AUTH,
    run: ({ backend }): AboutDto => {
      const db = backend.svc.deps.db;
      const migrations = (db.prepare('SELECT version, name, applied_at, app_version FROM schema_migration ORDER BY version').all() as { version: number; name: string; applied_at: string; app_version: string }[])
        .map((m) => ({ version: m.version, name: m.name, appliedAt: m.applied_at, appVersion: m.app_version }));
      return { appVersion: backend.appVersion, schemaVersion: backend.schemaVersionNow, latestSchemaVersion: backend.latestSchemaVersion, migrations, platform: process.platform, dataDirectory: null };
    },
  },

  'airports.list': { access: perm('booking.view', 'booking.create', 'airport.manage'), run: (ctx, i) => ctx.backend.svc.reference.listAirports(actor(ctx), { ...i, sortBy: i.sortBy }) },
  'airports.create': { access: perm('airport.manage'), run: (ctx, i) => ctx.backend.svc.reference.saveAirport(actor(ctx), i.airport, true) },
  'airports.update': { access: perm('airport.manage'), run: (ctx, i) => ctx.backend.svc.reference.saveAirport(actor(ctx), i.airport, false, i.rowVersion) },
  'airports.setActive': { access: perm('airport.manage'), run: (ctx, i) => ctx.backend.svc.reference.setAirportActive(actor(ctx), i.iataCode.toUpperCase(), i.active) },

  'moneyAccounts.list': {
    access: perm('treasury.view', 'treasury.manage_accounts', 'payment.customer.receive', 'payment.customer.refund', 'payment.supplier.pay', 'payment.supplier.record_refund', 'expense.create'),
    run: (ctx, i) => ctx.backend.svc.reference.listMoneyAccounts(actor(ctx), i.includeInactive),
  },
  'moneyAccounts.save': { access: perm('treasury.manage_accounts'), run: (ctx, i) => ctx.backend.svc.reference.saveMoneyAccount(actor(ctx), i) },
  'moneyAccounts.setActive': { access: perm('treasury.manage_accounts'), run: (ctx, i) => ctx.backend.svc.reference.setMoneyAccountActive(actor(ctx), i.id, i.active) },

  'expenseCategories.list': { access: perm('expense.view', 'expense.create', 'expense.category.manage'), run: (ctx, i) => ctx.backend.svc.reference.listExpenseCategories(actor(ctx), i.includeArchived) },
  'expenseCategories.accounts': { access: perm('expense.category.manage'), run: (ctx) => ctx.backend.svc.reference.expenseAccounts() },
  'expenseCategories.save': { access: perm('expense.category.manage'), run: (ctx, i) => ctx.backend.svc.reference.saveExpenseCategory(actor(ctx), i) },
  'expenseCategories.setActive': { access: perm('expense.category.manage'), run: (ctx, i) => ctx.backend.svc.reference.setExpenseCategoryActive(actor(ctx), i.id, i.active) },

  'currency.setActive': { access: perm('finance.exchange_rates'), run: (ctx, i) => ctx.backend.svc.reference.setCurrencyActive(actor(ctx), i.currencyCode, i.active) },
  'currency.rates': { access: perm('finance.exchange_rates', 'treasury.view', 'report.profit'), run: (ctx, i) => ctx.backend.svc.reference.listRates(actor(ctx), i.currencyCode) },
  'currency.rateOn': { access: AUTH, run: (ctx, i) => ({ rate: ctx.backend.svc.currencies.rateOn(i.currencyCode, i.date) }) },

  'bookings.list': { access: perm('booking.view'), run: (ctx, i) => ctx.backend.svc.bookings.list(actor(ctx), i) },
  'bookings.get': { access: perm('booking.view'), run: (ctx, i) => ctx.backend.svc.bookings.get(actor(ctx), i.id) },
  'bookings.create': { access: perm('booking.create'), run: (ctx, i) => ctx.backend.svc.bookings.create(actor(ctx), i) },
  'bookings.update': { access: perm('booking.edit'), run: (ctx, i) => ctx.backend.svc.bookings.update(actor(ctx), i.id, i.rowVersion, i.patch) },
  'bookings.savePassenger': { access: perm('booking.edit'), run: (ctx, i) => ctx.backend.svc.bookings.savePassenger(actor(ctx), i.bookingId, i.passengerId ?? null, i.passenger) },
  'bookings.removePassenger': { access: perm('booking.edit'), run: (ctx, i) => ctx.backend.svc.bookings.removePassenger(actor(ctx), i.bookingId, i.passengerId) },
  'bookings.saveSegment': {
    access: perm('booking.edit'),
    run: (ctx, i) => ctx.backend.svc.bookings.saveSegment(actor(ctx), i.bookingId, i.segmentId ?? null, i.segment, { reason: i.reason ?? null, ...(i.source ? { source: i.source } : {}) }),
  },
  'bookings.removeSegment': { access: perm('booking.edit'), run: (ctx, i) => ctx.backend.svc.bookings.removeSegment(actor(ctx), i.bookingId, i.segmentId) },
  'bookings.savePriceItem': { access: perm('booking.edit'), run: (ctx, i) => ctx.backend.svc.bookings.savePriceItem(actor(ctx), i.bookingId, i.itemId ?? null, i.item) },
  'bookings.removePriceItem': { access: perm('booking.edit'), run: (ctx, i) => ctx.backend.svc.bookings.removePriceItem(actor(ctx), i.bookingId, i.itemId) },
  'bookings.reserve': { access: perm('booking.reserve'), run: (ctx, i) => ctx.backend.svc.bookings.reserve(actor(ctx), i.id, i.rowVersion, i.ticketingDeadlineAt) },
  'bookings.release': { access: perm('booking.reserve'), run: (ctx, i) => ctx.backend.svc.bookings.release(actor(ctx), i.id, i.rowVersion) },
  'bookings.discard': { access: perm('booking.discard'), run: (ctx, i) => ctx.backend.svc.bookings.discard(actor(ctx), i.id, i.rowVersion, i.reason) },
  'bookings.issue': { access: perm('booking.issue'), run: (ctx, i) => ctx.backend.svc.bookings.issue(actor(ctx), i.id, i) },
  'bookings.setTicketNumber': { access: perm('booking.issue', 'booking.edit'), run: (ctx, i) => ctx.backend.svc.bookings.setTicketNumber(actor(ctx), i.bookingId, i.ticketId, i.ticketNumber, i.correctionReason) },
  'bookings.adjustSale': { access: perm('booking.adjust_price'), run: (ctx, i) => ctx.backend.svc.bookings.adjustSale(actor(ctx), i.bookingId, i) },
  'bookings.adjustCost': { access: perm('booking.adjust_price'), run: (ctx, i) => ctx.backend.svc.bookings.adjustCost(actor(ctx), i.bookingId, i) },
  'bookings.changeSupplier': { access: perm('booking.change_supplier'), run: (ctx, i) => ctx.backend.svc.bookings.changeSupplier(actor(ctx), i.bookingId, i) },
  'bookings.reissue': { access: perm('booking.reissue'), run: (ctx, i) => ctx.backend.svc.bookings.reissue(actor(ctx), i.bookingId, i) },

  'payments.receive': { access: perm('payment.customer.receive'), run: (ctx, i) => ctx.backend.svc.finance.receiveCustomerPayment(actor(ctx), i) },
  'payments.refundCustomer': { access: perm('payment.customer.refund'), run: (ctx, i) => ctx.backend.svc.finance.refundCustomer(actor(ctx), i) },
  'payments.paySupplier': { access: perm('payment.supplier.pay'), run: (ctx, i) => ctx.backend.svc.finance.paySupplier(actor(ctx), i) },
  'payments.supplierRefund': { access: perm('payment.supplier.record_refund'), run: (ctx, i) => ctx.backend.svc.finance.recordSupplierRefund(actor(ctx), i) },
  'payments.openItems': {
    access: perm('payment.customer.receive', 'payment.customer.refund', 'payment.supplier.pay', 'payment.supplier.record_refund'),
    run: (ctx, i) => ctx.backend.svc.finance.openItems(actor(ctx), i.party, i.partyId),
  },
  'openingBalances.record': { access: perm('finance.opening_balances'), run: (ctx, i) => ctx.backend.svc.finance.recordOpeningBalance(actor(ctx), i) },
  'openingBalances.list': { access: perm('finance.opening_balances'), run: (ctx) => ctx.backend.svc.finance.listOpeningBalances(actor(ctx)) },
  'treasury.transfer': { access: perm('treasury.transfer'), run: (ctx, i) => ctx.backend.svc.finance.transferMoney(actor(ctx), i) },
  'treasury.transfers': { access: perm('treasury.view', 'treasury.transfer'), run: (ctx, i) => ctx.backend.svc.finance.listTransfers(actor(ctx), i.from, i.to) },
  'balances.apply': { access: perm('balance.apply'), run: (ctx, i) => ctx.backend.svc.finance.applyBalance(actor(ctx), i) },
  'documents.get': { access: AUTH, run: (ctx, i) => ctx.backend.svc.finance.document(actor(ctx), i.id) },
  'documents.cancel': {
    access: perm('payment.customer.reverse', 'payment.supplier.reverse', 'expense.reverse', 'treasury.transfer', 'balance.apply', 'finance.opening_balances'),
    run: (ctx, i) => ctx.backend.svc.finance.cancelDocument(actor(ctx), i.id, i.reason, i.date),
  },

  'expenses.create': { access: perm('expense.create'), run: (ctx, i) => ctx.backend.svc.finance.recordExpense(actor(ctx), i) },

  'cancellations.list': { access: perm('refund.request', 'refund.manage'), run: (ctx, i) => ctx.backend.svc.finance.listCancellations(actor(ctx), i.status) },
  'cancellations.get': { access: perm('refund.request', 'refund.manage', 'booking.view'), run: (ctx, i) => ctx.backend.svc.finance.cancellation(actor(ctx), i.id) },
  'cancellations.request': { access: perm('refund.request'), run: (ctx, i) => ctx.backend.svc.finance.requestCancellation(actor(ctx), i) },
  'cancellations.submit': { access: perm('refund.manage'), run: (ctx, i) => ctx.backend.svc.finance.submitToSupplier(actor(ctx), i.id, i.rowVersion) },
  'cancellations.confirmSupplier': { access: perm('refund.manage'), run: (ctx, i) => ctx.backend.svc.finance.confirmSupplier(actor(ctx), i.id, i) },
  'cancellations.rejectSupplier': { access: perm('refund.manage'), run: (ctx, i) => ctx.backend.svc.finance.rejectSupplier(actor(ctx), i.id, i.rowVersion, i.note) },
  'cancellations.creditCustomer': { access: perm('refund.manage'), run: (ctx, i) => ctx.backend.svc.finance.creditCustomer(actor(ctx), i.id, i) },
  'cancellations.customerNotApplicable': { access: perm('refund.manage'), run: (ctx, i) => ctx.backend.svc.finance.customerNotApplicable(actor(ctx), i.id, i.rowVersion, i.note) },
  'cancellations.withdraw': { access: perm('refund.request', 'refund.manage'), run: (ctx, i) => ctx.backend.svc.finance.withdraw(actor(ctx), i.id, i.rowVersion, i.reason) },

  'schedule.list': { access: perm('booking.view', 'report.schedule_changes'), run: (ctx, i) => ctx.backend.svc.operations.listChanges(actor(ctx), i) },
  'schedule.setStatus': { access: perm('schedule.notify', 'schedule.confirm'), run: (ctx, i) => ctx.backend.svc.operations.setChangeStatus(actor(ctx), i.id, i) },
  'notifications.channels': { access: AUTH, run: (ctx) => ctx.backend.svc.operations.channels() },
  'notifications.draft': { access: perm('schedule.notify'), run: (ctx, i) => ctx.backend.svc.operations.draftMessage(actor(ctx), i.changeId, i.locale) },
  'notifications.record': { access: perm('schedule.notify'), run: (ctx, i) => ctx.backend.svc.operations.recordNotification(actor(ctx), i) },
  'travel.upcoming': { access: perm('booking.view'), run: (ctx, i) => ctx.backend.svc.operations.upcomingTravel(actor(ctx), i) },

  'statements.get': { access: perm('report.statements'), run: (ctx, i) => ctx.backend.svc.reports.statement(actor(ctx), i.party, i.partyId, i.from, i.to) },
  'aging.get': { access: perm('report.receivables', 'report.payables'), run: (ctx, i) => ctx.backend.svc.reports.aging(actor(ctx), i.party, i.asOf) },
  'reports.run': {
    access: perm('report.sales', 'report.purchases', 'report.profit', 'report.receivables', 'report.payables', 'report.supplier_performance', 'report.expenses', 'report.refunds', 'report.schedule_changes', 'report.employee_activity', 'treasury.view'),
    run: (ctx, i) => ctx.backend.svc.reports.run(actor(ctx), i.report, i.from, i.to),
  },
  'dashboard.metrics': { access: perm('dashboard.operational', 'dashboard.financial'), run: (ctx, i) => ctx.backend.svc.reports.dashboard(actor(ctx), i.from, i.to) },
  'search.global': { access: AUTH, run: (ctx, i) => ctx.backend.svc.reports.search(actor(ctx), i.query) },
};

export function accessOf(command: CommandName): Access {
  return HANDLERS[command].access;
}

function toError(e: unknown, backend: AppBackend): CommandError {
  if (isDomainError(e)) return { code: e.code, message: e.message, ...(e.details ? { details: { ...e.details } } : {}) };
  if (e instanceof ZodError) {
    return {
      code: ErrorCode.VALIDATION,
      message: 'Invalid input',
      details: { issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    };
  }
  // Unexpected: log everything locally, reveal nothing internal to the client.
  backend.svc.deps.logger.error('Unhandled error in command', { error: (e as Error)?.message, stack: (e as Error)?.stack });
  return { code: ErrorCode.INTERNAL, message: 'An unexpected error occurred. Details were written to the log.' };
}

export async function dispatchCommand(backend: AppBackend, req: DispatchRequest): Promise<DispatchResponse> {
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, req.command)) {
    return { ok: false, error: { code: ErrorCode.VALIDATION, message: 'Unknown command' } };
  }
  const command = req.command as CommandName;
  const def = HANDLERS[command] as HandlerDef<CommandName>;
  try {
    const input = commandSchemas[command].parse(req.payload ?? {});
    let actorResolved: Actor | null = null;
    if (def.access.kind !== 'public') {
      actorResolved = backend.svc.sessions.resolve(req.sessionId);
      if (!def.duringPasswordChange && backend.svc.auth.mustChangePassword(actorResolved.userId)) {
        throw new DomainError(ErrorCode.PASSWORD_CHANGE_REQUIRED, 'You must change your password first');
      }
      if (def.access.kind === 'permission') requirePermission(backend.svc.deps, actorResolved, def.access.anyOf, command);
    }
    const raw = (await def.run({ backend, actor: actorResolved, workstation: req.workstation }, input as never)) as unknown;
    if (raw && typeof raw === 'object' && '__session' in raw) {
      const { __session, ...data } = raw as { __session: SessionEffect } & Record<string, unknown>;
      return { ok: true, data, session: __session };
    }
    return { ok: true, data: raw ?? null };
  } catch (e) {
    const error = toError(e, backend);
    const clear = error.code === ErrorCode.UNAUTHENTICATED || error.code === ErrorCode.SESSION_EXPIRED;
    return clear ? { ok: false, error, session: { clear: true } } : { ok: false, error };
  }
}
