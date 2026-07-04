// src/server/exportTargets.js
// Export target registry v0 — Release 2.7.0 (Compatibility & Onboarding Clarity).
//
// This module is metadata-only. It does NOT implement any exporter. Its job is
// to describe which output formats exist and how "ready" each one is, so the UI
// can honestly mark experimental/research formats instead of presenting them as
// stable, working exporters.
//
// A target's `status` is one of:
//   stable        — produced today by the generator and safe to rely on.
//   experimental  — potentially usable, but not a stable/verified path.
//   research      — investigation only, no working path.
//   documentation — covered by docs/manual steps, no direct generator output.
//   not_supported — explicitly unsupported.
//
// A target's `requires` lists capabilities the generation must satisfy for the
// target to be actually available in a given request:
//   vpnLink       — the request produced a vpn:// link (link=1).
//   exporter      — a dedicated exporter (NOT implemented in 2.7.0).
//   research      — research-only, never available as a working path in 2.7.0.
//   routerProfile — router profile pack (NOT implemented in 2.7.0).
//
// Security: this module contains only static metadata. It never receives or
// echoes secrets, config text, or vpn:// payloads.

'use strict';

const STATUS = Object.freeze({
  STABLE: 'stable',
  EXPERIMENTAL: 'experimental',
  RESEARCH: 'research',
  DOCUMENTATION: 'documentation',
  NOT_SUPPORTED: 'not_supported',
});

/**
 * Capabilities that can be satisfied at generation time in 2.7.0.
 * Anything not listed here (exporter, research, routerProfile) is never
 * satisfiable yet, which keeps experimental/research targets out of the
 * "available now" set.
 */
const SATISFIABLE_REQUIREMENTS = Object.freeze(['vpnLink']);

const EXPORT_TARGETS = Object.freeze([
  {
    id: 'conf',
    label: '.conf',
    status: STATUS.STABLE,
    compatibleClients: ['amnezia_vpn', 'amneziawg_client'],
    requires: [],
    warnings: [],
  },
  {
    id: 'vpnlink',
    label: 'vpn://',
    status: STATUS.STABLE,
    compatibleClients: ['amnezia_vpn'],
    requires: ['vpnLink'],
    warnings: [],
  },
  {
    id: 'qr',
    label: 'QR',
    status: STATUS.EXPERIMENTAL,
    compatibleClients: ['amnezia_vpn'],
    requires: ['vpnLink'],
    warnings: ['QR compatibility depends on the target client.'],
  },
  {
    id: 'singbox',
    label: 'sing-box',
    status: STATUS.EXPERIMENTAL,
    compatibleClients: ['sing_box'],
    requires: ['exporter'],
    warnings: ['Exporter is not stable yet.'],
  },
  {
    id: 'mihomo',
    label: 'Mihomo',
    status: STATUS.EXPERIMENTAL,
    compatibleClients: ['mihomo'],
    requires: ['exporter'],
    warnings: ['Direct export is not implemented yet.'],
  },
  {
    id: 'clash',
    label: 'Clash',
    status: STATUS.EXPERIMENTAL,
    compatibleClients: ['clash', 'openclash'],
    requires: ['exporter'],
    warnings: ['Direct export is not implemented yet.'],
  },
  {
    id: 'throne',
    label: 'Throne',
    status: STATUS.RESEARCH,
    compatibleClients: ['throne'],
    requires: ['research'],
    warnings: ['Research target only.'],
  },
  {
    id: 'openwrt',
    label: 'OpenWrt',
    status: STATUS.DOCUMENTATION,
    compatibleClients: ['openclash', 'homeproxy'],
    requires: ['routerProfile'],
    warnings: ['Use router profile when available.'],
  },
]);

/** Deep-freeze helper for defensive copies returned to callers. */
const clone = (target) => ({
  ...target,
  compatibleClients: [...target.compatibleClients],
  requires: [...target.requires],
  warnings: [...target.warnings],
});

/**
 * @param {string} id
 * @returns {object|null} a copy of the target, or null when unknown.
 */
function getExportTarget(id) {
  if (typeof id !== 'string' || !id) return null;
  const found = EXPORT_TARGETS.find((t) => t.id === id.trim().toLowerCase());
  return found ? clone(found) : null;
}

/**
 * @returns {object[]} copies of all registered targets, in registry order.
 */
function listExportTargets() {
  return EXPORT_TARGETS.map(clone);
}

/**
 * Returns whether every requirement of a target is satisfiable in the given
 * generation context.
 * @param {object} target
 * @param {{ link?: boolean, hasVpnLink?: boolean }} context
 */
function isTargetAvailable(target, context = {}) {
  const hasVpnLink = Boolean(context.hasVpnLink || context.link);
  return target.requires.every((req) => {
    if (!SATISFIABLE_REQUIREMENTS.includes(req)) return false;
    if (req === 'vpnLink') return hasVpnLink;
    return false;
  });
}

/**
 * Export targets that can actually be produced for a given generation context.
 * In 2.7.0 this is `.conf` always, plus `vpn://` / QR when a vpn:// link was
 * produced. Exporter/research/router targets are never "available" yet.
 * @param {{ link?: boolean, hasVpnLink?: boolean }} context
 * @returns {object[]}
 */
function getAvailableExportTargets(context = {}) {
  return EXPORT_TARGETS.filter((t) => isTargetAvailable(t, context)).map(clone);
}

/**
 * True when a target is a stable, ready-to-use export path.
 * @param {string} id
 */
function isStableExportTarget(id) {
  const target = getExportTarget(id);
  return Boolean(target && target.status === STATUS.STABLE);
}

module.exports = {
  STATUS,
  getExportTarget,
  listExportTargets,
  getAvailableExportTargets,
  isStableExportTarget,
  // Exposed for tests / advanced callers; treat as read-only.
  EXPORT_TARGETS,
};
