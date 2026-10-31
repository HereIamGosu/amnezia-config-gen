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
 *         last_config: "<JSON string, see below>",
 *         isThirdPartyConfig: true,
 *         port: "4500",
 *         protocol_version: "1.5" | "2" | "3.1",
 *         transport_proto: "udp"
 *       }
 *     }],
 *     defaultContainer: "amnezia-awg",
 *     description: "...",
 *     dns1: "...",
 *     dns2: "...",
 *     hostName: "<host of the Endpoint>"
 *   }
 *
 * last_config is a JSON STRING (double-nested). It has the same fields the client stores when it imports a .conf
 * itself (ImportController::extractWireGuardConfig, amnezia-client 5.0.3.0): the raw INI text under `config` plus
 * hostName, port (a NUMBER), client_priv_key, client_ip, server_pub_key, psk_key, mtu, persistent_keep_alive,
 * allowed_ips (an array) and every AWG key present in the config under its own name (Jc, S1, H1, I1, …).
 * Only the INI text was written before 3.1.3, and AmneziaVPN reads the structured fields, not the text: iOS
 * (WGConfig.swift) failed with "hostName … found null", Android (Wireguard.kt getString/getInt) and desktop
 * (localsocketcontroller.cpp) read the same fields.
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

/** AWG keys the client copies from the .conf into last_config (configKey::awgProtocolKeys()). */
const AWG_KEYS = Object.freeze([
  'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1', 'I2', 'I3', 'I4', 'I5',
  'HeaderProtectionKey', 'ContentPaddingAddition', 'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime',
  'KeepaliveTimeout', 'MaxHandshakeAttempts', 'RandomTrailers', 'DisableCookies',
]);

/** key = value lines of both sections in one map, as the client reads them (split on the first "="). */
const parseConfMap = (conf) => {
  const map = new Map();
  for (const line of String(conf).split('\n')) {
    const t = line.trim();
    if (t.startsWith('[') && t.endsWith(']')) continue;
    const i = t.indexOf('=');
    if (i > 0) map.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return map;
};

/** Host of `Endpoint = host:port` (IPv6 in brackets without them), or null. */
const extractEndpointHost = (conf) => {
  const m = /^\s*Endpoint\s*=\s*(?:\[([^\]]+)\]|([^:\s]+)):\d+\s*$/m.exec(conf);
  return m ? (m[1] || m[2]) : null;
};

/** The object the client stores as last_config after importing `confText` as a .conf (see header). */
const buildLastConfig = (confText, fallbackHost) => {
  const map = parseConfMap(confText);
  const last = {
    config: confText,
    hostName: extractEndpointHost(confText) || fallbackHost,
    port: Number(extractPort(confText)),
  };
  if (map.get('PrivateKey')) last.client_priv_key = map.get('PrivateKey');
  if (map.get('Address')) last.client_ip = map.get('Address');
  const psk = map.get('PresharedKey') || map.get('PreSharedKey');
  if (psk) last.psk_key = psk;
  if (map.get('PublicKey')) last.server_pub_key = map.get('PublicKey');
  last.mtu = extractMtu(confText);
  if (map.get('PersistentKeepalive')) last.persistent_keep_alive = map.get('PersistentKeepalive');
  last.allowed_ips = (map.get('AllowedIPs') || '').split(/\s*,\s*/).filter(Boolean);
  for (const key of AWG_KEYS) if (map.get(key)) last[key] = map.get(key);
  return last;
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
  const fallbackHost = meta.hostName || 'engage.cloudflareclient.com';
  const lastConfig = buildLastConfig(confText, fallbackHost);
  const innerConfig = JSON.stringify(lastConfig);

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
    hostName: lastConfig.hostName,
  };

  const json = JSON.stringify(outer);
  const compressed = qCompress(json);
  return `vpn://${toBase64Url(compressed)}`;
};

module.exports = { buildVpnLink, resolveProtocolVersion };
