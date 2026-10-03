'use strict';

const freezeEvidence = (records) => Object.freeze(records.map(Object.freeze));

const CPS_PROTOCOLS = Object.freeze({
  static: Object.freeze({
    id: 'static',
    label: 'Static',
    status: 'stable',
    autoEligible: true,
    evidenceStatus: 'verified',
    evidence: freezeEvidence([{ type: 'project-warp-interoperability-fixture', ref: 'warp-cps-static-fixtures' }]),
    evidenceSummary: 'project WARP interoperability fixtures',
  }),
  sip: Object.freeze({
    id: 'sip',
    label: 'SIP',
    status: 'stable',
    autoEligible: true,
    evidenceStatus: 'verified',
    evidence: freezeEvidence([{ type: 'project-warp-interoperability-fixture', ref: 'warp-cps-sip-fixtures' }]),
    evidenceSummary: 'project WARP interoperability fixtures',
  }),
  stun: Object.freeze({
    id: 'stun',
    label: 'STUN',
    status: 'stable',
    autoEligible: true,
    evidenceStatus: 'verified',
    evidence: freezeEvidence([
      { type: 'community-live-report', ref: 'issue-5' },
      { type: 'project-structural-test', ref: 'cps-stun-tests' },
    ]),
    evidenceSummary: 'reported working in Issue #5 and structurally verified',
  }),
  quic: Object.freeze({
    id: 'quic',
    label: 'QUIC',
    status: 'experimental',
    autoEligible: false,
    evidenceStatus: 'experimental',
    evidence: freezeEvidence([
      { type: 'standards-source', ref: 'rfc-9000' },
      { type: 'standards-source', ref: 'rfc-9001' },
      { type: 'project-structural-test', ref: 'cps-quic-rfc9001-tests' },
    ]),
    evidenceSummary: 'RFC 9000/9001 structure; WARP interoperability not yet verified',
  }),
  dns: Object.freeze({
    id: 'dns',
    label: 'DNS',
    status: 'experimental',
    autoEligible: false,
    evidenceStatus: 'experimental',
    evidence: freezeEvidence([{ type: 'project-structural-test', ref: 'cps-dns-tests' }]),
    evidenceSummary: 'Amnezia response-shaped precedent; WARP interoperability not yet verified',
  }),
  dtls: Object.freeze({
    id: 'dtls',
    label: 'DTLS',
    status: 'experimental',
    autoEligible: false,
    evidenceStatus: 'experimental',
    evidence: freezeEvidence([{ type: 'project-structural-test', ref: 'cps-dtls-tests' }]),
    evidenceSummary: 'structurally verified; WARP interoperability not yet verified',
  }),
  tls: Object.freeze({
    id: 'tls',
    label: 'TLS',
    status: 'unsupported',
    autoEligible: false,
    evidenceStatus: 'unsupported',
    evidence: freezeEvidence([{ type: 'unsupported-protocol-shape', ref: 'udp-cps-path' }]),
    evidenceSummary: 'TLS over the UDP CPS path is not a supported protocol shape',
  }),
});

const AUTO_PROTOCOLS = Object.freeze(Object.values(CPS_PROTOCOLS)
  .filter(({ status, evidenceStatus, autoEligible }) => status === 'stable' && evidenceStatus === 'verified' && autoEligible)
  .map(({ id }) => id));

const supportedIds = () => ['auto', ...Object.values(CPS_PROTOCOLS)
  .filter(({ status }) => status !== 'unsupported')
  .map(({ id }) => id)];

const getCpsProtocol = (id) => CPS_PROTOCOLS[String(id || '').toLowerCase().trim()];

const validationError = (code, message) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  error.allowedProtocols = supportedIds();
  return error;
};

const validateCpsProtocol = (id = 'auto') => {
  const key = String(id || 'auto').toLowerCase().trim();
  if (key === 'auto') return key;
  const protocol = getCpsProtocol(key);
  if (!protocol) throw validationError('invalid_cps_protocol', `Unknown CPS protocol: ${key}`);
  if (protocol.status === 'unsupported') {
    throw validationError('unsupported_cps_protocol', `CPS protocol is unsupported: ${key}`);
  }
  return key;
};

module.exports = { AUTO_PROTOCOLS, CPS_PROTOCOLS, getCpsProtocol, validateCpsProtocol };
