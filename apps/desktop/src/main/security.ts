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
