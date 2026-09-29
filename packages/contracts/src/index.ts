export * from './schemas';
export * from './dto';
export { ErrorCode, PERMISSIONS, type PermissionDefinition } from '@airdesk/domain';

/** The single function the renderer can call (exposed by the preload script). */
export interface AirDeskBridge {
  invoke<T = unknown>(command: import('./schemas').CommandName, payload?: unknown): Promise<import('./dto').CommandResult<T>>;
  exportPdf(fileName: string): Promise<{ ok: boolean; code?: string }>;
  exportCsv(fileName: string, content: string): Promise<{ ok: boolean; code?: string }>;
  pickBackupFile(): Promise<string | null>;
}
