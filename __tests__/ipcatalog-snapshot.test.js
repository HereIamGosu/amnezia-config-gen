// __tests__/ipcatalog-snapshot.test.js
// The committed catalogue snapshot passes the checks of spec 3.2.0 §4.4 — the module `npm run ipcatalog:check` runs —
// so CI checks the file through `npm test` without a change to ci.yml. And presets-fallback.json is the dump of
// routePresets.js and this snapshot (the CI drift check regenerates it).

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { checkSnapshot } = require('../src/server/ipCatalog/checkSnapshot');
const { SNAPSHOT_PATH, parseSnapshot } = require('../src/server/ipCatalog/snapshot');
const { ROUTE_PRESETS, RETIRED_PRESETS, PRESET_QUICK_PICK, PRESET_CATEGORY_ORDER } = require('../src/server/routePresets');

const text = fs.readFileSync(SNAPSHOT_PATH, 'utf8');

test('the committed snapshot passes ipcatalog:check (§4.4)', () => {
  assert.deepEqual(checkSnapshot(text, { presets: ROUTE_PRESETS, retired: RETIRED_PRESETS }), []);
});

test('no record is stale in the committed snapshot (a release build forbids it, §9 p. 4)', () => {
  const doc = JSON.parse(text);
  for (const [key, record] of Object.entries(doc.presets)) {
    assert.equal(record.stale, null, key);
    if (record.legacy) assert.equal(record.fallback.stale, null, `${key}.fallback`);
  }
});

test('every preset belongs to a category of the order, and the quick pick names catalogue presets', () => {
  for (const [key, def] of Object.entries(ROUTE_PRESETS)) assert.ok(PRESET_CATEGORY_ORDER.includes(def.category), key);
  for (const key of PRESET_QUICK_PICK) assert.ok(ROUTE_PRESETS[key], key);
  for (const key of RETIRED_PRESETS) assert.equal(ROUTE_PRESETS[key], undefined, key);
});

test('presets-fallback.json carries the catalogue with the snapshot prices', () => {
  const fallback = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'static', 'presets-fallback.json'), 'utf8'));
  const snapshot = parseSnapshot(text).snapshot;
  assert.equal(fallback.catalogBuiltAt, snapshot.builtAt);
  assert.deepEqual(fallback.categories, [...PRESET_CATEGORY_ORDER]);
  assert.deepEqual(fallback.retired, [...RETIRED_PRESETS]);
  assert.deepEqual(fallback.aliases, { rutracker_local: 'rutracker' });
  for (const p of fallback.presets) {
    const record = snapshot.presets[p.id];
    assert.equal(p.routes4, record.legacy ? record.liveRoutes4 : record.routes4, p.id);
    assert.equal(p.source, record.legacy ? 'live' : 'catalog', p.id);
  }
});
