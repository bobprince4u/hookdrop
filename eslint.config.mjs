import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier/flat'

/**
 * Lint configuration for the backend TypeScript.
 *
 * This replaces the root `.eslintrc.json`, which ESLint stopped reading in v9 — so from the
 * moment the toolchain moved to v10 the rules below were declared and never applied. The
 * symptom hid itself: `npm run lint` was `eslint apps/**\/*.ts`, ESLint 10 resolves a
 * configuration per file by walking up from it, and the only one anywhere in the tree was
 * `apps/web/eslint.config.mjs`. So every run was governed by the Next config, crashed inside
 * `eslint-plugin-react` on `apps/web/next.config.ts` — that plugin calls a context API v10
 * removed — and never reached a backend file at all. Scoped to the backend on its own, ESLint
 * reported "couldn't find eslint.config.(js|mjs|cjs)".
 *
 * The rules here are a straight port of `.eslintrc.json`; none is added, removed or
 * re-weighted. Two shapes changed because flat config has no `env` or `extends`:
 *
 *  - `env: { node, es2022 }` becomes `languageOptions.globals`. `globals` is not a dependency
 *    of this repository, so the handful of Node globals the backend actually uses are listed
 *    explicitly rather than pulling in a package to enumerate them.
 *  - `extends` becomes composition. `flat/eslint-recommended` is the half of
 *    `plugin:@typescript-eslint/recommended` that switches off core rules the compiler already
 *    covers; it has to come after `js.configs.recommended` to win.
 *
 * `apps/web` is not listed and must not be. It has its own flat config, its own `lint` script
 * and its own nested ESLint 9 — the Next plugins are not compatible with the v10 the root
 * installs — and linting a Next app under this config would apply Node globals and no React
 * rules to it.
 */

/** The Node globals the backend uses. `env: { node: true }`, minus what it never touches. */
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  fetch: 'readonly',
  structuredClone: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'writable',
  require: 'readonly',
  exports: 'writable',
  global: 'readonly',
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'apps/web/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs['flat/eslint-recommended'].rules,
      ...tseslint.configs['flat/recommended']
        .map((entry) => entry.rules ?? {})
        .reduce((all, rules) => ({ ...all, ...rules }), {}),

      // --- the repository's own overrides, unchanged from .eslintrc.json ---
      'no-unused-vars': 'off',
      /**
       * The one option added to a ported rule, and it encodes a convention the code already
       * follows rather than relaxing anything: five parameters across the backend are named
       * `_something` to say "required by the signature, deliberately unused".
       *
       * The case that forces it is `apps/api/src/index.ts`'s error handler. Express 5
       * identifies error middleware by *arity*, so a handler declared with three parameters is
       * registered as ordinary middleware — and the consequence of dropping `_next` to satisfy
       * a linter is that thrown errors fall through to Express's default handler, which returns
       * an HTML page carrying the stack trace. Reporting an argument that cannot be removed
       * would train the next person to ignore lint output.
       */
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  /**
   * Ambient declaration files declare types and nothing else, so `no-unused-vars` reads every
   * one of them as dead code. `apps/api/src/types/express/index.d.ts` is the only one, and it
   * is what gives `Request.validatedQuery` a type.
   */
  {
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
  /**
   * `node-pg-migrate` migrations are CommonJS `.js`, not TypeScript: they assign to
   * `exports.up` / `exports.down` and are loaded by the migrator, never bundled. Without a
   * block of their own they are linted as ES modules with no globals, and every one of them
   * reports `'exports' is not defined`.
   *
   * They were outside the previous script's `apps/**\/*.ts` glob entirely. Including them is
   * the point of running the linter from the root rather than per app.
   */
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
  },
  prettier,
]
