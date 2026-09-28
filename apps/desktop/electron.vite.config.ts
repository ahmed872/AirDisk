import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * Workspace packages (domain/contracts/backend) and pure-JS libraries are
 * bundled into the main process. Only native modules stay external and are
 * shipped in node_modules (unpacked from the asar archive).
 */
const NATIVE = ['better-sqlite3-multiple-ciphers', '@node-rs/argon2'];

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        external: ['electron', ...NATIVE, /^node:/],
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
