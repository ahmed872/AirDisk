import { redact } from './json';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface LogRecord {
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
  at: string;
}

type Sink = (record: LogRecord) => void;

/** Logger that redacts secrets before any sink sees the record. */
export function createLogger(sink: Sink): Logger {
  const log = (level: LogLevel) => (message: string, meta?: Record<string, unknown>) =>
    sink({ level, message, meta: meta ? redact(meta) : undefined, at: new Date().toISOString() });
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export function createMemoryLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return Object.assign(createLogger((r) => records.push(r)), { records });
}

export const consoleLogger: Logger = createLogger((r) => {
  const line = `[${r.at}] ${r.level.toUpperCase()} ${r.message}${r.meta ? ` ${JSON.stringify(r.meta)}` : ''}`;
  if (r.level === 'error') console.error(line);
  else if (r.level === 'warn') console.warn(line);
  else console.log(line);
});
