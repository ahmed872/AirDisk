import { join } from 'node:path';

/**
 * Where the company database lives.
 *  - AIRDESK_DATA_DIR overrides everything (IT deployments, tests).
 *  - Packaged on Windows: %ProgramData%\AirDesk\data — shared by all Windows
 *    users of the PC and preserved on uninstall (see build/installer.nsh).
 *  - Development / other OS: <userData>/data.
 * On a multi-PC office only the PRIMARY machine holds the database; client
 * machines talk to it through the application API (docs/phase-1/deployment-architecture.md).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, isPackaged: boolean, userDataDir: string): string {
  if (env.AIRDESK_DATA_DIR) return env.AIRDESK_DATA_DIR;
  if (isPackaged && platform === 'win32') return join(env.PROGRAMDATA ?? 'C:\\ProgramData', 'AirDesk', 'data');
  return join(userDataDir, 'data');
}
