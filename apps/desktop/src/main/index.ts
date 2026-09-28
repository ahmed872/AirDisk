import { hostname } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron';
import { AppBackend, type Logger } from '@airdesk/backend';
import { createFileLogger } from './file-logger';
import { resolveDataDir } from './paths';
import { CONTENT_SECURITY_POLICY, IPC_CHANNEL, isAllowedExternalUrl, secureWebPreferences } from './security';
import { runSmokeTest } from './smoke-test';

let backend: AppBackend | null = null;
let logger: Logger | null = null;
/** Session binding lives in the main process: the renderer never holds a token it could leak or forge. */
const sessionByWebContents = new Map<number, string>();
const smokeArg = process.argv.find((a) => a.startsWith('--smoke-test='));

if (!smokeArg && !app.requestSingleInstanceLock()) {
  app.quit();
}

function rendererUrl(): string | null {
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null;
}

function isTrustedSender(url: string): boolean {
  const dev = rendererUrl();
  return dev ? url.startsWith(dev) : url.startsWith('file://');
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    title: 'AirDesk',
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.cjs'), !app.isPackaged),
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedSender(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const id = win.webContents.id;
  win.webContents.on('destroyed', () => {
    const sid = sessionByWebContents.get(id);
    sessionByWebContents.delete(id);
    if (sid && backend) backend.svc.sessions.end(sid, 'APP_EXIT');
  });
  const dev = rendererUrl();
  if (dev) void win.loadURL(dev);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNEL, async (event, command: unknown, payload: unknown) => {
    if (!backend || typeof command !== 'string' || !isTrustedSender(event.senderFrame?.url ?? '')) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'Rejected' } };
    }
    const wcId = event.sender.id;
    const res = await backend.dispatch({ command, payload, sessionId: sessionByWebContents.get(wcId) ?? null, workstation: hostname() });
    if (res.session) {
      if ('set' in res.session) sessionByWebContents.set(wcId, res.session.set);
      else sessionByWebContents.delete(wcId);
    }
    const { session: _effect, ...result } = res;
    return result;
  });
}

function hardenSessions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] } });
  });
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  backend?.close();
  backend = null;
});

void app.whenReady().then(async () => {
  if (smokeArg) {
    const code = await runSmokeTest(smokeArg.slice('--smoke-test='.length), app.getVersion());
    app.exit(code);
    return;
  }
  const dataDir = resolveDataDir(process.env, process.platform, app.isPackaged, app.getPath('userData'));
  logger = createFileLogger(dataDir);
  try {
    backend = await AppBackend.open({ dataDir, appVersion: app.getVersion(), logger });
  } catch (e) {
    logger.error('Backend failed to start', { error: (e as Error).message, stack: (e as Error).stack });
    dialog.showErrorBox('AirDesk', `AirDesk could not open its database.\n\n${(e as Error).message}\n\nLogs: ${join(dataDir, 'logs')}`);
    app.exit(1);
    return;
  }
  hardenSessions();
  registerIpc();
  createWindow();
});

process.on('uncaughtException', (e) => logger?.error('uncaughtException', { error: e.message, stack: e.stack }));
process.on('unhandledRejection', (e) => logger?.error('unhandledRejection', { error: String(e) }));
