/**
 * Release build: refuses to run unless signing credentials are present, then
 * builds the NSIS installer with electron-builder, which signs AirDesk.exe,
 * the uninstaller and the installer (SHA-256, RFC 3161 timestamp).
 * Run by .github/workflows/release.yml with AIRDESK_REQUIRE_SIGNING=1.
 */
import { spawnSync } from 'node:child_process';
import { checkSigning, signingMode } from './signing.mjs';

const env = { ...process.env, AIRDESK_REQUIRE_SIGNING: '1' };
const check = checkSigning(env);
console.log(check.message);
if (!check.ok) process.exit(1);

const args = ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never'];
if (signingMode(env).mode === 'azure') {
  args.push(
    `-c.win.azureSignOptions.endpoint=${env.AIRDESK_AZURE_SIGNING_ENDPOINT}`,
    `-c.win.azureSignOptions.codeSigningAccountName=${env.AIRDESK_AZURE_SIGNING_ACCOUNT}`,
    `-c.win.azureSignOptions.certificateProfileName=${env.AIRDESK_AZURE_CERT_PROFILE}`,
    `-c.win.azureSignOptions.publisherName=${env.AIRDESK_PUBLISHER_NAME ?? 'AirDesk'}`,
  );
}
const build = spawnSync('npx', ['electron-vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32', env });
if (build.status !== 0) process.exit(build.status ?? 1);
const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32', env });
process.exit(r.status ?? 1);
