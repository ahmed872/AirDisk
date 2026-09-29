import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's entire view of the system: one function. No Node, no
 * filesystem, no session token. The main process validates, authenticates and
 * authorizes every call.
 */
contextBridge.exposeInMainWorld('airdesk', {
  invoke: (command: string, payload?: unknown) => ipcRenderer.invoke('airdesk:invoke', command, payload ?? {}),
  /** Saves the current view as PDF after the user picks a location (main process validates and audits). */
  exportPdf: (fileName: string) => ipcRenderer.invoke('airdesk:export', 'pdf', fileName),
  /** Saves CSV text after the user picks a location (requires report.export; audited). */
  exportCsv: (fileName: string, content: string) => ipcRenderer.invoke('airdesk:export', 'csv', fileName, content),
  /** Opens a file dialog for a .adbk backup (Admin restore only); returns the chosen path or null. */
  pickBackupFile: () => ipcRenderer.invoke('airdesk:pick-backup'),
});
