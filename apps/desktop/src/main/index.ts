import { hostname } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron';
import { AppLauncher, type AppBackend, type Logger } from '@airdesk/backend';
import { createDeviceKeyStore } from './device-keys';
import { createFileLogger } from './file-logger';
import { resolveDataDir } from './paths';
import { writeFileSync } from 'node:fs';
import { CONTENT_SECURITY_POLICY, EXPORT_CHANNEL, IPC_CHANNEL, PICK_BACKUP_CHANNEL, MAX_EXPORT_TEXT, isAllowedExternalUrl, sanitizeExportName, secureWebPreferences } from './security';
import { runSmokeTest, type SmokePhase } from './smoke-test';

let launcher: AppLauncher | null = null;
/** The open company backend (null while NEW/LOCKED). */
const current = (): AppBackend | null => launcher?.backend ?? null;
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
    const backend = current();
    if (sid && backend) backend.svc.sessions.end(sid, 'APP_EXIT');
  });
  const dev = rendererUrl();
  if (dev) void win.loadURL(dev);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNEL, async (event, command: unknown, payload: unknown) => {
    if (!launcher || typeof command !== 'string' || !isTrustedSender(event.senderFrame?.url ?? '')) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'Rejected' } };
    }
    const wcId = event.sender.id;
    const res = await launcher.dispatch({ command, payload, sessionId: sessionByWebContents.get(wcId) ?? null, workstation: hostname() });
    if (res.session) {
      if ('set' in res.session) sessionByWebContents.set(wcId, res.session.set);
      else sessionByWebContents.delete(wcId);
    }
    const { session: _effect, ...result } = res;
    return result;
  });
}

/**
 * User-confirmed exports (PDF of the current view, CSV of a report). The
 * renderer never touches the filesystem: it asks, the user picks the location
 * in a native dialog, and the export is audited. CSV additionally requires the
 * report.export permission.
 */
function registerExportIpc(): void {
  ipcMain.handle(EXPORT_CHANNEL, async (event, kind: unknown, name: unknown, content: unknown) => {
    const backend = current();
    if (!backend || !isTrustedSender(event.senderFrame?.url ?? '')) return { ok: false, code: 'FORBIDDEN' };
    const sid = sessionByWebContents.get(event.sender.id);
    let actor;
    try {
      actor = sid ? backend.svc.sessions.resolve(sid) : null;
    } catch {
      actor = null;
    }
    if (!actor) return { ok: false, code: 'UNAUTHENTICATED' };
    if (kind !== 'pdf' && kind !== 'csv') return { ok: false, code: 'VALIDATION' };
    if (kind === 'csv' && (typeof content !== 'string' || content.length > MAX_EXPORT_TEXT)) return { ok: false, code: 'VALIDATION' };
    if (kind === 'csv' && !actor.permissions.has('report.export')) return { ok: false, code: 'FORBIDDEN' };
    const win = BrowserWindow.fromWebContents(event.sender);
    const fileName = sanitizeExportName(name, kind);
    const choice = await dialog.showSaveDialog(win!, { defaultPath: fileName, filters: [kind === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'CSV', extensions: ['csv'] }] });
    if (choice.canceled || !choice.filePath) return { ok: false, code: 'CANCELLED' };
    const target = choice.filePath.toLowerCase().endsWith(`.${kind}`) ? choice.filePath : `${choice.filePath}.${kind}`;
    const data = kind === 'pdf'
      ? await event.sender.printToPDF({ printBackground: true, pageSize: 'A4' })
      : Buffer.from(`\uFEFF${content as string}`, 'utf8'); // BOM so Excel reads Arabic correctly
    writeFileSync(target, data);
    backend.svc.deps.audit.append({ userId: actor.userId, sessionId: actor.sessionId, workstation: hostname() }, {
      action: kind === 'pdf' ? 'export.pdf' : 'export.csv', entityType: 'export', metadata: { fileName: fileName, bytes: data.length },
    });
    return { ok: true };
  });
}

function registerPickBackupIpc(): void {
  ipcMain.handle(PICK_BACKUP_CHANNEL, async (event) => {
    if (!launcher || !isTrustedSender(event.senderFrame?.url ?? '')) return null;
    const backend = current();
    const sid = sessionByWebContents.get(event.sender.id);
    // Before the data is open (new PC, locked, damaged) choosing a backup is how recovery starts.
    let allowed = !backend;
    try {
      allowed ||= !!sid && !!backend && backend.svc.sessions.resolve(sid).permissions.has('backup.restore');
    } catch {
      allowed = false;
    }
    if (!allowed) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    const choice = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'AirDesk backup', extensions: ['adbk'] }], ...(backend ? { defaultPath: backend.backupDir } : {}) });
    return choice.canceled ? null : choice.filePaths[0] ?? null;
  });
}

/**
 * Automatic backups (owner decision Q12): checked at start-up (before anyone
 * is working) and then every 10 minutes, running only after 5 minutes without
 * user activity so a backup never interrupts work.
 */
function scheduleAutomaticBackups(): void {
  const run = (idleMinutes?: number) => {
    current()?.runScheduledBackup(idleMinutes === undefined ? {} : { idleMinutes }).then(
      (r) => { if (r.ran) logger?.info('Automatic backup created', { filePath: r.filePath, pruned: r.pruned.length }); },
      (e: Error) => logger?.error('Automatic backup failed', { error: e.message }),
    );
  };
  setTimeout(() => run(), 5_000).unref();
  setInterval(() => run(5), 600_000).unref();
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
  launcher?.close();
  launcher = null;
});

void app.whenReady().then(async () => {
  if (smokeArg) {
    const arg = (name: string) => process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
    const phase = arg('smoke-phase') as SmokePhase | undefined;
    const dir = arg('smoke-data-dir');
    const backupFile = arg('smoke-backup');
    const backupOut = arg('smoke-backup-out');
    const code = await runSmokeTest(smokeArg.slice('--smoke-test='.length), app.getVersion(), {
      ...(phase ? { phase } : {}), ...(dir ? { dataDir: dir } : {}), ...(backupFile ? { backupFile } : {}), ...(backupOut ? { backupOut } : {}),
      deviceKeys: createDeviceKeyStore(process.env.AIRDESK_DEVICE_KEY_DIR ?? join(app.getPath('userData'), 'device-keys')),
      workerPath: join(__dirname, 'backup-worker.js'),
    });
    app.exit(code);
    return;
  }
  const dataDir = resolveDataDir(process.env, process.platform, app.isPackaged, app.getPath('userData'));
  logger = createFileLogger(dataDir);
  try {
    launcher = await AppLauncher.start({
      dataDir, appVersion: app.getVersion(), logger,
      deviceKeys: createDeviceKeyStore(process.env.AIRDESK_DEVICE_KEY_DIR ?? join(app.getPath('userData'), 'device-keys')),
      workerPath: join(__dirname, 'backup-worker.js'),
    });
  } catch (e) {
    logger.error('Backend failed to start', { error: (e as Error).message, stack: (e as Error).stack });
    dialog.showErrorBox('AirDesk', `AirDesk could not open its database.\n\n${(e as Error).message}\n\nLogs: ${join(dataDir, 'logs')}`);
    app.exit(1);
    return;
  }
  hardenSessions();
  registerIpc();
  registerExportIpc();
  registerPickBackupIpc();
  createWindow();
  scheduleAutomaticBackups();
});

process.on('uncaughtException', (e) => logger?.error('uncaughtException', { error: e.message, stack: e.stack }));
process.on('unhandledRejection', (e) => logger?.error('unhandledRejection', { error: String(e) }));
