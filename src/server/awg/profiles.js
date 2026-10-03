'use strict';

const { AWG_CAPABILITY_BY_FIELD } = require('./evidence');
const { EVIDENCE_MODEL_VERSION } = require('../protocolEvidence');

const defaultFor = (field) => AWG_CAPABILITY_BY_FIELD[field].productPolicy.defaultValue;

const AWG3_DEFAULT_TIMINGS = Object.freeze({
  rekeyAfterTime: defaultFor('RekeyAfterTime'),
  rekeyTimeout: defaultFor('RekeyTimeout'),
  rejectAfterTime: defaultFor('RejectAfterTime'),
  keepaliveTimeout: defaultFor('KeepaliveTimeout'),
  maxHandshakeAttempts: defaultFor('MaxHandshakeAttempts'),
});

const AWG3_SUPPORT = Object.freeze({
  junk: true,
  cps: true,
  timingRanges: true,
  persistentKeepaliveRange: true,
  contentPadding: true,
  headerProtection: false,
  randomTrailers: false,
  disableCookies: false,
});

const AWG31_SUPPORT = Object.freeze({
  ...AWG3_SUPPORT,
  disableCookies: true,
});

const AWG_PROFILES = Object.freeze({
  legacy: Object.freeze({ id: 'legacy', displayVersion: '1.5', warpSafe: true }),
  awg2: Object.freeze({ id: 'awg2', displayVersion: '2.0', warpSafe: true }),
  awg3: Object.freeze({
    id: 'awg3',
    displayVersion: '3.0',
    warpSafe: true,
    supports: AWG3_SUPPORT,
    persistentKeepalive: defaultFor('PersistentKeepalive'),
    timings: AWG3_DEFAULT_TIMINGS,
    contentPaddingDefault: defaultFor('ContentPaddingAddition'),
    vpnProtocolVersion: null,
  }),
  awg31: Object.freeze({
    id: 'awg31',
    displayVersion: '3.1',
    warpSafe: true,
    supports: AWG31_SUPPORT,
    persistentKeepalive: defaultFor('PersistentKeepalive'),
    timings: AWG3_DEFAULT_TIMINGS,
    contentPaddingDefault: defaultFor('ContentPaddingAddition'),
    vpnProtocolVersion: '3.1',
    explicitSafeFlags: Object.freeze({ randomTrailers: 'off', disableCookies: defaultFor('DisableCookies') }),
  }),
});

const MODE_ALIASES = new Map([
  ['legacy', 'legacy'],
  ['awg2', 'awg2'], ['2', 'awg2'], ['v2', 'awg2'],
  ['awg3', 'awg3'], ['awg3.0', 'awg3'], ['awg30', 'awg3'], ['3', 'awg3'], ['3.0', 'awg3'], ['v3', 'awg3'], ['v3.0', 'awg3'],
  ['awg31', 'awg31'], ['awg3.1', 'awg31'], ['3.1', 'awg31'], ['v3.1', 'awg31'], ['31', 'awg31'],
]);

const normalizeAwgMode = (value) => MODE_ALIASES.get(String(value ?? '').trim().toLowerCase()) || 'legacy';
const getAwgProfile = (mode) => AWG_PROFILES[normalizeAwgMode(mode)];
const isAwg3Mode = (mode) => mode === 'awg3' || mode === 'awg31';
const isAwg31Mode = (mode) => mode === 'awg31';

const buildAwgMetadata = (mode, options = {}) => {
  if (!isAwg3Mode(mode)) return undefined;
  const profile = AWG_PROFILES[mode];
  const configText = options.configText || '';
  const fieldValue = (field) => {
    const match = configText.match(new RegExp(`^${field} = ([^\\r\\n]+)$`, 'm'));
    return match ? match[1] : undefined;
  };
  const effective = (field, blocked = false) => {
    const record = AWG_CAPABILITY_BY_FIELD[field];
    const value = fieldValue(field);
    return {
      status: record.evidenceStatus,
      effectiveState: blocked ? 'blocked' : value && value !== 'off' ? 'active' : 'disabled',
      ...(value && !blocked ? { effectiveValue: value } : {}),
    };
  };
  const contentPadding = effective('ContentPaddingAddition');
  const disableCookies = mode === 'awg31' ? effective('DisableCookies') : undefined;
  const disabledFeatures = [
    { feature: 'header-protection', reason: 'requires-awg-peer' },
    { feature: 'message-padding', reason: 'stock-wireguard-peer' },
    { feature: 'dynamic-message-headers', reason: 'stock-wireguard-peer' },
  ];
  if (mode === 'awg31') disabledFeatures.push({ feature: 'random-trailers', reason: 'requires-awg31-peer' });
  const enabledFeatures = ['junk-packets', 'cps', 'timing-ranges', 'persistent-keepalive-range'];
  if (contentPadding.effectiveState === 'active') enabledFeatures.push('content-padding-addition');
  if (disableCookies?.effectiveState === 'active') enabledFeatures.push('disable-cookies');
  return {
    requestedVersion: profile.displayVersion,
    profile: 'warp-safe',
    peerType: 'stock-wireguard',
    evidenceModelVersion: EVIDENCE_MODEL_VERSION,
    capabilities: {
      contentPaddingAddition: contentPadding,
      ...(disableCookies ? { disableCookies } : {}),
      randomTrailers: effective('RandomTrailers', true),
      headerProtectionKey: effective('HeaderProtectionKey', true),
    },
    enabledFeatures,
    disabledFeatures,
    experimentalFeatures: [],
    vpnImport: profile.vpnProtocolVersion
      ? { available: Boolean(options.vpnLinkAvailable), protocolVersion: profile.vpnProtocolVersion }
      : { available: false, reason: 'protocol-version-unconfirmed' },
    routerCompatibility: options.routerMode ? 'experimental/router-dependent' : undefined,
  };
};

module.exports = {
  AWG3_DEFAULT_TIMINGS,
  AWG_PROFILES,
  buildAwgMetadata,
  getAwgProfile,
  isAwg31Mode,
  isAwg3Mode,
  normalizeAwgMode,
};
