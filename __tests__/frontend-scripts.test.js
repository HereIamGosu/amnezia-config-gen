// __tests__/frontend-scripts.test.js
// Скрипты генератора (i18n.js … script.js) — классические defer-скрипты с общей глобальной
// лексической областью, без сборщика. Здесь проверяется то, что в браузере сломалось бы молча
// или только при загрузке: порядок подключения, повторные объявления (SyntaxError всего файла),
// обращения к ещё не загруженному при исполнении (TDZ) и честность списков /* global */ и
// /* exported */, по которым ESLint проверяет связи между файлами.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const { APP_SCRIPTS, readAppScript } = require('./helpers/frontend-scripts');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { version } = JSON.parse(read('package.json'));

const sources = Object.fromEntries(APP_SCRIPTS.map((name) => [name, readAppScript(name)]));

/** Верхнеуровневые объявления (с нулевого отступа) читаемого исходника. */
const topLevelNames = (source) => [...source.matchAll(
  /^(?:const|let|var|class|(?:async\s+)?function\s*\*?)\s+([A-Za-z_$][\w$]*)/gm,
)].map((m) => m[1]);

/** Имена из директив вида / * global a, b:writable -- file.js * / или / * exported a, b * /. */
const directiveNames = (source, kind) => {
  const out = [];
  for (const m of source.matchAll(new RegExp(`/\\*\\s*${kind}\\s+([\\s\\S]*?)\\*/`, 'g'))) {
    const [list, provider] = m[1].split(/\s--\s*/);
    for (const raw of list.split(',')) {
      const name = raw.trim().split(':')[0];
      if (name) out.push({ name, provider: provider ? provider.trim() : null });
    }
  }
  return out;
};

test('both pages load the generator scripts in order, after their dependencies, with the release key', () => {
  for (const file of ['public/index.html', 'public/en/index.html']) {
    const html = read(file);
    const names = [...html.matchAll(/<script defer src="\/?static\/([\w.-]+)\?v=([^"]+)"><\/script>/g)].map((m) => m[1]);
    const app = names.filter((name) => APP_SCRIPTS.includes(name));
    assert.deepEqual(app, [...APP_SCRIPTS], `${file}: generator scripts in load order, each once`);
    const first = names.indexOf(APP_SCRIPTS[0]);
    assert.deepEqual(names.slice(first), [...APP_SCRIPTS], `${file}: generator scripts are last and contiguous`);
    // Читаются при исполнении файлов генератора: window.ProductTelemetry, ResultExplanation, LiveStatus, ShareLink, UiShell.
    for (const dep of ['analytics.js', 'result-explanation.js', 'live-status.js', 'share-link.js', 'ui-shell.js']) {
      assert.ok(names.indexOf(dep) >= 0 && names.indexOf(dep) < first, `${file}: ${dep} loads before the generator`);
    }
    for (const name of APP_SCRIPTS) {
      assert.ok(html.includes(`static/${name}?v=${version}"`), `${file}: ${name} carries ?v=${version}`);
    }
  }
});

test('every generator script names itself and its role in a header comment', () => {
  for (const name of APP_SCRIPTS) {
    const lines = sources[name].split('\n');
    assert.equal(lines[0], `// public/static/${name}`, `${name}: first line names the file`);
    assert.match(lines.slice(1, 6).join('\n'), /^\/\/ \S/m, `${name}: describes what it owns`);
  }
});

test('no top-level name is declared in two generator scripts', () => {
  const owner = new Map();
  for (const name of APP_SCRIPTS) {
    for (const id of topLevelNames(sources[name])) {
      assert.ok(!owner.has(id), `"${id}" is declared in ${owner.get(id)} and ${name}: the second script would not run`);
      owner.set(id, name);
    }
  }
});

test('/* global */ and /* exported */ lists match the real declarations', () => {
  const declared = Object.fromEntries(APP_SCRIPTS.map((name) => [name, new Set(topLevelNames(sources[name]))]));
  const exported = Object.fromEntries(APP_SCRIPTS.map((name) => [name, new Set(directiveNames(sources[name], 'exported').map((d) => d.name))]));
  for (const name of APP_SCRIPTS) {
    for (const id of exported[name]) assert.ok(declared[name].has(id), `${name} exports "${id}" but does not declare it`);
    const globals = directiveNames(sources[name], 'global');
    for (const { name: id, provider } of globals) {
      assert.ok(APP_SCRIPTS.includes(provider), `${name}: global "${id}" names a generator script as provider (got ${provider})`);
      assert.notEqual(provider, name, `${name}: "${id}" is its own declaration, not a global`);
      assert.ok(declared[provider].has(id), `${name}: "${id}" is not declared in ${provider}`);
      assert.ok(exported[provider].has(id), `${name}: ${provider} must list "${id}" in /* exported */`);
    }
  }
});

test('the scripts evaluate in page order without touching anything not yet loaded', () => {
  // Классические скрипты в одном vm-контексте делят глобальную лексическую область, как в браузере:
  // повторное объявление — SyntaxError, обращение к ещё не исполненному const — ReferenceError.
  const listeners = [];
  const sandbox = {
    document: {
      documentElement: { lang: 'ru' },
      addEventListener: (type) => listeners.push(type),
    },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of APP_SCRIPTS) {
    assert.doesNotThrow(() => new vm.Script(sources[name], { filename: name }).runInContext(context), name);
  }
  assert.deepEqual(listeners, ['DOMContentLoaded'], 'only script.js wires the page, after every script has run');
  for (const fn of ['t', 'openModal', 'initHeroStatus', 'renderResultSuccess', 'initSettingsPanel', 'applySharedSettings',
    'renderHistoryPanel', 'generateConfig']) {
    assert.equal(vm.runInContext(`typeof ${fn}`, context), 'function', fn);
  }
  assert.equal(vm.runInContext('cfgState.routeMode', context), 'full', 'cfgState starts in full tunnel');
});
