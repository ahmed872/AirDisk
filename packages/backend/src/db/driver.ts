/**
 * The single import point of the SQLite driver. better-sqlite3-multiple-ciphers
 * is API-compatible with better-sqlite3 and adds SQLCipher-compatible
 * encryption (owner decision Q7). Keeping it behind this module means the
 * driver can be swapped without touching repositories or services.
 */
import Database from 'better-sqlite3-multiple-ciphers';

export type Db = Database.Database;
export { Database };
