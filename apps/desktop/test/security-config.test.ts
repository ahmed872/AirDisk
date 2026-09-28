import { describe, expect, it } from 'vitest';
import { resolveDataDir } from '../src/main/paths';
import { CONTENT_SECURITY_POLICY, isAllowedExternalUrl, secureWebPreferences } from '../src/main/security';

describe('Electron hardening (Phase 0 §06-10)', () => {
  it('renderer has no Node access and runs sandboxed with context isolation', () => {
    const p = secureWebPreferences('/x/preload.cjs', false);
    expect(p).toMatchObject({
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false,
    });
  });

  it('only allow-listed external links can be opened', () => {
    expect(isAllowedExternalUrl('https://wa.me/201001234567?text=hi')).toBe(true);
    expect(isAllowedExternalUrl('mailto:a@b.c')).toBe(true);
    expect(isAllowedExternalUrl('tel:+201001234567')).toBe(true);
    for (const bad of ['https://evil.example', 'http://wa.me/x', 'file:///C:/Windows', 'javascript:alert(1)', 'https://wa.me.evil.com/']) {
      expect(isAllowedExternalUrl(bad)).toBe(false);
    }
  });

  it('CSP forbids remote scripts, eval and plugins', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });
});

describe('data directory', () => {
  it('uses ProgramData on packaged Windows, env override when set', () => {
    expect(resolveDataDir({ PROGRAMDATA: 'C:\\ProgramData' }, 'win32', true, '/u')).toMatch(/ProgramData.AirDesk.data$/);
    expect(resolveDataDir({ AIRDESK_DATA_DIR: 'D:\\AirDeskData' }, 'win32', true, '/u')).toBe('D:\\AirDeskData');
    expect(resolveDataDir({}, 'linux', false, '/home/x/.config/AirDesk')).toBe('/home/x/.config/AirDesk/data');
  });
});
