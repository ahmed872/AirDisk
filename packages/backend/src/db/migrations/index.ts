import type { Migration } from '../migrator';
import m0001 from './0001_initial.sql?raw';
import m0002 from './0002_master_data.sql?raw';
import m0003 from './0003_operations.sql?raw';
import m0004 from './0004_performance_indexes.sql?raw';
import m0005 from './0005_ledger_completion.sql?raw';

/**
 * Forward-only, append-only list. NEVER edit a released migration: the
 * checksum check will refuse to start on databases that already applied it.
 * Add a new numbered file instead.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: m0001 },
  { version: 2, name: 'master_data', sql: m0002 },
  { version: 3, name: 'operations', sql: m0003 },
  { version: 4, name: 'performance_indexes', sql: m0004 },
  { version: 5, name: 'ledger_completion', sql: m0005 },
];
