/** Runs electron-vite build + electron-builder without a shell (arguments are passed verbatim on every OS). */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** Finds a package's bin script through the normal node_modules lookup (works with hoisted and nested installs). */
function binPath(pkg, file) {
  for (const dir of require.resolve.paths(pkg) ?? []) {
    const p = join(dir, pkg, file);
    if (existsSync(p)) return p;
  }
  throw new Error(`${pkg}/${file} not found`);
}

export function run(pkg, file, args, env) {
  const r = spawnSync(process.execPath, [binPath(pkg, file), ...args], { stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

export function buildWindowsInstaller(env, extraArgs = []) {
  run('electron-vite', 'bin/electron-vite.js', ['build'], env);
  run('electron-builder', 'cli.js', ['--win', 'nsis', '--x64', '--publish', 'never', ...extraArgs], env);
}
