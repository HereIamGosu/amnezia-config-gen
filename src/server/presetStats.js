// src/server/presetStats.js
// Demand counters of route presets (3.2.0, K8, spec 3.2.0 §5.6), instead of preset identifiers in an analytics
// service: every 10 minutes with at least one split generation in the window, and at shutdown (server.js), one line
// `[preset-stats] window=600s youtube=12 telegram=9 …` — successful split generations per canonical preset key,
// non-zero only, in catalogue order. No IP, no identifier, no time of a single request; an empty window writes nothing.

'use strict';

const { ROUTE_PRESETS } = require('./routePresets');

const STATS_WINDOW_MS = 10 * 60 * 1000;
let counts = new Map();
let timer = null;

/** Logs the window's line and starts a new window; nothing when the window had no split generation. */
const flushPresetStats = (log = console.log) => {
  const keys = Object.keys(ROUTE_PRESETS).filter((key) => counts.get(key) > 0);
  if (!keys.length) return null;
  const line = `[preset-stats] window=600s ${keys.map((key) => `${key}=${counts.get(key)}`).join(' ')}`;
  counts = new Map();
  log(line);
  return line;
};

/** One successful split generation with these canonical keys; anything that is not a catalogue key is not counted. */
const recordPresetUse = (keys) => {
  for (const key of new Set(keys)) {
    if (Object.prototype.hasOwnProperty.call(ROUTE_PRESETS, key)) counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!timer) {
    // unref: the window timer never keeps a process (a test, a CLI) alive.
    timer = setInterval(() => flushPresetStats(), STATS_WINDOW_MS);
    timer.unref();
  }
};

module.exports = {
  flushPresetStats,
  recordPresetUse,
  STATS_WINDOW_MS,
  __stats: {
    timer: () => timer,
    reset: () => {
      clearInterval(timer);
      timer = null;
      counts = new Map();
    },
  },
};
