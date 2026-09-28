import { ZodError } from 'zod';
import { DomainError, ErrorCode, isDomainError } from '@airdesk/domain';
import { commandSchemas, type AuditEntryDto, type CommandError, type CommandName, type CommandResult, type SystemStatusDto } from '@airdesk/contracts';
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
      };
    },
  },
  'system.setup': { access: PUBLIC, run: async ({ backend, workstation }, input) => backend.svc.auth.setup(input, workstation) },

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
  'company.update': { access: perm('settings.company'), run: (ctx, i) => ctx.backend.svc.company.update(actor(ctx), i.profile, i.rowVersion) },
  'company.setLockDate': {
    access: perm('finance.lock_period', 'finance.unlock_period'),
    run: (ctx, i) => ctx.backend.svc.company.setLockDate(actor(ctx), i.lockDate, i.reason),
  },

  'currency.list': { access: AUTH, run: (ctx) => ctx.backend.svc.currencies.list() },
  'currency.setRate': { access: perm('finance.exchange_rates'), run: (ctx, i) => ctx.backend.svc.currencies.setRate(actor(ctx), i) },

  'users.list': { access: perm('user.manage'), run: (ctx) => ctx.backend.svc.users.listUsers(actor(ctx)) },
  'users.create': { access: perm('user.manage'), run: (ctx, i) => ctx.backend.svc.users.createUser(actor(ctx), i) },
  'users.setRoles': { access: perm('user.manage'), run: (ctx, i) => ctx.backend.svc.users.setUserRoles(actor(ctx), i.userId, i.roleCodes) },
  'users.setActive': { access: perm('user.manage'), run: (ctx, i) => ctx.backend.svc.users.setUserActive(actor(ctx), i.userId, i.active) },
  'users.resetPassword': { access: perm('user.manage'), run: (ctx, i) => ctx.backend.svc.users.resetPassword(actor(ctx), i.userId, i.newPassword) },

  'roles.list': { access: perm('user.manage', 'role.manage'), run: (ctx) => ctx.backend.svc.users.listRoles(actor(ctx)) },
  'roles.create': { access: perm('role.manage'), run: (ctx, i) => ctx.backend.svc.users.createRole(actor(ctx), i) },
  'roles.setPermissions': { access: perm('role.manage'), run: (ctx, i) => ctx.backend.svc.users.setRolePermissions(actor(ctx), i.roleId, i.permissions) },
  'permissions.list': { access: perm('user.manage', 'role.manage'), run: (ctx) => ctx.backend.svc.users.listPermissions(actor(ctx)) },

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
  'backup.restore': {
    access: perm('backup.restore'),
    run: async (ctx, i) => {
      const r = await ctx.backend.restore(actor(ctx), i.filePath, i.password);
      return { __session: { clear: true }, preRestoreBackup: r.preRestoreBackup };
    },
  },

  'audit.list': {
    access: perm('audit.view'),
    run: (ctx, i): AuditEntryDto[] => {
      const rows = ctx.backend.svc.deps.db
        .prepare(
          `SELECT a.seq, a.occurred_at, a.user_id, u.username, a.action, a.entity_type, a.entity_id, a.metadata_json
           FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
           WHERE (? IS NULL OR a.seq < ?) ORDER BY a.seq DESC LIMIT ?`,
        )
        .all(i.beforeSeq ?? null, i.beforeSeq ?? null, i.limit) as {
          seq: number; occurred_at: string; user_id: string | null; username: string | null; action: string; entity_type: string; entity_id: string | null; metadata_json: string | null;
        }[];
      return rows.map((r) => ({
        seq: r.seq, occurredAt: r.occurred_at, userId: r.user_id, username: r.username, action: r.action,
        entityType: r.entity_type, entityId: r.entity_id, metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
      }));
    },
  },
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
