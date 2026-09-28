import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, type Logger } from '@airdesk/backend';

const KEEP_DAYS = 14;

/**
 * Daily JSON-lines log files in <dataDir>/logs, kept 14 days. Secrets are
 * redacted by createLogger before they reach this sink.
 */
export function createFileLogger(dataDir: string): Logger {
  const dir = join(dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  try {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const f of readdirSync(dir)) {
      const m = /^airdesk-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1]! < cutoff) rmSync(join(dir, f), { force: true });
    }
  } catch {
    /* log rotation must never prevent startup */
  }
  return createLogger((record) => {
    try {
      appendFileSync(join(dir, `airdesk-${record.at.slice(0, 10)}.log`), `${JSON.stringify(record)}\n`);
    } catch {
      /* disk full etc. — never crash the app because of logging */
    }
    if (record.level === 'error') console.error(record.message, record.meta ?? '');
  });
}
