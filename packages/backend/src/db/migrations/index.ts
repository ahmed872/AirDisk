import type { Migration } from '../migrator';
import m0001 from './0001_initial.sql?raw';

/**
 * Forward-only, append-only list. NEVER edit a released migration: the
 * checksum check will refuse to start on databases that already applied it.
 * Add a new numbered file instead.
 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'initial', sql: m0001 }];
