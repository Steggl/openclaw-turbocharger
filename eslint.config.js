// ESLint 9+ flat config.
// Keep this minimal and explicit — we only add rules when we have a concrete reason
// (see brief §8: "Minimal magic. Explicit configuration over convention where it
// affects behavior.").

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Encourage explicit unused-param naming (prefix with _) over silent ignores.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Prettier comes last — disables any style rules that would conflict with formatter.
  prettier,
];
