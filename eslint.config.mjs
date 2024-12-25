import globals from "globals";
import pluginJs from "@eslint/js";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    languageOptions: {
      globals: {
        ...globals.browser, // Глобальные переменные для браузерной среды
        ...globals.node,    // Глобальные переменные для Node.js
      },
    },
  },
  pluginJs.configs.recommended, // Рекомендуемая конфигурация для JS
];
