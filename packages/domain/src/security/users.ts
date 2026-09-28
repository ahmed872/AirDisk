import { DomainError, ErrorCode } from '../errors';

export type UserStatus = 'ACTIVE' | 'LOCKED' | 'DISABLED';
export type UserAction = 'DISABLE' | 'ENABLE' | 'UNLOCK' | 'REMOVE_ADMIN_ROLE';

/** Derived, never stored: DISABLED wins over LOCKED; a lock expires by time. */
export function deriveUserStatus(u: { isActive: boolean; lockedUntil: string | null }, nowIso: string): UserStatus {
  if (!u.isActive) return 'DISABLED';
  if (u.lockedUntil && u.lockedUntil > nowIso) return 'LOCKED';
  return 'ACTIVE';
}

/**
 * User state machine (Phase 0 §05-7) plus self-protection: nobody can disable
 * themselves or strip their own administrator role (another admin must do it),
 * so an admin can never lock themselves out by accident. "Last active admin"
 * is checked separately against the database.
 */
export function assertUserTransition(action: UserAction, status: UserStatus, opts: { isSelf: boolean }): void {
  const deny = (reason: string, message: string) => {
    throw new DomainError(ErrorCode.CONFLICT, message, { reason });
  };
  if (opts.isSelf && (action === 'DISABLE' || action === 'REMOVE_ADMIN_ROLE')) {
    deny('SELF_LOCKOUT', 'You cannot disable yourself or remove your own administrator role');
  }
  if (action === 'DISABLE' && status === 'DISABLED') deny('ALREADY_DISABLED', 'User is already disabled');
  if (action === 'ENABLE' && status !== 'DISABLED') deny('ALREADY_ACTIVE', 'User is already enabled');
  if (action === 'UNLOCK' && status !== 'LOCKED') deny('NOT_LOCKED', 'User is not locked');
}

export const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;
