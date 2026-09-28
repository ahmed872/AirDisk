import {
  DomainError,
  ErrorCode,
  PERMISSIONS,
  assertPasswordPolicy,
  assertUserTransition,
  deriveUserStatus,
  isKnownPermission,
  normalizeEmail,
  normalizeOptionalPhone,
  optionalText,
} from '@airdesk/domain';
import type { PermissionDto, RoleDto, UserDto } from '@airdesk/contracts';
import type { PasswordHasher } from '../security/password-hasher';
import type { CompanyService } from './company-service';
import { actorOf, requirePermission, tx, type Actor, type ServiceDeps } from './context';
import { rolesOf, type SessionManager } from './session-manager';

interface UserRow {
  id: string; username: string; display_name: string; email: string | null; mobile: string | null; notes: string | null;
  preferred_locale: 'ar' | 'en' | null; is_active: number; locked_until: string | null; must_change_password: number;
  last_login_at: string | null; created_at: string; updated_at: string; row_version: number;
}

/**
 * Users, roles and permissions (RBAC). Roles are data and fully configurable;
 * only ADMIN is fixed to "all permissions". Safety rules:
 *  - users are never deleted, only disabled;
 *  - at least one ACTIVE Administrator must always remain;
 *  - nobody can disable themselves or remove their own ADMIN role;
 *  - no privilege escalation: a non-admin can only grant permissions (or
 *    roles) whose permissions they hold themselves, and only an admin can
 *    assign the ADMIN role.
 * Every change is written to the hash-chained audit log in the same transaction.
 */
export class UserService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionManager,
    private readonly company: CompanyService,
  ) {}

  listUsers(actor: Actor, filter: { query?: string | undefined; status?: 'ALL' | 'ACTIVE' | 'DISABLED' } = {}): UserDto[] {
    requirePermission(this.deps, actor, 'user.view', 'users.list');
    const q = filter.query?.trim().toLowerCase() ?? '';
    return (this.deps.db.prepare('SELECT * FROM app_user ORDER BY username COLLATE NOCASE').all() as UserRow[])
      .map((r) => this.toDto(r))
      .filter((u) => (filter.status === 'ACTIVE' ? u.isActive : filter.status === 'DISABLED' ? !u.isActive : true))
      .filter((u) => !q || [u.username, u.displayName, u.email ?? '', u.mobile ?? ''].some((f) => f.toLowerCase().includes(q)));
  }

  async createUser(
    actor: Actor,
    input: { username: string; displayName: string; password: string; roleCodes: string[]; locale?: 'ar' | 'en' | undefined; email?: string | null | undefined; mobile?: string | null | undefined; notes?: string | null | undefined },
  ): Promise<UserDto> {
    requirePermission(this.deps, actor, 'user.create', 'users.create');
    if (input.roleCodes.length) requirePermission(this.deps, actor, 'user.assign_roles', 'users.create:roles');
    const profile = this.profile(input);
    assertPasswordPolicy(input.password, input.username);
    this.assertCanAssignRoles(actor, input.roleCodes);
    const hashed = await this.hasher.hash(input.password);
    const id = tx(this.deps, () => {
      if (this.deps.db.prepare('SELECT 1 FROM app_user WHERE username = ?').get(input.username)) {
        throw new DomainError(ErrorCode.CONFLICT, 'This username is already taken', { field: 'username', reason: 'DUPLICATE_USERNAME' });
      }
      const roleIds = this.roleIds(input.roleCodes);
      const now = this.deps.clock.now().toISOString();
      const userId = this.deps.newId();
      this.deps.db
        .prepare(
          `INSERT INTO app_user (id, username, display_name, password_hash, must_change_password, is_active, password_changed_at,
             preferred_locale, email, mobile, notes, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, input.username, input.displayName.trim(), hashed, now, input.locale ?? null, profile.email, profile.mobile, profile.notes, now, actor.userId, now);
      const link = this.deps.db.prepare('INSERT INTO user_role (user_id, role_id) VALUES (?, ?)');
      for (const rid of roleIds) link.run(userId, rid);
      this.deps.audit.append(actorOf(actor), {
        action: 'user.created',
        entityType: 'app_user',
        entityId: userId,
        after: { username: input.username, displayName: input.displayName, ...profile, roles: [...input.roleCodes].sort() },
      });
      return userId;
    });
    return this.getUser(id);
  }

  updateUser(
    actor: Actor,
    input: { userId: string; displayName: string; email?: string | null | undefined; mobile?: string | null | undefined; notes?: string | null | undefined; locale?: 'ar' | 'en' | null | undefined; rowVersion: number },
  ): UserDto {
    requirePermission(this.deps, actor, 'user.edit', 'users.update');
    const profile = this.profile(input);
    tx(this.deps, () => {
      const before = this.row(input.userId);
      if (before.row_version !== input.rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'This user was changed by someone else');
      this.deps.db
        .prepare('UPDATE app_user SET display_name = ?, email = ?, mobile = ?, notes = ?, preferred_locale = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?')
        .run(input.displayName.trim(), profile.email, profile.mobile, profile.notes, input.locale ?? null, this.deps.clock.now().toISOString(), input.userId);
      this.deps.audit.append(actorOf(actor), {
        action: 'user.updated',
        entityType: 'app_user',
        entityId: input.userId,
        before: { displayName: before.display_name, email: before.email, mobile: before.mobile, notes: before.notes, locale: before.preferred_locale },
        after: { displayName: input.displayName.trim(), ...profile, locale: input.locale ?? null },
      });
    });
    return this.getUser(input.userId);
  }

  setUserRoles(actor: Actor, userId: string, roleCodes: string[]): void {
    requirePermission(this.deps, actor, 'user.assign_roles', 'users.setRoles');
    tx(this.deps, () => {
      const target = this.row(userId);
      const before = rolesOf(this.deps.db, userId);
      if (before.includes('ADMIN') && !roleCodes.includes('ADMIN')) {
        assertUserTransition('REMOVE_ADMIN_ROLE', this.status(target), { isSelf: userId === actor.userId });
      }
      const added = roleCodes.filter((c) => !before.includes(c));
      this.assertCanAssignRoles(actor, added);
      const roleIds = this.roleIds(roleCodes);
      this.deps.db.prepare('DELETE FROM user_role WHERE user_id = ?').run(userId);
      const link = this.deps.db.prepare('INSERT INTO user_role (user_id, role_id) VALUES (?, ?)');
      for (const rid of roleIds) link.run(userId, rid);
      this.assertAnActiveAdminRemains();
      this.deps.db.prepare('UPDATE app_user SET updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(this.deps.clock.now().toISOString(), userId);
      this.deps.audit.append(actorOf(actor), {
        action: 'user.roles_changed', entityType: 'app_user', entityId: userId, before: { roles: before }, after: { roles: rolesOf(this.deps.db, userId) },
      });
    });
  }

  setUserActive(actor: Actor, userId: string, active: boolean): void {
    requirePermission(this.deps, actor, 'user.disable', 'users.setActive');
    tx(this.deps, () => {
      const before = this.row(userId);
      assertUserTransition(active ? 'ENABLE' : 'DISABLE', this.status(before), { isSelf: userId === actor.userId });
      this.deps.db
        .prepare('UPDATE app_user SET is_active = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?')
        .run(active ? 1 : 0, this.deps.clock.now().toISOString(), userId);
      this.assertAnActiveAdminRemains();
      this.deps.audit.append(actorOf(actor), {
        action: active ? 'user.enabled' : 'user.disabled', entityType: 'app_user', entityId: userId,
        before: { isActive: before.is_active === 1 }, after: { isActive: active },
      });
    });
    if (!active) this.sessions.endAllForUser(userId, 'FORCED');
  }

  unlockUser(actor: Actor, userId: string): void {
    requirePermission(this.deps, actor, 'user.reset_credentials', 'users.unlock');
    tx(this.deps, () => {
      const before = this.row(userId);
      assertUserTransition('UNLOCK', this.status(before), { isSelf: userId === actor.userId });
      this.deps.db
        .prepare('UPDATE app_user SET locked_until = NULL, failed_login_count = 0, updated_at = ?, row_version = row_version + 1 WHERE id = ?')
        .run(this.deps.clock.now().toISOString(), userId);
      this.deps.audit.append(actorOf(actor), { action: 'user.unlocked', entityType: 'app_user', entityId: userId });
    });
  }

  async resetPassword(actor: Actor, userId: string, newPassword: string): Promise<void> {
    requirePermission(this.deps, actor, 'user.reset_credentials', 'users.resetPassword');
    const user = this.row(userId);
    assertPasswordPolicy(newPassword, user.username);
    const hashed = await this.hasher.hash(newPassword);
    tx(this.deps, () => {
      const now = this.deps.clock.now().toISOString();
      this.deps.db
        .prepare(
          `UPDATE app_user SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL,
             password_changed_at = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?`,
        )
        .run(hashed, now, now, userId);
      this.deps.audit.append(actorOf(actor), { action: 'user.password_reset', entityType: 'app_user', entityId: userId });
    });
    this.sessions.endAllForUser(userId, 'FORCED');
  }

  listRoles(actor: Actor): RoleDto[] {
    requirePermission(this.deps, actor, ['role.view', 'user.assign_roles'], 'roles.list');
    const roles = this.deps.db
      .prepare(
        `SELECT r.id, r.code, r.name_ar, r.name_en, r.description, r.is_system,
           (SELECT COUNT(*) FROM user_role ur WHERE ur.role_id = r.id) AS user_count
         FROM role r ORDER BY r.is_system DESC, r.code`,
      )
      .all() as { id: string; code: string; name_ar: string; name_en: string; description: string | null; is_system: number; user_count: number }[];
    const perms = this.deps.db.prepare('SELECT permission_code FROM role_permission WHERE role_id = ? ORDER BY 1');
    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      description: r.description,
      isSystem: r.is_system === 1,
      userCount: r.user_count,
      permissions: (perms.all(r.id) as { permission_code: string }[]).map((x) => x.permission_code),
    }));
  }

  listPermissions(actor: Actor): PermissionDto[] {
    requirePermission(this.deps, actor, ['role.view', 'user.assign_roles'], 'permissions.list');
    return PERMISSIONS.map((p) => ({ code: p.code, module: p.module, sensitive: p.sensitive, ar: p.ar, en: p.en }));
  }

  createRole(actor: Actor, input: { code: string; nameAr: string; nameEn: string; permissions: string[] }): RoleDto {
    requirePermission(this.deps, actor, 'role.create', 'roles.create');
    if (input.permissions.length) requirePermission(this.deps, actor, 'role.manage_permissions', 'roles.create:permissions');
    this.assertPermissions(input.permissions);
    this.assertCanGrant(actor, input.permissions);
    const id = tx(this.deps, () => {
      if (this.deps.db.prepare('SELECT 1 FROM role WHERE code = ?').get(input.code)) {
        throw new DomainError(ErrorCode.CONFLICT, 'Role code already exists', { field: 'code', reason: 'DUPLICATE_CODE' });
      }
      const roleId = this.deps.newId();
      this.deps.db
        .prepare('INSERT INTO role (id, code, name_ar, name_en, is_system, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        .run(roleId, input.code, input.nameAr.trim(), input.nameEn.trim(), this.deps.clock.now().toISOString());
      const grant = this.deps.db.prepare('INSERT INTO role_permission (role_id, permission_code) VALUES (?, ?)');
      for (const p of new Set(input.permissions)) grant.run(roleId, p);
      this.deps.audit.append(actorOf(actor), {
        action: 'role.created', entityType: 'role', entityId: roleId,
        after: { code: input.code, nameAr: input.nameAr, nameEn: input.nameEn, permissions: [...new Set(input.permissions)].sort() },
      });
      return roleId;
    });
    return this.listRoles(actor).find((r) => r.id === id)!;
  }

  /** Rename / describe a role. The code is an identifier and never changes. */
  updateRole(actor: Actor, input: { roleId: string; nameAr: string; nameEn: string; description?: string | null | undefined }): RoleDto {
    requirePermission(this.deps, actor, 'role.edit', 'roles.update');
    const description = optionalText(input.description, 'description', 500);
    tx(this.deps, () => {
      const before = this.deps.db.prepare('SELECT name_ar, name_en, description FROM role WHERE id = ?').get(input.roleId) as
        | { name_ar: string; name_en: string; description: string | null }
        | undefined;
      if (!before) throw new DomainError(ErrorCode.NOT_FOUND, 'Role not found');
      this.deps.db
        .prepare('UPDATE role SET name_ar = ?, name_en = ?, description = ?, row_version = row_version + 1 WHERE id = ?')
        .run(input.nameAr.trim(), input.nameEn.trim(), description, input.roleId);
      this.deps.audit.append(actorOf(actor), {
        action: 'role.updated', entityType: 'role', entityId: input.roleId,
        before: { nameAr: before.name_ar, nameEn: before.name_en, description: before.description },
        after: { nameAr: input.nameAr.trim(), nameEn: input.nameEn.trim(), description },
      });
    });
    return this.listRoles(actor).find((r) => r.id === input.roleId)!;
  }

  setRolePermissions(actor: Actor, roleId: string, permissions: string[]): void {
    requirePermission(this.deps, actor, 'role.manage_permissions', 'roles.setPermissions');
    this.assertPermissions(permissions);
    tx(this.deps, () => {
      const role = this.deps.db.prepare('SELECT code FROM role WHERE id = ?').get(roleId) as { code: string } | undefined;
      if (!role) throw new DomainError(ErrorCode.NOT_FOUND, 'Role not found');
      if (role.code === 'ADMIN') throw new DomainError(ErrorCode.VALIDATION, 'The Administrator role always has full access', { reason: 'ADMIN_ROLE_FIXED' });
      const before = (this.deps.db.prepare('SELECT permission_code FROM role_permission WHERE role_id = ? ORDER BY 1').all(roleId) as { permission_code: string }[]).map((r) => r.permission_code);
      const target = [...new Set(permissions)].sort();
      this.assertCanGrant(actor, target.filter((p) => !before.includes(p)));
      this.deps.db.prepare('DELETE FROM role_permission WHERE role_id = ?').run(roleId);
      const grant = this.deps.db.prepare('INSERT INTO role_permission (role_id, permission_code) VALUES (?, ?)');
      for (const p of target) grant.run(roleId, p);
      this.deps.db.prepare('UPDATE role SET row_version = row_version + 1 WHERE id = ?').run(roleId);
      this.deps.audit.append(actorOf(actor), {
        action: 'role.permissions_changed', entityType: 'role', entityId: roleId, before: { permissions: before }, after: { permissions: target },
        metadata: { granted: target.filter((p) => !before.includes(p)), revoked: before.filter((p) => !target.includes(p)) },
      });
    });
  }

  getUser(userId: string): UserDto {
    return this.toDto(this.row(userId));
  }

  private profile(input: { email?: string | null | undefined; mobile?: string | null | undefined; notes?: string | null | undefined }) {
    return {
      email: normalizeEmail(input.email),
      mobile: normalizeOptionalPhone(input.mobile, this.company.core().defaultCountry, 'mobile')?.e164 ?? null,
      notes: optionalText(input.notes, 'notes', 2000),
    };
  }

  private toDto(r: UserRow): UserDto {
    const status = this.status(r);
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      email: r.email,
      mobile: r.mobile,
      notes: r.notes,
      locale: r.preferred_locale,
      status,
      isActive: r.is_active === 1,
      isLocked: status === 'LOCKED',
      mustChangePassword: r.must_change_password === 1,
      lastLoginAt: r.last_login_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      rowVersion: r.row_version,
      roles: rolesOf(this.deps.db, r.id),
    };
  }

  private status(r: UserRow) {
    return deriveUserStatus({ isActive: r.is_active === 1, lockedUntil: r.locked_until }, this.deps.clock.now().toISOString());
  }

  /** No privilege escalation through role edits. */
  private assertCanGrant(actor: Actor, permissions: readonly string[]): void {
    if (actor.roles.includes('ADMIN')) return;
    const missing = permissions.filter((p) => !actor.permissions.has(p));
    if (missing.length) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'You cannot grant permissions you do not hold yourself', { reason: 'ESCALATION', missing });
    }
  }

  /** No privilege escalation through role assignment. */
  private assertCanAssignRoles(actor: Actor, roleCodes: readonly string[]): void {
    if (actor.roles.includes('ADMIN')) return;
    if (roleCodes.includes('ADMIN')) throw new DomainError(ErrorCode.FORBIDDEN, 'Only an administrator can assign the Administrator role', { reason: 'ESCALATION' });
    const perms = this.deps.db.prepare('SELECT rp.permission_code FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE r.code = ?');
    for (const code of roleCodes) this.assertCanGrant(actor, (perms.all(code) as { permission_code: string }[]).map((p) => p.permission_code));
  }

  private assertPermissions(codes: string[]): void {
    const unknown = codes.filter((c) => !isKnownPermission(c));
    if (unknown.length) throw new DomainError(ErrorCode.VALIDATION, 'Unknown permissions', { unknown });
  }

  private row(userId: string): UserRow {
    const u = this.deps.db.prepare('SELECT * FROM app_user WHERE id = ?').get(userId) as UserRow | undefined;
    if (!u) throw new DomainError(ErrorCode.NOT_FOUND, 'User not found');
    return u;
  }

  private roleIds(codes: string[]): string[] {
    const get = this.deps.db.prepare('SELECT id FROM role WHERE code = ?');
    return [...new Set(codes)].map((c) => {
      const r = get.get(c) as { id: string } | undefined;
      if (!r) throw new DomainError(ErrorCode.VALIDATION, `Unknown role ${c}`, { field: 'roleCodes', reason: 'UNKNOWN_ROLE' });
      return r.id;
    });
  }

  private assertAnActiveAdminRemains(): void {
    const n = this.deps.db
      .prepare(`SELECT COUNT(*) AS n FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id WHERE r.code = 'ADMIN' AND u.is_active = 1`)
      .get() as { n: number };
    if (n.n === 0) throw new DomainError(ErrorCode.LAST_ADMIN, 'At least one active Administrator must remain');
  }
}

