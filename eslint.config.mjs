import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', 'docs/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': [
        'error',
        {
          // SQL must use bound parameters; never build a statement from user text with a template literal.
          selector: "CallExpression[callee.property.name='prepare'] > TemplateLiteral[expressions.length>0]",
          message: 'Do not interpolate values into SQL. Use ? / @named parameters.',
        },
      ],
    },
  },
  {
    // These files compose SQL from fixed, internal fragments only (table names,
    // account-class filters) — never from user input. Values are still bound.
    files: ['**/test/**/*.ts', 'packages/backend/src/services/posting-service.ts', 'packages/backend/src/services/ledger-query-service.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // E2E script: runs in Node, and its page.evaluate() callbacks run in the renderer.
    files: ['apps/desktop/e2e/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', document: 'readonly', window: 'readonly' } },
  },
  {
    // The domain package is pure: no Node, DB or Electron imports.
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', 'fs', 'path', 'electron', 'better-sqlite3*', '@airdesk/backend', '@airdesk/contracts'] }],
    },
  },
  {
    // The renderer never reaches the backend, domain internals or Node directly.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', 'fs', 'electron', '@airdesk/backend', '@airdesk/domain'] }],
    },
  },
);
