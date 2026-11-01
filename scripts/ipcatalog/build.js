#!/usr/bin/env node
// scripts/ipcatalog/build.js — `npm run ipcatalog:build [-- --report <summary.md>] [--measure <route-measure.json>]
//   [--now <ISO time>] [--out <snapshot.json>] [--allow-stale]`
// Builds src/server/ipCatalog/snapshot.json from the recipes of src/server/routePresets.js (spec 3.2.0 §4.2) on the
// maintainer's machine; never in the request path, never in CI. The previous snapshot (the --out file) gives the
// resolved addresses of the last 30 days and the reserve of a failing source. Exit code 1 when a source failed or a
// record is stale, unless --allow-stale: a release build allows neither (spec §9 p. 4). With --report it also
// fetches the comparison sources (opencck API, itdoginfo, antonme/ipnames) and writes the summary there.

'use strict';

const fs = require('fs');
const path = require('path');
const { buildCatalog } = require('./catalog');
const { renderReport } = require('./report');
const { createGet } = require('./lib/net');
const { reconcilePreset } = require('./sources/reconcile');
const { ECS_POINTS } = require('./sources/doh');
const { aggregateCidrs } = require('../../src/server/cidrAggregate');
const { WARP_ENDPOINT_PREFIXES_V4 } = require('../../src/server/warpEndpointPrefixes');
const { SNAPSHOT_PATH } = require('../../src/server/ipCatalog/snapshot');

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

const parseArgs = (argv) => {
  const args = { out: SNAPSHOT_PATH, allowStale: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-stale') args.allowStale = true;
    else if (['--report', '--measure', '--now', '--out'].includes(a) && argv[i + 1]) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
};

/** 1 when a source failed or a record is stale and the build does not accept that (spec §9 p. 4), else 0. */
const exitCodeFor = (summary, { allowStale = false } = {}) => ((summary.failed.length || summary.stale.length) && !allowStale ? 1 : 0);

/** What a transitional preset costs today on the live path (opencck + itdoginfo, no antifilter), after the cut. */
const liveRoutes4 = async (key, def) => {
  const { fetchLegacyCidrs } = require('../../src/server/ipListFetch');
  const { cidrs4 } = await fetchLegacyCidrs(def, { includeIpv6: false });
  return cidrs4.length ? aggregateCidrs(cidrs4, { exclude: WARP_ENDPOINT_PREFIXES_V4 }).after4 : null;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const routePresets = require('../../src/server/routePresets');
  const presets = routePresets.ROUTE_PRESETS;
  const retired = routePresets.RETIRED_PRESETS || [];
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`bad --now ${args.now}`);
  const previous = fs.existsSync(args.out) ? JSON.parse(fs.readFileSync(args.out, 'utf8')) : null;
  const get = createGet({ onRetry: (url, n, e) => err(`retry ${n} ${url}: ${e.message}`) });

  const { text, summary } = await buildCatalog({ presets, retired, previous, now, get, liveRoutes4, log: err });
  fs.writeFileSync(args.out, text);
  out(`snapshot: ${path.relative(process.cwd(), args.out)} (${Buffer.byteLength(text)} bytes, ${Object.keys(summary.presets).length} presets)`);

  if (args.report) {
    const reconcile = {};
    for (const [key, def] of Object.entries(presets)) {
      if (retired.includes(key)) continue;
      const portals = (def.ip || []).filter((s) => s.from === 'portal').flatMap((s) => s.portals);
      reconcile[key] = await reconcilePreset(get, key, Array.from(new Set([...(def.domains || []), ...portals])));
    }
    const measure = args.measure ? JSON.parse(fs.readFileSync(args.measure, 'utf8')) : null;
    fs.writeFileSync(args.report, renderReport({
      summary, reconcile, measure, quickPick: routePresets.PRESET_QUICK_PICK || [], ecs: ECS_POINTS,
    }));
    out(`summary: ${args.report}`);
  }

  if (summary.failed.length || summary.stale.length) {
    err(`failed: ${summary.failed.map((f) => f.key).join(', ') || '—'}; stale: ${summary.stale.join(', ') || '—'}`);
  }
  process.exitCode = exitCodeFor(summary, args);
  if (process.exitCode) err('A release build allows neither (spec 3.2.0 §9 p. 4); --allow-stale accepts them for a test build.');
};

if (require.main === module) {
  main().catch((e) => {
    err(e.stack || e.message);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, exitCodeFor, liveRoutes4 };
