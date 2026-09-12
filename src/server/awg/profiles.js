'use strict';

const AWG3_DEFAULT_TIMINGS = Object.freeze({
  rekeyAfterTime: '100-120',
  rekeyTimeout: '3-7',
  rejectAfterTime: '150-180',
  keepaliveTimeout: '5-15',
  maxHandshakeAttempts: '15-20',
});

const COMMON_AWG3_SUPPORT = Object.freeze({
  junk: true,
  cps: true,
  timingRanges: true,
  persistentKeepaliveRange: true,
  contentPadding: 'experimental',
  headerProtection: false,
  randomTrailers: false,
  disableCookies: false,
});

const AWG_PROFILES = Object.freeze({
  legacy: Object.freeze({ id: 'legacy', displayVersion: '1.5', warpSafe: true }),
  awg2: Object.freeze({ id: 'awg2', displayVersion: '2.0', warpSafe: true }),
  awg3: Object.freeze({
    id: 'awg3',
    displayVersion: '3.0',
    warpSafe: true,
    supports: COMMON_AWG3_SUPPORT,
    persistentKeepalive: '25-35',
    timings: AWG3_DEFAULT_TIMINGS,
    contentPaddingDefault: '10-100',
    vpnProtocolVersion: null,
  }),
  awg31: Object.freeze({
    id: 'awg31',
    displayVersion: '3.1',
    warpSafe: true,
    supports: COMMON_AWG3_SUPPORT,
    persistentKeepalive: '25-35',
    timings: AWG3_DEFAULT_TIMINGS,
    contentPaddingDefault: '10-100',
    vpnProtocolVersion: '3.1',
    explicitSafeFlags: Object.freeze({ randomTrailers: 'off', disableCookies: 'off' }),
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
  const disabledFeatures = [
    { feature: 'header-protection', reason: 'requires-awg-peer' },
    { feature: 'message-padding', reason: 'stock-wireguard-peer' },
    { feature: 'dynamic-message-headers', reason: 'stock-wireguard-peer' },
  ];
  if (mode === 'awg31') {
    disabledFeatures.push(
      { feature: 'random-trailers', reason: 'requires-awg31-peer' },
      { feature: 'cookie-behaviour-obfuscation', reason: 'peer-not-controlled' },
    );
  }
  return {
    requestedVersion: profile.displayVersion,
    profile: 'warp-safe',
    peerType: 'stock-wireguard',
    enabledFeatures: ['junk-packets', 'cps', 'timing-ranges', 'persistent-keepalive-range'],
    disabledFeatures,
    experimentalFeatures: options.contentPaddingExperimental ? ['content-padding-addition'] : [],
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
