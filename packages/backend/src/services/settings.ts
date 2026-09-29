import { z } from 'zod';
import type { Db } from '../db/driver';

/**
 * Typed app settings (key/value table). Unknown keys are rejected; every value
 * is validated on read and write, so a corrupted row falls back to the default
 * instead of crashing the app.
 */
export const SETTING_SCHEMAS = {
  'session.idle_minutes': z.number().int().min(1).max(240),
  'session.absolute_hours': z.number().int().min(1).max(24),
  'auth.max_failed_logins': z.number().int().min(3).max(20),
  'auth.lockout_minutes': z.number().int().min(1).max(1440),
  'finance.backdate_days': z.number().int().min(0).max(366),
  'aging.buckets': z.array(z.number().int().min(0)).min(1).max(10).refine((a) => a.every((v, i) => i === 0 || v > a[i - 1]!), 'ascending'),
  'backup.directory': z.string().max(1000).nullable(),
  /** Automatic backup when the newest successful backup is older than this (0 = off). */
  'backup.auto_interval_hours': z.number().int().min(0).max(720),
  /** How many automatic (SCHEDULED) backup files to keep; manual and safety backups are never pruned. */
  'backup.keep_scheduled': z.number().int().min(1).max(365),
  'schedule.major_threshold_minutes': z.number().int().min(5).max(1440),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;

export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  'session.idle_minutes': 15,
  'session.absolute_hours': 12,
  'auth.max_failed_logins': 5,
  'auth.lockout_minutes': 15,
  'finance.backdate_days': 3,
  'aging.buckets': [0, 7, 30, 60],
  'backup.directory': null,
  'backup.auto_interval_hours': 24,
  'backup.keep_scheduled': 14,
  'schedule.major_threshold_minutes': 60,
};

export function readSetting<K extends SettingKey>(db: Db, key: K): SettingValue<K> {
  const row = db.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(key) as { value_json: string } | undefined;
  if (!row) return SETTING_DEFAULTS[key];
  const parsed = SETTING_SCHEMAS[key].safeParse(JSON.parse(row.value_json));
  return parsed.success ? (parsed.data as SettingValue<K>) : SETTING_DEFAULTS[key];
}

export function writeSetting<K extends SettingKey>(db: Db, key: K, value: SettingValue<K>, userId: string | null, now: string): void {
  const valid = SETTING_SCHEMAS[key].parse(value);
  db.prepare(
    `INSERT INTO app_setting (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(key, JSON.stringify(valid), now, userId);
}
