// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'fixtures/**',
      '**/coverage/**',
      '.claude/**',
      'packages/ui/public/**',
      'packages/server/ui/**', // console bundle copied in by `prepack`
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
      // Idiomatic React handlers: onClick={() => setOpen(true)}
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // Promo site: plain browser scripts (no bundler, no TypeScript), plus two local dev tools.
    // no-undef is off as typescript-eslint recommends: browser globals are not Node globals.
    files: ['packages/site/**/*.js', 'packages/site/**/*.mjs'],
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['packages/site/serve.mjs', 'packages/site/demo-video/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
);
