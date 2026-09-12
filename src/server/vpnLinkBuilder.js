const { deflateSync } = require('zlib');
const { Buffer } = require('buffer');
const { AWG_PROFILES } = require('./awg/profiles');

/**
 * AmneziaVPN one-tap import URI: vpn://<base64url(qCompress(JSON))>.
 *
 * Format (verified against amnezia-vpn/amnezia-client issue #1407):
 *   1. Build JSON with shape below.
 *   2. qCompress = Qt's zlib wrapper: 4-byte big-endian uint32 (uncompressed
 *      byte length) + zlib-compressed payload (NOT deflate-raw).
 *   3. base64url-encode (URL-safe alphabet, no padding).
 *   4. Prefix `vpn://`.
 *
 * JSON shape:
 *   {
 *     containers: [{
 *       container: "amnezia-awg",
 *       awg: {
 *         last_config: "{\"config\":\"<INI>\",\"mtu\":\"1280\",\"port\":\"4500\"}",
 *         isThirdPartyConfig: true,
 *         port: "4500",
 *         protocol_version: "2" | "3" | "3.1",
 *         transport_proto: "udp"
 *       }
 *     }],
 *     defaultContainer: "amnezia-awg",
 *     description: "...",
 *     dns1: "...",
 *     dns2: "...",
 *     hostName: "..."
 *   }
 *
 * Note: last_config is a JSON STRING (double-nested), containing the raw
 * WireGuard INI text plus mtu/port extracted from it.
 *
 * Historical caveat: AWG 3.0 import envelope is not confirmed here. This
 * builder emits vpn:// only for modes with a confirmed protocol version.
 */
const toBase64Url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

/** Qt's qCompress: 4-byte BE length prefix + zlib-compressed data. */
const qCompress = (data) => {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(input.length, 0);
  const compressed = deflateSync(input);
  return Buffer.concat([prefix, compressed]);
};

/** Extract `MTU = <n>` from [Interface] block; default 1280 (Cloudflare WARP). */
const extractMtu = (conf) => {
  const m = /^\s*MTU\s*=\s*(\d+)\s*$/m.exec(conf);
  return m ? m[1] : '1280';
};

/** Extract port from `Endpoint = host:port` in [Peer]; default 4500. */
const extractPort = (conf) => {
  const m = /^\s*Endpoint\s*=\s*.*:(\d+)\s*$/m.exec(conf);
  return m ? m[1] : '4500';
};

const resolveProtocolVersion = (mode) => {
  if (mode === 'awg2') return '2';
  if (mode === 'awg31') return AWG_PROFILES.awg31.vpnProtocolVersion;
  if (mode === 'awg3') return null;
  return '1.5';
};

/**
 * @param {string} confText Full .conf text (the same text that gets base64-encoded into `content`).
 * @param {{ hostName?: string, dns1?: string, dns2?: string, mode?: string }} meta
 * @returns {string} `vpn://...`
 */
const buildVpnLink = (confText, meta = {}) => {
  const protocolVersion = resolveProtocolVersion(meta.mode);
  if (!protocolVersion) return null;
  const innerConfig = JSON.stringify({
    config: confText,
    mtu: extractMtu(confText),
    port: extractPort(confText),
  });

  const outer = {
    containers: [{
      container: 'amnezia-awg',
      awg: {
        last_config: innerConfig,
        isThirdPartyConfig: true,
        port: extractPort(confText),
        protocol_version: protocolVersion,
        transport_proto: 'udp',
      },
    }],
    defaultContainer: 'amnezia-awg',
    description: `WARP (${meta.mode || 'awg'}) via amnezia-config-gen`,
    dns1: meta.dns1 || '1.1.1.1',
    dns2: meta.dns2 || '1.0.0.1',
    hostName: meta.hostName || 'engage.cloudflareclient.com',
  };

  const json = JSON.stringify(outer);
  const compressed = qCompress(json);
  return `vpn://${toBase64Url(compressed)}`;
};

module.exports = { buildVpnLink, resolveProtocolVersion };
