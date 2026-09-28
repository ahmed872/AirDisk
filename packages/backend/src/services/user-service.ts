import { DomainError, ErrorCode, PERMISSIONS, assertPasswordPolicy, isKnownPermission } from '@airdesk/domain';
import type { PermissionDto, RoleDto, UserDto } from '@airdesk/contracts';
import type { PasswordHasher } from '../security/password-hasher';
import { actorOf, requirePermission, tx, type Actor, type ServiceDeps } from './context';
import { rolesOf, type SessionManager } from './session-manager';

/**
 * Users, roles and permissions (RBAC foundation). Roles are data and fully
 * configurable (owner decision Q5); only ADMIN is fixed to "all permissions".
 * Users are never deleted, only disabled. The last active Admin is protected.
 */
export class UserService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionManager,
  ) {}

  listUsers(actor: Actor): UserDto[] {
    requirePermission(this.deps, actor, 'user.manage', 'users.list');
    const now = this.deps.clock.now().toISOString();
    const rows = this.deps.db
      .prepare('SELECT id, username, display_name, is_active, locked_until, must_change_password, last_login_at FROM app_user ORDER BY username')
      .all() as { id: string; username: string; display_name: string; is_active: number; locked_until: string | null; must_change_password: number; last_login_at: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      isActive: r.is_active === 1,
      isLocked: !!r.locked_until && r.locked_until > now,
      mustChangePassword: r.must_change_password === 1,
      lastLoginAt: r.last_login_at,
      roles: rolesOf(this.deps.db, r.id),
    }));
  }

  async createUser(
    actor: Actor,
    input: { username: string; displayName: string; password: string; roleCodes: string[]; locale?: 'ar' | 'en' },
  ): Promise<UserDto> {
    requirePermission(this.deps, actor, 'user.manage', 'users.create');
    assertPasswordPolicy(input.password, input.username);
    const hashed = await this.hasher.hash(input.password);
    const id = tx(this.deps, () => {
      if (this.deps.db.prepare('SELECT 1 FROM app_user WHERE username = ?').get(input.username)) {
        throw new DomainError(ErrorCode.CONFLICT, 'This username is already taken');
      }
      const roleIds = this.roleIds(input.roleCodes);
      const now = this.deps.clock.now().toISOString();
      const userId = this.deps.newId();
      this.deps.db
        .prepare(
          `INSERT INTO app_user (id, username, display_name, password_hash, must_change_password, is_active, password_changed_at,
             preferred_locale, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
        )
        .run(userId, input.username, input.displayName, hashed, now, input.locale ?? null, now, actor.userId, now);
      const link = this.deps.db.prepare('INSERT INTO user_role (user_id, role_id) VALUES (?, ?)');
      for (const rid of roleIds) link.run(userId, rid);
      this.deps.audit.append(actorOf(actor), {
        action: 'user.created',
        entityType: 'app_user',
        entityId: userId,
        after: { username: input.username, displayName: input.displayName, roles: [...input.roleCodes].sort() },
      });
      return userId;
    });
    return this.listUsers(actor).find((u) => u.id === id)!;
  }

  setUserRoles(actor: Actor, userId: string, roleCodes: string[]): void {
    requirePermission(this.deps, actor, 'user.manage', 'users.setRoles');
    tx(this.deps, () => {
      this.assertUser(userId);
      const roleIds = this.roleIds(roleCodes);
      const before = rolesOf(this.deps.db, userId);
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
    requirePermission(this.deps, actor, 'user.manage', 'users.setActive');
    tx(this.deps, () => {
      const before = this.assertUser(userId);
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

  async resetPassword(actor: Actor, userId: string, newPassword: string): Promise<void> {
    requirePermission(this.deps, actor, 'user.manage', 'users.resetPassword');
    const user = this.assertUser(userId);
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
    requirePermission(this.deps, actor, ['user.manage', 'role.manage'], 'roles.list');
    const roles = this.deps.db.prepare('SELECT id, code, name_ar, name_en, is_system FROM role ORDER BY is_system DESC, code').all() as {
      id: string; code: string; name_ar: string; name_en: string; is_system: number;
    }[];
    const perms = this.deps.db.prepare('SELECT permission_code FROM role_permission WHERE role_id = ? ORDER BY 1');
    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      isSystem: r.is_system === 1,
      permissions: (perms.all(r.id) as { permission_code: string }[]).map((x) => x.permission_code),
    }));
  }

  listPermissions(actor: Actor): PermissionDto[] {
    requirePermission(this.deps, actor, ['user.manage', 'role.manage'], 'permissions.list');
    return PERMISSIONS.map((p) => ({ code: p.code, module: p.module, sensitive: p.sensitive, ar: p.ar, en: p.en }));
  }

  createRole(actor: Actor, input: { code: string; nameAr: string; nameEn: string; permissions: string[] }): RoleDto {
    requirePermission(this.deps, actor, 'role.manage', 'roles.create');
    this.assertPermissions(input.permissions);
    const id = tx(this.deps, () => {
      if (this.deps.db.prepare('SELECT 1 FROM role WHERE code = ?').get(input.code)) throw new DomainError(ErrorCode.CONFLICT, 'Role code already exists');
      const roleId = this.deps.newId();
      this.deps.db
        .prepare('INSERT INTO role (id, code, name_ar, name_en, is_system, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        .run(roleId, input.code, input.nameAr, input.nameEn, this.deps.clock.now().toISOString());
      const grant = this.deps.db.prepare('INSERT INTO role_permission (role_id, permission_code) VALUES (?, ?)');
      for (const p of new Set(input.permissions)) grant.run(roleId, p);
      this.deps.audit.append(actorOf(actor), {
        action: 'role.created', entityType: 'role', entityId: roleId, after: { code: input.code, permissions: [...new Set(input.permissions)].sort() },
      });
      return roleId;
    });
    return this.listRoles(actor).find((r) => r.id === id)!;
  }

  setRolePermissions(actor: Actor, roleId: string, permissions: string[]): void {
    requirePermission(this.deps, actor, 'role.manage', 'roles.setPermissions');
    this.assertPermissions(permissions);
    tx(this.deps, () => {
      const role = this.deps.db.prepare('SELECT code FROM role WHERE id = ?').get(roleId) as { code: string } | undefined;
      if (!role) throw new DomainError(ErrorCode.NOT_FOUND, 'Role not found');
      if (role.code === 'ADMIN') throw new DomainError(ErrorCode.VALIDATION, 'The Administrator role always has full access');
      const before = (this.deps.db.prepare('SELECT permission_code FROM role_permission WHERE role_id = ? ORDER BY 1').all(roleId) as { permission_code: string }[]).map((r) => r.permission_code);
      this.deps.db.prepare('DELETE FROM role_permission WHERE role_id = ?').run(roleId);
      const grant = this.deps.db.prepare('INSERT INTO role_permission (role_id, permission_code) VALUES (?, ?)');
      for (const p of new Set(permissions)) grant.run(roleId, p);
      this.deps.db.prepare('UPDATE role SET row_version = row_version + 1 WHERE id = ?').run(roleId);
      this.deps.audit.append(actorOf(actor), {
        action: 'role.permissions_changed', entityType: 'role', entityId: roleId, before: { permissions: before }, after: { permissions: [...new Set(permissions)].sort() },
      });
    });
  }

  private assertPermissions(codes: string[]): void {
    const unknown = codes.filter((c) => !isKnownPermission(c));
    if (unknown.length) throw new DomainError(ErrorCode.VALIDATION, 'Unknown permissions', { unknown });
  }

  private assertUser(userId: string) {
    const u = this.deps.db.prepare('SELECT id, username, is_active FROM app_user WHERE id = ?').get(userId) as
      | { id: string; username: string; is_active: number }
      | undefined;
    if (!u) throw new DomainError(ErrorCode.NOT_FOUND, 'User not found');
    return u;
  }

  private roleIds(codes: string[]): string[] {
    const get = this.deps.db.prepare('SELECT id FROM role WHERE code = ?');
    return [...new Set(codes)].map((c) => {
      const r = get.get(c) as { id: string } | undefined;
      if (!r) throw new DomainError(ErrorCode.VALIDATION, `Unknown role ${c}`);
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
