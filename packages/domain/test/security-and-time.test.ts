import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION_CODES,
  DOCUMENT_POST_PERMISSIONS,
  DOCUMENT_REVERSE_PERMISSIONS,
  DOC_TYPES,
  ErrorCode,
  PERMISSIONS,
  SYSTEM_ROLES,
  assertPasswordPolicy,
  assertPeriodOpen,
  businessDate,
  classifyLockDateChange,
  defaultPermissionsForRole,
  isIsoDate,
} from '../src';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('permission catalogue', () => {
  it('has unique, well-formed codes', () => {
    expect(new Set(PERMISSIONS.map((x) => x.code)).size).toBe(PERMISSIONS.length);
    for (const perm of PERMISSIONS) expect(perm.code).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });

  it('every system role and document permission refers to a known code', () => {
    for (const role of SYSTEM_ROLES) for (const c of defaultPermissionsForRole(role.code)) expect(ALL_PERMISSION_CODES.has(c)).toBe(true);
    for (const t of DOC_TYPES) {
      expect(DOCUMENT_POST_PERMISSIONS[t].length).toBeGreaterThan(0);
      expect(DOCUMENT_REVERSE_PERMISSIONS[t].length).toBeGreaterThan(0);
      for (const c of [...DOCUMENT_POST_PERMISSIONS[t], ...DOCUMENT_REVERSE_PERMISSIONS[t]]) expect(ALL_PERMISSION_CODES.has(c)).toBe(true);
    }
  });

  it('Q5: sales agents can enter cost but not see cost/profit or reverse money', () => {
    const agent = new Set(defaultPermissionsForRole('SALES_AGENT'));
    expect(agent.has('booking.enter_cost')).toBe(true);
    expect(agent.has('payment.customer.receive')).toBe(true);
    for (const denied of ['booking.view_cost', 'booking.view_profit', 'payment.customer.reverse', 'payment.customer.refund', 'dashboard.financial', 'report.profit', 'user.manage', 'backup.restore']) {
      expect(agent.has(denied)).toBe(false);
    }
  });

  it('admin has everything; accountant can lock but not unlock; only admin restores', () => {
    expect(new Set(defaultPermissionsForRole('ADMIN'))).toEqual(ALL_PERMISSION_CODES);
    const acc = new Set(defaultPermissionsForRole('ACCOUNTANT'));
    expect(acc.has('finance.lock_period')).toBe(true);
    expect(acc.has('finance.unlock_period')).toBe(false);
    for (const role of ['MANAGER', 'ACCOUNTANT', 'SALES_AGENT']) expect(defaultPermissionsForRole(role)).not.toContain('backup.restore');
  });
});

describe('password policy', () => {
  it('accepts a long passphrase and rejects weak ones', () => {
    expect(() => assertPasswordPolicy('correct horse battery', 'admin')).not.toThrow();
    for (const bad of ['short', 'password123', 'admin-secret-1', 'aaaaaaaaaaaa', 'abababababab']) {
      expect(code(() => assertPasswordPolicy(bad, 'admin'))).toBe(ErrorCode.PASSWORD_POLICY);
    }
  });
});

describe('dates & periods', () => {
  it('validates calendar dates strictly', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-9-1')).toBe(false);
  });

  it('computes the business date in the company timezone, not the PC timezone', () => {
    const instant = new Date('2026-09-27T21:30:00Z');
    expect(businessDate(instant, 'Asia/Riyadh')).toBe('2026-09-28');
    expect(businessDate(instant, 'UTC')).toBe('2026-09-27');
    expect(code(() => businessDate(instant, 'Mars/Olympus'))).toBe(ErrorCode.VALIDATION);
  });

  it('rejects documents dated on or before the lock date', () => {
    expect(code(() => assertPeriodOpen('2026-09-30', '2026-09-30'))).toBe(ErrorCode.PERIOD_LOCKED);
    expect(code(() => assertPeriodOpen('2026-09-15', '2026-09-30'))).toBe(ErrorCode.PERIOD_LOCKED);
    expect(() => assertPeriodOpen('2026-10-01', '2026-09-30')).not.toThrow();
    expect(() => assertPeriodOpen('2026-10-01', null)).not.toThrow();
  });

  it('classifies lock date moves', () => {
    expect(classifyLockDateChange(null, '2026-09-30')).toBe('LOCK');
    expect(classifyLockDateChange('2026-08-31', '2026-09-30')).toBe('LOCK');
    expect(classifyLockDateChange('2026-09-30', '2026-08-31')).toBe('UNLOCK');
    expect(classifyLockDateChange('2026-09-30', '2026-09-30')).toBe('UNCHANGED');
  });
});
