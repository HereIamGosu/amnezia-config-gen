const { deflateRawSync } = require('zlib');
const { Buffer } = require('buffer');

/**
 * AmneziaVPN one-tap import URI: vpn://<base64url(deflate-raw(JSON))>.
 * On iOS/Android, opening this link in AmneziaVPN app creates a profile
 * without the user touching the .conf file.
 *
 * JSON shape is the AmneziaVPN private import schema (stable across v3.x→v4.x):
 *   containers: [{ container: 'amnezia-awg', awg: { config_version, last_config, transport_proto } }]
 *   defaultContainer, description, dns1, dns2, hostName
 */
const toBase64Url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

/**
 * @param {string} confText Full .conf text (the same text that gets base64-encoded into `content`).
 * @param {{ hostName?: string, dns1?: string, dns2?: string, mode?: string }} meta
 * @returns {string} `vpn://...`
 */
const buildVpnLink = (confText, meta = {}) => {
  const config = {
    containers: [{
      container: 'amnezia-awg',
      awg: {
        config_version: 1,
        last_config: confText,
        transport_proto: 'udp',
      },
    }],
    defaultContainer: 'amnezia-awg',
    description: `WARP (${meta.mode || 'awg'}) via amnezia-config-gen`,
    dns1: meta.dns1 || '1.1.1.1',
    dns2: meta.dns2 || '1.0.0.1',
    hostName: meta.hostName || 'engage.cloudflareclient.com',
  };
  const json = JSON.stringify(config);
  const compressed = deflateRawSync(Buffer.from(json, 'utf8'));
  return `vpn://${toBase64Url(compressed)}`;
};

module.exports = { buildVpnLink };
