import { DomainError, ErrorCode } from '@airdesk/domain';
import type { AuditLog } from '../audit/audit-log';
import type { Db } from '../db/driver';
import type { Clock } from '../util/clock';
import type { IdGenerator } from '../util/ids';
import type { Actor } from './context';

export type EndReason = 'LOGOUT' | 'IDLE_TIMEOUT' | 'APP_EXIT' | 'FORCED' | 'CRASH_RECOVERY';

interface LiveSession {
  id: string;
  userId: string;
  workstation: string;
  startedAt: number;
  lastSeenAt: number;
}

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = { idleMinutes: 15, absoluteHours: 12 };

/**
 * Sessions live in backend memory only; the renderer never sees a credential.
 * Permissions are re-read from the database on every request, so a role change
 * or a disabled account takes effect immediately.
 */
export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
    private readonly audit: AuditLog,
    private readonly policy: () => SessionPolicy,
  ) {}

  /** Closes sessions left open by a crash or power cut. */
  recoverAbandoned(): number {
    const now = this.clock.now().toISOString();
    return this.db
      .prepare(`UPDATE user_session SET ended_at = ?, end_reason = 'CRASH_RECOVERY' WHERE ended_at IS NULL`)
      .run(now).changes;
  }

  /** Must be called inside the login transaction. */
  create(userId: string, workstation: string): string {
    const id = this.newId();
    const now = this.clock.now();
    this.db
      .prepare('INSERT INTO user_session (id, user_id, workstation_name, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, workstation, now.toISOString(), now.toISOString());
    this.sessions.set(id, { id, userId, workstation, startedAt: now.getTime(), lastSeenAt: now.getTime() });
    return id;
  }

  end(sessionId: string, reason: EndReason): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE user_session SET ended_at = ?, end_reason = ?, last_seen_at = ? WHERE id = ? AND ended_at IS NULL')
        .run(this.clock.now().toISOString(), reason, new Date(s.lastSeenAt).toISOString(), sessionId);
      this.audit.append(
        { userId: s.userId, sessionId, workstation: s.workstation },
        { action: reason === 'LOGOUT' ? 'auth.logout' : 'auth.session_ended', entityType: 'session', entityId: sessionId, metadata: { reason } },
      );
    })();
  }

  endAll(reason: EndReason): void {
    for (const id of [...this.sessions.keys()]) this.end(id, reason);
  }

  endAllForUser(userId: string, reason: EndReason): void {
    for (const s of [...this.sessions.values()]) if (s.userId === userId) this.end(s.id, reason);
  }

  /** Resolves a session id to an Actor, enforcing idle/absolute timeouts and account state. */
  resolve(sessionId: string | undefined | null): Actor {
    if (!sessionId) throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Please sign in');
    const s = this.sessions.get(sessionId);
    if (!s) throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Please sign in');
    const now = this.clock.now().getTime();
    const { idleMinutes, absoluteHours } = this.policy();
    if (now - s.lastSeenAt > idleMinutes * 60_000 || now - s.startedAt > absoluteHours * 3_600_000) {
      this.end(sessionId, 'IDLE_TIMEOUT');
      throw new DomainError(ErrorCode.SESSION_EXPIRED, 'Your session expired. Please sign in again.');
    }
    const user = this.db.prepare('SELECT id, username, is_active FROM app_user WHERE id = ?').get(s.userId) as
      | { id: string; username: string; is_active: number }
      | undefined;
    if (!user || user.is_active !== 1) {
      this.end(sessionId, 'FORCED');
      throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Your account is no longer active');
    }
    s.lastSeenAt = now;
    return {
      userId: user.id,
      username: user.username,
      sessionId,
      workstation: s.workstation,
      roles: rolesOf(this.db, user.id),
      permissions: new Set(permissionsOf(this.db, user.id)),
    };
  }

  activeCount(): number {
    return this.sessions.size;
  }
}

export function rolesOf(db: Db, userId: string): string[] {
  return (
    db.prepare('SELECT r.code FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.code').all(userId) as {
      code: string;
    }[]
  ).map((r) => r.code);
}

export function permissionsOf(db: Db, userId: string): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT rp.permission_code AS code FROM user_role ur
         JOIN role_permission rp ON rp.role_id = ur.role_id WHERE ur.user_id = ? ORDER BY 1`,
      )
      .all(userId) as { code: string }[]
  ).map((r) => r.code);
}
