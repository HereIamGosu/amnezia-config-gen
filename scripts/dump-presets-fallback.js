/**
 * Writes public/static/presets-fallback.json from src/server/routePresets.js and the catalogue snapshot
 * (src/server/ipCatalog/snapshot.json): the catalogue the UI uses when /api/iplist cannot be reached — presets with
 * their price, precision, noData and source, the quick pick, categories, aliases, retired keys, DNS presets.
 * Deterministic in both files, so the CI drift check stays as it is.
 * Run after changing presets or rebuilding the snapshot: npm run presets:fallback
 */
const fs = require('fs');
const path = require('path');
const {
  listPresetsForApi,
  PRESET_QUICK_PICK,
  PRESET_CATEGORY_ORDER,
  PRESET_ALIASES,
  RETIRED_PRESETS,
  listDnsPresetsForApi,
  DNS_DEFAULT_KEY,
} = require('../src/server/routePresets');
const { getCatalog } = require('../src/server/ipCatalog');

const prices = getCatalog().prices();
if (!prices) {
  process.stderr.write('The catalogue snapshot cannot be read: run npm run ipcatalog:build first.\n');
  process.exit(1);
}

const out = {
  presets: listPresetsForApi(prices),
  groupRfPopular: PRESET_QUICK_PICK,
  categories: PRESET_CATEGORY_ORDER,
  aliases: PRESET_ALIASES,
  retired: RETIRED_PRESETS,
  catalogBuiltAt: prices.builtAt,
  dnsPresets: listDnsPresetsForApi(),
  dnsDefault: DNS_DEFAULT_KEY,
};

const dest = path.join(__dirname, '..', 'public', 'static', 'presets-fallback.json');
fs.writeFileSync(dest, `${JSON.stringify(out)}\n`, 'utf8');
process.stdout.write(`Wrote ${dest}\n`);
