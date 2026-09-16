'use strict';

const WARP_SAFE_WIRE_FORMAT = Object.freeze({
  S1: 0, S2: 0, S3: 0, S4: 0,
  H1: '1', H2: '2', H3: '3', H4: '4',
});

class WarpSafetyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WarpSafetyValidationError';
    this.statusCode = 400;
  }
}

const assertWarpSafeAwgConfig = (config) => {
  for (const [field, expected] of Object.entries(WARP_SAFE_WIRE_FORMAT)) {
    if (config[field] !== expected) throw new WarpSafetyValidationError(`${field} is fixed for Cloudflare WARP.`);
  }
  if (config.headerProtectionKey) throw new WarpSafetyValidationError('HeaderProtectionKey is unavailable for Cloudflare WARP.');
  if (String(config.randomTrailers || '').toLowerCase() === 'on') {
    throw new WarpSafetyValidationError('RandomTrailers cannot be enabled for Cloudflare WARP.');
  }
  if (config.disableCookies != null && !['on', 'off'].includes(String(config.disableCookies).toLowerCase())) {
    throw new WarpSafetyValidationError('DisableCookies must be on or off.');
  }
  if (config.mode !== 'awg31' && config.disableCookies != null) {
    throw new WarpSafetyValidationError('DisableCookies is available only for AWG 3.1.');
  }
  return config;
};

const enforceWarpSafeAwgConfig = (config = {}) => {
  const disableCookies = config.mode === 'awg31'
    ? String(config.disableCookies || 'on').toLowerCase()
    : undefined;
  return assertWarpSafeAwgConfig({
    ...config,
    ...WARP_SAFE_WIRE_FORMAT,
    headerProtectionKey: undefined,
    randomTrailers: config.mode === 'awg31' ? 'off' : undefined,
    disableCookies,
  });
};

const assertNoBlockedWarpOverrides = (input = {}) => {
  for (const field of ['headerProtectionKey', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4']) {
    if (input[field] != null && String(input[field]).trim() !== '') {
      throw new WarpSafetyValidationError(`${field} cannot be overridden for Cloudflare WARP.`);
    }
  }
  for (const field of ['randomTrailers']) {
    if (input[field] != null && !['', '0', 'off', 'false'].includes(String(input[field]).trim().toLowerCase())) {
      throw new WarpSafetyValidationError(`${field} cannot be enabled for Cloudflare WARP.`);
    }
  }
};

module.exports = {
  WARP_SAFE_WIRE_FORMAT,
  assertNoBlockedWarpOverrides,
  assertWarpSafeAwgConfig,
  enforceWarpSafeAwgConfig,
  WarpSafetyValidationError,
};
