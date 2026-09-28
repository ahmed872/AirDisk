import { ChartOfAccounts, DomainError, ErrorCode } from '@airdesk/domain';
import type { AuditActor, AuditLog } from '../audit/audit-log';
import type { Db } from '../db/driver';
import type { Clock } from '../util/clock';
import type { IdGenerator } from '../util/ids';
import type { Logger } from '../util/logger';

/** The authenticated caller of a service operation. Built by the session layer, never by the client. */
export interface Actor {
  userId: string;
  username: string;
  sessionId: string;
  workstation: string;
  roles: readonly string[];
  permissions: ReadonlySet<string>;
}

export interface ServiceDeps {
  db: Db;
  clock: Clock;
  newId: IdGenerator;
  audit: AuditLog;
  logger: Logger;
  chart: ChartOfAccounts;
  appVersion: string;
}

export function actorOf(actor: Actor): AuditActor {
  return { userId: actor.userId, sessionId: actor.sessionId, workstation: actor.workstation };
}

export function hasAny(actor: Actor, permissions: string | readonly string[]): boolean {
  const list = typeof permissions === 'string' ? [permissions] : permissions;
  return list.some((p) => actor.permissions.has(p));
}

/**
 * Backend authorization (never the UI). Must be called BEFORE opening a write
 * transaction so the denial audit record survives the thrown error (EC-M).
 */
export function requirePermission(deps: ServiceDeps, actor: Actor, permissions: string | readonly string[], action: string): void {
  if (hasAny(actor, permissions)) return;
  if (deps.db.inTransaction) {
    // Programming error: a denial inside a transaction would roll back its own audit row.
    deps.logger.error('requirePermission called inside a transaction', { action });
  }
  deps.audit.append(actorOf(actor), {
    action: 'auth.permission_denied',
    entityType: 'command',
    entityId: action,
    metadata: { required: permissions },
  });
  throw new DomainError(ErrorCode.FORBIDDEN, 'You do not have permission to perform this action', {
    action,
    required: typeof permissions === 'string' ? [permissions] : [...permissions],
  });
}

export function tx<T>(deps: ServiceDeps, fn: () => T): T {
  return deps.db.transaction(fn)();
}
