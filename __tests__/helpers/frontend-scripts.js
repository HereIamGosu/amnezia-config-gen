// __tests__/helpers/frontend-scripts.js
// Скрипты генератора в public/static: классические defer-скрипты с общей глобальной областью,
// в порядке загрузки из public/index.html (script.js — точка входа, последним). Тесты исходников
// читают тот файл, где теперь живёт проверяемый код, а проверки «нигде во фронтенде» — все сразу.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATIC_DIR = path.resolve(__dirname, '..', '..', 'public', 'static');

const APP_SCRIPTS = Object.freeze([
  'i18n.js',
  'common.js',
  'status.js',
  'result.js',
  'settings.js',
  'settings-link.js',
  'history.js',
  'script.js',
]);

/** Исходник одного скрипта генератора. */
const readAppScript = (name) => {
  if (!APP_SCRIPTS.includes(name)) throw new Error(`${name} is not a generator script`);
  return fs.readFileSync(path.join(STATIC_DIR, name), 'utf8');
};

/** Все скрипты генератора одной строкой (для проверок «нигде во фронтенде»). */
const readAllAppScripts = () => APP_SCRIPTS.map(readAppScript).join('\n');

module.exports = { APP_SCRIPTS, STATIC_DIR, readAppScript, readAllAppScripts };
