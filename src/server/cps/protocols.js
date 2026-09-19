'use strict';

const CPS_PROTOCOLS = Object.freeze({
  static: Object.freeze({ id: 'static', label: 'Static', status: 'stable', autoEligible: true, evidence: 'project WARP interoperability fixtures' }),
  sip: Object.freeze({ id: 'sip', label: 'SIP', status: 'stable', autoEligible: true, evidence: 'project WARP interoperability fixtures' }),
  stun: Object.freeze({ id: 'stun', label: 'STUN', status: 'stable', autoEligible: true, evidence: 'reported working in Issue #5 and structurally verified' }),
  quic: Object.freeze({ id: 'quic', label: 'QUIC', status: 'experimental', autoEligible: false, evidence: 'RFC 9000/9001 structure; WARP interoperability not yet verified' }),
  dns: Object.freeze({ id: 'dns', label: 'DNS', status: 'experimental', autoEligible: false, evidence: 'Amnezia response-shaped precedent; WARP interoperability not yet verified' }),
  dtls: Object.freeze({ id: 'dtls', label: 'DTLS', status: 'experimental', autoEligible: false, evidence: 'structurally verified; WARP interoperability not yet verified' }),
  tls: Object.freeze({ id: 'tls', label: 'TLS', status: 'unsupported', autoEligible: false, evidence: 'TLS over the UDP CPS path is not a supported protocol shape' }),
});

const AUTO_PROTOCOLS = Object.freeze(Object.values(CPS_PROTOCOLS)
  .filter(({ status, autoEligible }) => status === 'stable' && autoEligible)
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
