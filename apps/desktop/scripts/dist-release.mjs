/**
 * Release build: refuses to run unless signing credentials are present, then
 * builds the NSIS installer with electron-builder, which signs AirDesk.exe,
 * the uninstaller and the installer (SHA-256, RFC 3161 timestamp).
 * Run by .github/workflows/release.yml with AIRDESK_REQUIRE_SIGNING=1.
 */
import { buildWindowsInstaller } from './builder.mjs';
import { checkSigning, signingMode } from './signing.mjs';

const env = { ...process.env, AIRDESK_REQUIRE_SIGNING: '1' };
const check = checkSigning(env);
console.log(check.message);
if (!check.ok) process.exit(1);

const extra = [];
if (signingMode(env).mode === 'azure') {
  extra.push(
    `-c.win.azureSignOptions.endpoint=${env.AIRDESK_AZURE_SIGNING_ENDPOINT}`,
    `-c.win.azureSignOptions.codeSigningAccountName=${env.AIRDESK_AZURE_SIGNING_ACCOUNT}`,
    `-c.win.azureSignOptions.certificateProfileName=${env.AIRDESK_AZURE_CERT_PROFILE}`,
    `-c.win.azureSignOptions.publisherName=${env.AIRDESK_PUBLISHER_NAME ?? 'AirDesk'}`,
  );
}
buildWindowsInstaller(env, extra);
