#!/usr/bin/env node
// scripts/ipcatalog/check.js — `npm run ipcatalog:check`: the checks of spec 3.2.0 §4.4 on the committed snapshot,
// without network. The same module runs in __tests__/ipcatalog-snapshot.test.js, so CI checks it through `npm test`.

'use strict';

const fs = require('fs');
const { checkSnapshot } = require('../../src/server/ipCatalog/checkSnapshot');
const { SNAPSHOT_PATH } = require('../../src/server/ipCatalog/snapshot');

const main = () => {
  const { ROUTE_PRESETS, RETIRED_PRESETS = [] } = require('../../src/server/routePresets');
  let text;
  try {
    text = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  } catch (err) {
    process.stderr.write(`ipcatalog:check: cannot read ${SNAPSHOT_PATH}: ${err.code || err.message}\n`);
    return 1;
  }
  const problems = checkSnapshot(text, { presets: ROUTE_PRESETS, retired: RETIRED_PRESETS });
  for (const p of problems) process.stderr.write(`ipcatalog:check: ${p}\n`);
  process.stdout.write(problems.length ? `ipcatalog:check: FAIL (${problems.length})\n` : 'ipcatalog:check: PASS\n');
  return problems.length ? 1 : 0;
};

if (require.main === module) process.exitCode = main();

module.exports = { main };
