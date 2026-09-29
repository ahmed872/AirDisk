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
    // These files compose SQL from fixed, internal fragments only (table/column
    // literals, whitelisted sort columns, generated `?` placeholder lists, WHERE
    // clauses built from constant strings) — never from user input. Every value
    // is still a bound parameter; user search text only reaches FTS via `MATCH ?`.
    files: [
      '**/test/**/*.ts',
      'packages/backend/src/services/posting-service.ts',
      'packages/backend/src/services/ledger-query-service.ts',
      'packages/backend/src/services/customer-service.ts',
      'packages/backend/src/services/supplier-service.ts',
      'packages/backend/src/services/airline-service.ts',
      'packages/backend/src/app/dispatcher.ts',
      'packages/backend/src/app/backend.ts',
      'packages/backend/src/services/booking-service.ts',
      'packages/backend/src/services/finance-service.ts',
      'packages/backend/src/services/reference-service.ts',
      'packages/backend/src/services/report-service.ts',
      'packages/backend/src/services/operations-service.ts',
      'packages/backend/src/services/document-reader.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // E2E script: runs in Node, and its page.evaluate() callbacks run in the renderer.
    files: ['apps/desktop/e2e/**/*.mjs', 'apps/desktop/scripts/**/*.mjs'],
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
