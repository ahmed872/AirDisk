/**
 * Development / CI installer. Unless signing credentials are present it is
 * UNSIGNED and its file name says so (AirDesk-Setup-<version>-UNSIGNED-x64.exe),
 * so it can never be mistaken for a release artifact.
 */
import { buildWindowsInstaller } from './builder.mjs';
import { checkSigning } from './signing.mjs';

const check = checkSigning(process.env);
console.log(check.message);
if (!check.ok) process.exit(1);
buildWindowsInstaller(process.env, check.mode === 'unsigned' ? ['-c.win.artifactName=AirDesk-Setup-${version}-UNSIGNED-x64.${ext}'] : []);
