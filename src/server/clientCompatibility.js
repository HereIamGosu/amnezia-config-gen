// src/server/clientCompatibility.js
// Client compatibility matrix — Release 2.7.0 (Compatibility & Onboarding Clarity).
//
// Purpose: given what a single /api/warp generation actually produced (mode,
// whether a vpn:// link exists, mobile/router flags), report which clients are
// a reasonable target, which are only experimental, and which are not directly
// supported. This is honest guidance, not a promise: the goal is to stop users
// expecting a format/client to work when it does not.
//
// Classification is intentionally conservative. Unconfirmed clients are marked
// experimental or notRecommended, never recommended.
//
// Security: this module works only from static metadata plus a handful of
// boolean/enum flags. It never receives or emits secrets, .conf text, or the
// vpn:// payload. `warnings` are fixed English strings; the UI localizes them.

'use strict';

const {
  isStableExportTarget,
  getExportTarget,
} = require('./exportTargets');

const STATUS = Object.freeze({
  RECOMMENDED: 'recommended',
  EXPERIMENTAL: 'experimental',
  NOT_RECOMMENDED: 'notRecommended',
});

// Canonical warning strings (English). The UI maps these to localized copy.
const WARNINGS = Object.freeze({
  CLOUDFLARE_PEER:
    'AWG 2.0 fields are client-side configuration parameters. Cloudflare WARP peer remains a standard WireGuard peer.',
  CLIENT_VERSION:
    'Compatibility depends on the client and its version. If import succeeds but the tunnel does not work, try another client or profile mode.',
  UNSUPPORTED_EXPORTER:
    'This format does not have a stable exporter yet. It is shown as experimental or research-only.',
});

const REASONS = Object.freeze({
  NO_EXPORTER: 'Direct export is not implemented yet.',
  RESEARCH_ONLY: 'Research/documentation target only.',
  NO_PATH: 'No supported import path for this profile format.',
});

/**
 * Client registry. `status` is the conservative default classification; the
 * effective bucket for a request is further constrained by whether the client
 * can consume an export the generation actually produced and whether it
 * supports the generated mode.
 */
const CLIENTS = Object.freeze([
  {
    clientId: 'amnezia_vpn',
    name: 'AmneziaVPN',
    platforms: ['windows', 'macos', 'linux', 'android', 'ios'],
    supportedExports: ['conf', 'vpnlink', 'qr'],
    recommendedModes: ['legacy', 'awg2'],
    status: STATUS.RECOMMENDED,
    warnings: [],
    notes: ['Use vpn:// where supported for faster import.'],
  },
  {
    clientId: 'amneziawg_client',
    name: 'AmneziaWG',
    platforms: ['windows', 'linux', 'android'],
    supportedExports: ['conf'],
    recommendedModes: ['legacy', 'awg2'],
    status: STATUS.RECOMMENDED,
    warnings: [],
    notes: [],
  },
  {
    clientId: 'wg_tunnel',
    name: 'wg-tunnel',
    platforms: ['android', 'ios'],
    supportedExports: ['conf'],
    recommendedModes: ['legacy'],
    status: STATUS.EXPERIMENTAL,
    warnings: [WARNINGS.CLIENT_VERSION],
    notes: [],
  },
  {
    clientId: 'sing_box',
    name: 'sing-box',
    platforms: ['windows', 'macos', 'linux', 'android', 'ios'],
    supportedExports: [],
    recommendedModes: [],
    status: STATUS.NOT_RECOMMENDED,
    reason: REASONS.NO_EXPORTER,
    warnings: [],
    notes: [],
  },
  {
    clientId: 'mihomo',
    name: 'Mihomo',
    platforms: ['windows', 'macos', 'linux'],
    supportedExports: [],
    recommendedModes: [],
    status: STATUS.NOT_RECOMMENDED,
    reason: REASONS.NO_EXPORTER,
    warnings: [],
    notes: [],
  },
  {
    clientId: 'clash',
    name: 'Clash',
    platforms: ['windows', 'macos', 'linux'],
    supportedExports: [],
    recommendedModes: [],
    status: STATUS.NOT_RECOMMENDED,
    reason: REASONS.NO_EXPORTER,
    warnings: [],
    notes: [],
  },
  {
    clientId: 'openclash',
    name: 'OpenClash',
    platforms: ['linux'],
    supportedExports: [],
    recommendedModes: [],
    status: STATUS.NOT_RECOMMENDED,
    reason: REASONS.NO_EXPORTER,
    warnings: [],
    notes: [],
  },
  {
    clientId: 'homeproxy',
    name: 'HomeProxy',
    platforms: ['linux'],
    supportedExports: [],
    recommendedModes: [],
    status: STATUS.NOT_RECOMMENDED,
    reason: REASONS.NO_EXPORTER,
    warnings: [],
    notes: [],
  },
  {
    clientId: 'throne',
    name: 'Throne',
    platforms: ['windows', 'linux'],
    supportedExports: [],
    recommendedModes: [],
    status: STATUS.NOT_RECOMMENDED,
    reason: REASONS.RESEARCH_ONLY,
    warnings: [],
    notes: [],
  },
  {
    clientId: 'onebox',
    name: 'OneBox',
    platforms: ['windows', 'linux'],
    supportedExports: [],
    recommendedModes: [],
    status: STATUS.NOT_RECOMMENDED,
    reason: REASONS.NO_EXPORTER,
    warnings: [],
    notes: [],
  },
  {
    clientId: 'anyportal',
    name: 'AnyPortal',
    platforms: ['android'],
    supportedExports: [],
    recommendedModes: [],
    status: STATUS.NOT_RECOMMENDED,
    reason: REASONS.RESEARCH_ONLY,
    warnings: [],
    notes: [],
  },
  {
    clientId: 'exclave',
    name: 'Exclave',
    platforms: ['android'],
    supportedExports: [],
    recommendedModes: [],
    status: STATUS.NOT_RECOMMENDED,
    reason: REASONS.RESEARCH_ONLY,
    warnings: [],
    notes: [],
  },
]);

const VALID_MODES = ['legacy', 'awg2'];

/** @returns {string[]} the export ids a generation produced, given the flags. */
function resolveAvailableExports({ exportType, link } = {}) {
  const exports = ['conf'];
  if (link) exports.push('vpnlink');
  // exportType only widens the set when it is a stable, produced format.
  if (exportType && !exports.includes(exportType) && isStableExportTarget(exportType)) {
    exports.push(exportType);
  }
  return exports;
}

/** Intersection of the client's supported exports with what was produced. */
function usableExports(client, availableExports) {
  return client.supportedExports.filter((e) => availableExports.includes(e));
}

/**
 * Build the compatibility summary for a single generation result.
 *
 * @param {object} context
 * @param {('legacy'|'awg2'|string)} context.mode  generated config mode.
 * @param {string} [context.exportType]            primary requested export id.
 * @param {boolean} [context.mobile]               mobile profile applied.
 * @param {boolean} [context.router]               router profile applied.
 * @param {boolean} [context.link]                 a vpn:// link was produced.
 * @returns {{recommended: object[], experimental: object[], notRecommended: object[], warnings: string[]}}
 */
function getCompatibilityForGeneration(context = {}) {
  const mode = VALID_MODES.includes(context.mode) ? context.mode : 'legacy';
  const link = Boolean(context.link);
  const exportType = typeof context.exportType === 'string' ? context.exportType : undefined;

  const availableExports = resolveAvailableExports({ exportType, link });

  const recommended = [];
  const experimental = [];
  const notRecommended = [];

  for (const client of CLIENTS) {
    const exports = usableExports(client, availableExports);
    const modeOk = client.recommendedModes.includes(mode);

    if (client.status === STATUS.NOT_RECOMMENDED || exports.length === 0) {
      notRecommended.push({
        clientId: client.clientId,
        name: client.name,
        reason: client.reason || REASONS.NO_PATH,
      });
      continue;
    }

    if (client.status === STATUS.RECOMMENDED && modeOk) {
      recommended.push({
        clientId: client.clientId,
        name: client.name,
        platforms: [...client.platforms],
        exports,
        notes: [...client.notes],
      });
      continue;
    }

    // Recommended-but-mode-mismatch, or explicitly experimental → experimental.
    experimental.push({
      clientId: client.clientId,
      name: client.name,
      platforms: [...client.platforms],
      exports,
      warnings: client.warnings.length ? [...client.warnings] : [WARNINGS.CLIENT_VERSION],
    });
  }

  const warnings = [];
  if (mode === 'awg2') warnings.push(WARNINGS.CLOUDFLARE_PEER);
  if (experimental.length > 0) warnings.push(WARNINGS.CLIENT_VERSION);
  if (exportType) {
    const target = getExportTarget(exportType);
    if (target && !isStableExportTarget(exportType)) {
      warnings.push(WARNINGS.UNSUPPORTED_EXPORTER);
    }
  }

  return {
    recommended,
    experimental,
    notRecommended,
    warnings: [...new Set(warnings)],
  };
}

/** @returns {object[]} copies of the raw client registry (read-only). */
function listClients() {
  return CLIENTS.map((c) => ({
    ...c,
    platforms: [...c.platforms],
    supportedExports: [...c.supportedExports],
    recommendedModes: [...c.recommendedModes],
    warnings: [...c.warnings],
    notes: [...c.notes],
  }));
}

module.exports = {
  STATUS,
  WARNINGS,
  REASONS,
  getCompatibilityForGeneration,
  listClients,
};
