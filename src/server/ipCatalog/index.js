// src/server/ipCatalog/index.js
// The preset catalogue the handlers use (3.2.0): the resolver over src/server/routePresets.js and the committed
// snapshot, created on first use. The live part of transitional presets goes through src/server/ipListFetch.js,
// required at call time so a test that reloads that module (its cache) is followed.

'use strict';

const routePresets = require('../routePresets');
const { createSnapshotLoader, SNAPSHOT_PATH } = require('./snapshot');
const { createResolver } = require('./resolvePresets');

let catalog = null;
let snapshotOptions = { path: SNAPSHOT_PATH };

const getCatalog = () => {
  if (!catalog) {
    catalog = createResolver({
      presets: routePresets.ROUTE_PRESETS,
      aliases: routePresets.PRESET_ALIASES,
      retired: routePresets.RETIRED_PRESETS,
      loadSnapshot: createSnapshotLoader(snapshotOptions),
      fetchLegacy: (key, def, opts) => require('../ipListFetch').fetchLegacyCidrs(def, opts),
    });
  }
  return catalog;
};

/** Tests: read the snapshot from another file (or with another reader); no argument restores the committed one. */
const resetCatalog = (options = {}) => {
  snapshotOptions = { path: SNAPSHOT_PATH, ...options };
  catalog = null;
};

module.exports = { getCatalog, resetCatalog };
