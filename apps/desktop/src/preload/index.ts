import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's entire view of the system: one function. No Node, no
 * filesystem, no session token. The main process validates, authenticates and
 * authorizes every call.
 */
contextBridge.exposeInMainWorld('airdesk', {
  invoke: (command: string, payload?: unknown) => ipcRenderer.invoke('airdesk:invoke', command, payload ?? {}),
});
