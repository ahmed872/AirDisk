import {
  ALL_PERMISSION_CODES,
  DomainError,
  ErrorCode,
  PERMISSIONS,
  PERMISSION_RENAMES,
  SEED_CURRENCIES,
  SEED_EXPENSE_CATEGORIES,
  SYSTEM_ACCOUNTS,
  SYSTEM_ROLES,
  defaultPermissionsForRole,
} from '@airdesk/domain';
import type { IdGenerator } from '../util/ids';
import type { Db } from './driver';

/**
 * Idempotent seeding of system data from the domain package (single source of
 * truth). Runs after every migration pass, inside one transaction:
 *  - currencies and expense categories: inserted if missing, never overwritten;
 *  - ledger accounts: inserted if missing and VERIFIED — a system account whose
 *    class/side/dimension drifted is an integrity failure, never "fixed";
 *  - permissions: upserted; newly introduced permissions are granted to the
 *    system roles whose defaults include them (existing custom edits kept);
 *    superseded codes are migrated through PERMISSION_RENAMES, then removed;
 *  - ADMIN always holds every permission (owner decision Q5: full access).
 */
export function seedSystemData(db: Db, opts: { newId: IdGenerator; now: string; appVersion: string }): void {
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM installation').get()) {
      db.prepare('INSERT INTO installation (id, created_at, created_app_version) VALUES (?, ?, ?)').run(opts.newId(), opts.now, opts.appVersion);
    }

    const insCurrency = db.prepare(
      'INSERT OR IGNORE INTO currency (code, name_ar, name_en, symbol, minor_unit, is_active) VALUES (?, ?, ?, ?, ?, 1)',
    );
    for (const c of SEED_CURRENCIES) insCurrency.run(c.code, c.nameAr, c.nameEn, c.symbol, c.minorUnit);

    const insAccount = db.prepare(
      `INSERT OR IGNORE INTO ledger_account (code, name_ar, name_en, account_class, normal_side, dimension, is_system, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
    );
    const getAccount = db.prepare('SELECT account_class, normal_side, dimension FROM ledger_account WHERE code = ?');
    for (const a of SYSTEM_ACCOUNTS) {
      insAccount.run(a.code, a.nameAr, a.nameEn, a.accountClass, a.normalSide, a.dimension);
      const row = getAccount.get(a.code) as { account_class: string; normal_side: string; dimension: string };
      if (row.account_class !== a.accountClass || row.normal_side !== a.normalSide || row.dimension !== a.dimension) {
        throw new DomainError(ErrorCode.INTEGRITY_FAILURE, `System account ${a.code} differs from the chart of accounts`, { code: a.code });
      }
    }

    const hasCategory = db.prepare('SELECT 1 FROM expense_category WHERE code = ?');
    const insCategory = db.prepare(
      'INSERT INTO expense_category (id, code, name_ar, name_en, ledger_account_code, is_active) VALUES (?, ?, ?, ?, ?, 1)',
    );
    for (const c of SEED_EXPENSE_CATEGORIES) {
      if (!hasCategory.get(c.code)) insCategory.run(opts.newId(), c.code, c.nameAr, c.nameEn, c.accountCode);
    }

    const existingPerms = new Set((db.prepare('SELECT code FROM permission').all() as { code: string }[]).map((r) => r.code));
    const upsertPerm = db.prepare(
      `INSERT INTO permission (code, module, is_sensitive, description_ar, description_en) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET module = excluded.module, is_sensitive = excluded.is_sensitive,
         description_ar = excluded.description_ar, description_en = excluded.description_en`,
    );
    for (const perm of PERMISSIONS) upsertPerm.run(perm.code, perm.module, perm.sensitive ? 1 : 0, perm.ar, perm.en);
    const newlyAdded = new Set([...ALL_PERMISSION_CODES].filter((c) => !existingPerms.has(c)));

    // Superseded codes: every role that held an old code receives all of its
    // replacements, then the old code disappears. Nobody silently loses access.
    const holders = db.prepare('SELECT role_id FROM role_permission WHERE permission_code = ?');
    const grantRename = db.prepare('INSERT OR IGNORE INTO role_permission (role_id, permission_code) VALUES (?, ?)');
    for (const [oldCode, replacements] of Object.entries(PERMISSION_RENAMES)) {
      if (!existingPerms.has(oldCode)) continue;
      for (const { role_id } of holders.all(oldCode) as { role_id: string }[]) {
        for (const r of replacements) grantRename.run(role_id, r);
      }
    }
    // Drop anything no longer in the catalogue (renamed or retired codes).
    const obsolete = [...existingPerms].filter((c) => !ALL_PERMISSION_CODES.has(c));
    const delGrants = db.prepare('DELETE FROM role_permission WHERE permission_code = ?');
    const delPerm = db.prepare('DELETE FROM permission WHERE code = ?');
    for (const c of obsolete) {
      delGrants.run(c);
      delPerm.run(c);
    }

    const getRole = db.prepare('SELECT id FROM role WHERE code = ?');
    const insRole = db.prepare('INSERT INTO role (id, code, name_ar, name_en, is_system, created_at) VALUES (?, ?, ?, ?, 1, ?)');
    const grant = db.prepare('INSERT OR IGNORE INTO role_permission (role_id, permission_code) VALUES (?, ?)');
    for (const role of SYSTEM_ROLES) {
      let row = getRole.get(role.code) as { id: string } | undefined;
      const defaults = defaultPermissionsForRole(role.code);
      if (!row) {
        row = { id: opts.newId() };
        insRole.run(row.id, role.code, role.nameAr, role.nameEn, opts.now);
        for (const c of defaults) grant.run(row.id, c);
      } else if (role.permissions === 'ALL') {
        for (const c of ALL_PERMISSION_CODES) grant.run(row.id, c);
      } else {
        for (const c of defaults) if (newlyAdded.has(c)) grant.run(row.id, c);
      }
    }
  })();
}
