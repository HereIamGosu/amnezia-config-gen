'use strict';

const { EVIDENCE_SOURCES, validateProtocolEvidence } = require('../protocolEvidence');

const AWG_MODES = Object.freeze(['awg3', 'awg31']);
const UINT16_RANGE = Object.freeze({ syntax: 'integer-or-range', numericType: 'uint16', min: 0, max: 65535 });
const UINT16_INTEGER = Object.freeze({ syntax: 'integer', numericType: 'uint16', min: 0, max: 65535 });
const PRIMARY_SOURCES = Object.freeze(['amneziawg-go', 'amneziawg-tools']);

const capability = (field, evidenceStatus, semantics, parserContract, productPolicy, extra = {}) => Object.freeze({
  id: field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^-/, ''),
  fields: Object.freeze([field]),
  modes: extra.modes || AWG_MODES,
  evidenceStatus,
  semantics: Object.freeze(semantics),
  parserContract: Object.freeze(parserContract),
  productPolicy: Object.freeze(productPolicy),
  interoperability: Object.freeze(extra.interoperability || { firstPartyLive: 'not-recorded' }),
  caveats: Object.freeze(extra.caveats || []),
  sources: Object.freeze(extra.sources || PRIMARY_SOURCES),
});

const local = (wireEffect) => ({ locality: 'client-side', wireEffect, requiresMatchingPeer: false });
const peerDependent = (wireEffect) => ({ locality: 'both-peers', wireEffect, requiresMatchingPeer: true });
const enabled = (defaultValue, overridable = true) => ({ state: 'enabled-by-default', defaultValue, overridable });
const optional = () => ({ state: 'opt-in', overridable: true });
const fixed = (fixedValue) => ({ state: 'fixed', fixedValue, overridable: false });
const blocked = () => ({ state: 'blocked', overridable: false });

const AWG_CAPABILITIES = Object.freeze([
  capability('Jc', 'source-confirmed', local('pre-handshake-junk-packets'), UINT16_INTEGER, enabled('generated'), {
    caveats: ['Project randomization is not an upstream default.'],
  }),
  capability('Jmin', 'source-confirmed', local('pre-handshake-junk-packet-size'), UINT16_INTEGER, enabled('generated'), {
    caveats: ['Project randomization is not an upstream recommendation.'],
  }),
  capability('Jmax', 'source-confirmed', local('pre-handshake-junk-packet-size'), UINT16_INTEGER, enabled('generated'), {
    caveats: ['Project randomization is not an upstream recommendation.'],
  }),
  ...['I1', 'I2', 'I3', 'I4', 'I5'].map((field, index) => capability(
    field, 'source-confirmed', local('pre-handshake-custom-signature-packet'),
    { syntax: 'signature-string', numericType: 'bytes', projectOutput: 'hex' }, index === 0 ? enabled('CPS-selected') : optional(), {
      caveats: ['The I-field mechanism does not verify any specific CPS payload.'],
    },
  )),
  capability('ContentPaddingAddition', 'source-confirmed', local('encrypted-transport-padding'), {
    ...UINT16_RANGE, disabledValues: ['off', '0', '0-0'],
    engineNumericType: 'wider-than-public-conf-parser',
  }, enabled('10-100'), { caveats: ['May increase packet size.'] }),
  ...[
    ['RekeyAfterTime', '100-120'],
    ['RekeyTimeout', '3-7'],
    ['RejectAfterTime', '150-180'],
    ['KeepaliveTimeout', '5-15'],
    ['MaxHandshakeAttempts', '15-20'],
  ].map(([field, value]) => capability(field, 'source-confirmed', local('randomized-local-timer'), UINT16_RANGE, enabled(value), {
    caveats: ['Timing randomization is obfuscation, not a universal performance improvement.'],
  })),
  capability('PersistentKeepalive', 'source-confirmed', local('peer-local-keepalive-timer'), {
    ...UINT16_RANGE, disabledValues: ['off', '0', '0-0'],
  }, enabled('25-35')),
  capability('DisableCookies', 'source-confirmed', local('local-under-load-cookie-reply-suppression'), {
    syntax: 'on-or-off', numericType: 'boolean',
  }, enabled('on'), {
    modes: Object.freeze(['awg31']),
    caveats: ['Reduces local cookie-based denial-of-service protection; it is an anti-fingerprinting trade-off.'],
  }),
  capability('RandomTrailers', 'peer-dependent-disabled', peerDependent('appended-handshake-trailer'), {
    syntax: 'on-or-off', numericType: 'boolean',
  }, blocked(), {
    modes: Object.freeze(['awg31']),
    interoperability: { firstPartyLive: 'not-recorded', community: 'conflicting-issue-4-report' },
    caveats: ['Cloudflare tolerance of oversized datagrams is undocumented.'],
    sources: Object.freeze(['amneziawg-go', 'amneziawg-tools', 'issue-4']),
  }),
  capability('HeaderProtectionKey', 'peer-dependent-disabled', peerDependent('encrypted-message-header'), {
    syntax: 'base64-key', numericType: 'bytes',
  }, blocked(), { caveats: ['Matching peer key and S-padding nonce relationship are required.'] }),
  ...['S1', 'S2', 'S3', 'S4'].map((field) => capability(field, 'peer-dependent-disabled', peerDependent('custom-message-padding'), {
    syntax: 'integer', numericType: 'uint16',
  }, fixed(0), { caveats: ['Zero preserves stock WireGuard framing.'] })),
  ...[['H1', '1'], ['H2', '2'], ['H3', '3'], ['H4', '4']].map(([field, value]) => capability(
    field, 'peer-dependent-disabled', peerDependent('custom-message-header'),
    { syntax: 'integer-or-range', numericType: 'uint32' }, fixed(value),
    { caveats: ['Stock WireGuard header value is fixed.'] },
  )),
]);

const AWG_CAPABILITY_BY_FIELD = Object.freeze(Object.fromEntries(AWG_CAPABILITIES.map((record) => [record.fields[0], record])));

const validateAwgEvidence = () => validateProtocolEvidence(AWG_CAPABILITIES, EVIDENCE_SOURCES);

const assertConfigEvidenceKnown = (mode, configText) => {
  const awgFields = new Set(AWG_CAPABILITIES.flatMap((record) => record.fields));
  const standardFields = new Set(['PrivateKey', 'Address', 'DNS', 'MTU', 'PublicKey', 'PresharedKey', 'AllowedIPs', 'Endpoint']);
  const errors = [];
  for (const [, field] of configText.matchAll(/^([A-Za-z][A-Za-z0-9]*)\s*=/gm)) {
    if (!awgFields.has(field)) {
      if (!standardFields.has(field)) errors.push(`${mode}: ${field} has no evidence record`);
      continue;
    }
    const record = AWG_CAPABILITY_BY_FIELD[field];
    if (!record.modes.includes(mode) || record.evidenceStatus === 'unknown') errors.push(`${mode}: ${field} has no usable evidence`);
  }
  return errors;
};

module.exports = { AWG_CAPABILITIES, AWG_CAPABILITY_BY_FIELD, assertConfigEvidenceKnown, validateAwgEvidence };
