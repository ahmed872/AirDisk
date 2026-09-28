import { DomainError, ErrorCode, assertPasswordPolicy } from '@airdesk/domain';
import type { CompanyProfileInput, SessionUserDto } from '@airdesk/contracts';
import type { PasswordHasher } from '../security/password-hasher';
import type { CompanyService } from './company-service';
import { actorOf, tx, type Actor, type ServiceDeps } from './context';
import { permissionsOf, rolesOf, type SessionManager } from './session-manager';
import { readSetting } from './settings';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  must_change_password: number;
  is_active: number;
  failed_login_count: number;
  locked_until: string | null;
  preferred_locale: 'ar' | 'en' | null;
}

export interface LoginResult {
  sessionId: string;
  user: SessionUserDto;
}

export class AuthService {
  /** Verified against for unknown usernames so response time does not reveal which usernames exist. */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionManager,
    private readonly company: CompanyService,
  ) {}

  isSetupRequired(): boolean {
    const users = this.deps.db.prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number };
    return users.n === 0 || !this.company.exists();
  }

  /**
   * First-run setup: company profile + the first Admin, atomically. Only
   * possible while no user exists; afterwards it is permanently refused.
   * No default or hidden account is ever created (owner decision Q7).
   */
  async setup(
    input: { company: CompanyProfileInput; admin: { username: string; displayName: string; password: string; locale: 'ar' | 'en' } },
    workstation: string,
  ): Promise<void> {
    if (!this.isSetupRequired()) throw new DomainError(ErrorCode.SETUP_ALREADY_DONE, 'Setup has already been completed');
    assertPasswordPolicy(input.admin.password, input.admin.username);
    const passwordHash = await this.hasher.hash(input.admin.password);
    tx(this.deps, () => {
      if (!this.isSetupRequired()) throw new DomainError(ErrorCode.SETUP_ALREADY_DONE, 'Setup has already been completed');
      const now = this.deps.clock.now().toISOString();
      const userId = this.deps.newId();
      this.company.insertInitial(input.company, null);
      this.deps.db
        .prepare(
          `INSERT INTO app_user (id, username, display_name, password_hash, must_change_password, is_active, password_changed_at,
             preferred_locale, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`,
        )
        .run(userId, input.admin.username, input.admin.displayName, passwordHash, now, input.admin.locale, now, now);
      const admin = this.deps.db.prepare(`SELECT id FROM role WHERE code = 'ADMIN'`).get() as { id: string };
      this.deps.db.prepare('INSERT INTO user_role (user_id, role_id) VALUES (?, ?)').run(userId, admin.id);
      const actor = { userId, sessionId: null, workstation };
      this.deps.audit.append(actor, { action: 'setup.completed', entityType: 'company_profile', entityId: '1', after: { ...input.company, logoBase64: undefined } });
      this.deps.audit.append(actor, {
        action: 'user.created',
        entityType: 'app_user',
        entityId: userId,
        after: { username: input.admin.username, displayName: input.admin.displayName, roles: ['ADMIN'] },
      });
    });
  }

  async login(username: string, password: string, workstation: string): Promise<LoginResult> {
    const db = this.deps.db;
    const user = db.prepare('SELECT * FROM app_user WHERE username = ?').get(username.trim()) as UserRow | undefined;
    const now = this.deps.clock.now();
    const fail = (userId: string | null, reason: string, code: ErrorCode = ErrorCode.INVALID_CREDENTIALS): never => {
      throw new DomainError(code, code === ErrorCode.ACCOUNT_LOCKED ? 'Account temporarily locked' : 'Invalid username or password', {
        ...(code === ErrorCode.ACCOUNT_LOCKED && userId ? { reason } : {}),
      });
    };

    if (!user) {
      await this.hasher.verify(await this.getDummyHash(), password);
      this.deps.audit.append({ userId: null, sessionId: null, workstation }, {
        action: 'auth.login_failed',
        entityType: 'app_user',
        metadata: { username: username.trim().slice(0, 40), reason: 'unknown_user' },
      });
      return fail(null, 'unknown_user');
    }
    if (user.locked_until && user.locked_until > now.toISOString()) {
      this.deps.audit.append({ userId: user.id, sessionId: null, workstation }, {
        action: 'auth.login_failed', entityType: 'app_user', entityId: user.id, metadata: { reason: 'locked' },
      });
      return fail(user.id, 'locked', ErrorCode.ACCOUNT_LOCKED);
    }

    const ok = await this.hasher.verify(user.password_hash, password);
    if (!ok) {
      const maxFailed = readSetting(db, 'auth.max_failed_logins');
      const lockMinutes = readSetting(db, 'auth.lockout_minutes');
      const locked = tx(this.deps, () => {
        const count = user.failed_login_count + 1;
        const lockNow = count >= maxFailed;
        db.prepare('UPDATE app_user SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(
          lockNow ? 0 : count,
          lockNow ? new Date(now.getTime() + lockMinutes * 60_000).toISOString() : null,
          now.toISOString(),
          user.id,
        );
        const actor = { userId: user.id, sessionId: null, workstation };
        this.deps.audit.append(actor, { action: 'auth.login_failed', entityType: 'app_user', entityId: user.id, metadata: { reason: 'bad_password', attempt: count } });
        if (lockNow) this.deps.audit.append(actor, { action: 'auth.locked', entityType: 'app_user', entityId: user.id, metadata: { minutes: lockMinutes } });
        return lockNow;
      });
      return fail(user.id, 'bad_password', locked ? ErrorCode.ACCOUNT_LOCKED : ErrorCode.INVALID_CREDENTIALS);
    }
    if (user.is_active !== 1) {
      this.deps.audit.append({ userId: user.id, sessionId: null, workstation }, {
        action: 'auth.login_failed', entityType: 'app_user', entityId: user.id, metadata: { reason: 'disabled' },
      });
      throw new DomainError(ErrorCode.ACCOUNT_DISABLED, 'This account is disabled');
    }

    const sessionId = tx(this.deps, () => {
      db.prepare('UPDATE app_user SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?').run(
        now.toISOString(),
        now.toISOString(),
        user.id,
      );
      const id = this.sessions.create(user.id, workstation);
      this.deps.audit.append({ userId: user.id, sessionId: id, workstation }, { action: 'auth.login', entityType: 'session', entityId: id });
      return id;
    });
    return { sessionId, user: this.me(user.id) };
  }

  logout(actor: Actor): void {
    this.sessions.end(actor.sessionId, 'LOGOUT');
  }

  me(userId: string): SessionUserDto {
    const u = this.deps.db
      .prepare('SELECT id, username, display_name, preferred_locale, must_change_password FROM app_user WHERE id = ?')
      .get(userId) as { id: string; username: string; display_name: string; preferred_locale: 'ar' | 'en' | null; must_change_password: number };
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      locale: u.preferred_locale,
      mustChangePassword: u.must_change_password === 1,
      roles: rolesOf(this.deps.db, userId),
      permissions: permissionsOf(this.deps.db, userId),
    };
  }

  mustChangePassword(userId: string): boolean {
    const r = this.deps.db.prepare('SELECT must_change_password FROM app_user WHERE id = ?').get(userId) as { must_change_password: number };
    return r.must_change_password === 1;
  }

  async changePassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
    const row = this.deps.db.prepare('SELECT password_hash FROM app_user WHERE id = ?').get(actor.userId) as { password_hash: string };
    if (!(await this.hasher.verify(row.password_hash, currentPassword))) {
      this.deps.audit.append(actorOf(actor), { action: 'auth.password_change_failed', entityType: 'app_user', entityId: actor.userId });
      throw new DomainError(ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect');
    }
    if (currentPassword === newPassword) throw new DomainError(ErrorCode.PASSWORD_POLICY, 'The new password must be different');
    assertPasswordPolicy(newPassword, actor.username);
    const hashed = await this.hasher.hash(newPassword);
    tx(this.deps, () => {
      const now = this.deps.clock.now().toISOString();
      this.deps.db
        .prepare('UPDATE app_user SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?')
        .run(hashed, now, now, actor.userId);
      this.deps.audit.append(actorOf(actor), { action: 'auth.password_changed', entityType: 'app_user', entityId: actor.userId });
    });
  }

  /** Step-up re-authentication for dangerous actions (restore, etc.). */
  async confirmPassword(actor: Actor, password: string): Promise<void> {
    const row = this.deps.db.prepare('SELECT password_hash FROM app_user WHERE id = ?').get(actor.userId) as { password_hash: string };
    if (!(await this.hasher.verify(row.password_hash, password))) {
      this.deps.audit.append(actorOf(actor), { action: 'auth.step_up_failed', entityType: 'app_user', entityId: actor.userId });
      throw new DomainError(ErrorCode.INVALID_CREDENTIALS, 'Password is incorrect');
    }
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash('dummy-password-for-timing-equalisation');
    return this.dummyHash;
  }
}
