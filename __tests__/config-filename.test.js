// __tests__/config-filename.test.js
// Downloaded config names are valid Windows tunnel names: Latin letters, digits and underscore only, no dots
// (except the extension), dashes, spaces or brackets, at most 32 characters, unique per generation.

'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { readAppScript } = require('./helpers/frontend-scripts');

const result = readAppScript('result.js');
const start = result.indexOf('const MODE_FILE_BASE');
const end = result.indexOf('const getModeLoadingLabel');
assert.ok(start > 0 && end > start, 'filename helpers found in result.js');

/** Runs the filename helpers of result.js as a classic browser script. */
const loadFilename = () => {
  const context = { crypto: globalThis.crypto, Uint8Array, Array, Math };
  return vm.runInNewContext(`${result.slice(start, end)}\n;getModeFilename`, context, { filename: 'result.js' });
};

const MODES = ['legacy', 'awg2', 'awg3', 'awg31'];

test('every profile gets a name made of letters, digits and underscores only', () => {
  const getModeFilename = loadFilename();
  for (const mode of MODES) {
    const name = getModeFilename(mode);
    assert.match(name, /^[A-Za-z0-9_]{1,28}\.conf$/, name);
    assert.ok(name.length <= 32);
    assert.equal(name.indexOf('.'), name.length - '.conf'.length, 'no dot except the extension');
  }
  assert.match(getModeFilename('unknown'), /^AWGWarpL_[a-z0-9]{4}\.conf$/);
  assert.match(getModeFilename('awg31'), /^AWGWarp31_[a-z0-9]{4}\.conf$/);
});

test('repeated generations get different names', () => {
  const getModeFilename = loadFilename();
  const names = new Set(Array.from({ length: 50 }, () => getModeFilename('awg31')));
  assert.ok(names.size > 45, `only ${names.size} distinct names out of 50`);
});

test('variants keep the generation id and stay valid names within 32 characters', () => {
  const getModeFilename = loadFilename();
  const base = getModeFilename('awg3');
  const variants = [0, 1, 2].map((idx) => base.replace(/\.conf$/, `_v${idx + 1}.conf`));
  assert.equal(new Set(variants).size, 3);
  for (const name of variants) {
    assert.match(name, /^AWGWarp30_[a-z0-9]{4}_v[1-3]\.conf$/);
    assert.ok(name.length <= 32);
  }
});

test('page examples and the generator carry no old dashed or dotted names', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  for (const file of ['public/index.html', 'public/en/index.html', 'public/lab/index.html', 'public/en/lab/index.html']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /AmneziaWarp/, file);
  }
  assert.doesNotMatch(result, /AmneziaWarp/);
  assert.doesNotMatch(readAppScript('script.js'), /_variant\$\{/);
});
