'use strict';

const { AWG_PROFILES } = require('./profiles');
const { enforceWarpSafeAwgConfig } = require('./warpSafety');

const buildAddressLine = (clientIPv4, clientIPv6, plainAddress) => {
  if (!clientIPv6) return `Address = ${plainAddress ? clientIPv4 : `${clientIPv4}/32`}`;
  return plainAddress
    ? `Address = ${clientIPv4}, ${clientIPv6}`
    : `Address = ${clientIPv4}/32, ${clientIPv6}/128`;
};

const buildAwg3Interface = (options) => {
  const profile = AWG_PROFILES[options.mode];
  if (!profile || !profile.timings) throw new TypeError(`Unsupported AWG 3.x mode: ${options.mode}`);
  const safe = enforceWarpSafeAwgConfig({ mode: options.mode, ...options.obfuscation });
  const timings = { ...profile.timings, ...options.timings };
  const lines = [
    '[Interface]',
    `PrivateKey = ${options.privateKey}`,
    buildAddressLine(options.clientIPv4, options.clientIPv6, options.plainAddress),
    `DNS = ${options.dnsLine}`,
    `Jc = ${safe.Jc}`,
    `Jmin = ${safe.Jmin}`,
    `Jmax = ${safe.Jmax}`,
    `S1 = ${safe.S1}`, `S2 = ${safe.S2}`, `S3 = ${safe.S3}`, `S4 = ${safe.S4}`,
    `H1 = ${safe.H1}`, `H2 = ${safe.H2}`, `H3 = ${safe.H3}`, `H4 = ${safe.H4}`,
  ];
  if (options.i1) {
    lines.push(`I1 = ${options.i1}`);
    if (options.extraCps) {
      for (const field of ['I2', 'I3', 'I4', 'I5']) lines.push(`${field} = ${options.extraCps[field]}`);
    }
  }
  if (options.contentPaddingAddition) lines.push(`ContentPaddingAddition = ${options.contentPaddingAddition}`);
  lines.push(
    `RekeyAfterTime = ${timings.rekeyAfterTime}`,
    `RekeyTimeout = ${timings.rekeyTimeout}`,
    `RejectAfterTime = ${timings.rejectAfterTime}`,
    `KeepaliveTimeout = ${timings.keepaliveTimeout}`,
    `MaxHandshakeAttempts = ${timings.maxHandshakeAttempts}`,
  );
  if (safe.randomTrailers) lines.push(`RandomTrailers = ${safe.randomTrailers}`);
  if (safe.disableCookies) lines.push(`DisableCookies = ${safe.disableCookies}`);
  lines.push('MTU = 1280');
  return lines.join('\n');
};

module.exports = { buildAwg3Interface };
