/**
 * Writes public/static/presets-fallback.json from api/routePresets.js.
 * Run after changing presets: npm run presets:fallback
 */
const fs = require('fs');
const path = require('path');
const {
  listPresetsForApi,
  PRESET_GROUP_RF_POPULAR,
  listDnsPresetsForApi,
  DNS_DEFAULT_KEY,
} = require('../api/routePresets');

const out = {
  presets: listPresetsForApi(),
  groupRfPopular: PRESET_GROUP_RF_POPULAR,
  dnsPresets: listDnsPresetsForApi(),
  dnsDefault: DNS_DEFAULT_KEY,
};

const dest = path.join(__dirname, '..', 'public', 'static', 'presets-fallback.json');
fs.writeFileSync(dest, `${JSON.stringify(out)}\n`, 'utf8');
process.stdout.write(`Wrote ${dest}\n`);
