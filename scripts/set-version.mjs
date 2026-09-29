/**
 * Sets ONE version everywhere it is declared (app, workspace packages).
 * Usage: node scripts/set-version.mjs 1.0.0
 * Windows file/product versions and the installer name derive from apps/desktop/package.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(version ?? '')) {
  console.error('Usage: node scripts/set-version.mjs <major.minor.patch[-rc.N]>');
  process.exit(1);
}
const files = ['apps/desktop/package.json', 'packages/domain/package.json', 'packages/contracts/package.json', 'packages/backend/package.json'];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) throw new Error(`no version field in ${f}`);
  writeFileSync(f, next);
  console.log(`${f} → ${version}`);
}
console.log(`Next: update the version line in README.md and docs/product/*.md, commit, then tag v${version}.`);
