import globals from 'globals';
import pluginJs from '@eslint/js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module',
      },
    },
  },
  pluginJs.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error'],
      'no-console': ['warn'],
      'semi': ['error', 'always'],
      'quotes': ['error', 'single'],
      'prefer-const': ['error'],
      'no-var': ['error'],
      'arrow-body-style': ['error', 'as-needed'],
    },
  },
  {
    files: ['api/**/*.js'],
    rules: {
      'no-console': 'off', // Разрешаем console в серверных файлах
    },
  },
];
