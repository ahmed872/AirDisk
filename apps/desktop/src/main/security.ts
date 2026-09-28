import type { WebPreferences } from 'electron';

/**
 * Renderer hardening (Phase 0 §06-10). Kept as plain data so a unit test can
 * assert every flag without launching Electron.
 */
export function secureWebPreferences(preloadPath: string, allowDevTools: boolean): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    spellcheck: false,
    devTools: allowDevTools,
  };
}

/** The only external URLs the app may open (in the OS browser/app, never in-app). */
const EXTERNAL_ALLOW = [/^https:\/\/wa\.me\//, /^mailto:/, /^tel:/];

export function isAllowedExternalUrl(url: string): boolean {
  return EXTERNAL_ALLOW.some((re) => re.test(url));
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const IPC_CHANNEL = 'airdesk:invoke';

export const EXPORT_CHANNEL = 'airdesk:export';
export const MAX_EXPORT_TEXT = 10 * 1024 * 1024;

/**
 * Suggested file name for a user-confirmed export: no path separators, no
 * reserved characters, bounded length, and the extension forced by the kind.
 * The user still chooses the final location in a native save dialog.
 */
export function sanitizeExportName(name: unknown, ext: 'pdf' | 'csv'): string {
  const base = typeof name === 'string' ? name : 'export';
  const clean = [...base].filter((ch) => ch.charCodeAt(0) >= 32).join('') // no control characters
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\.{2,}/g, '')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80) || 'export';
  return `${clean}.${ext}`;
}
