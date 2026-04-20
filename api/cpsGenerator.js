'use strict';

const { randomInt, randomBytes: cryptoRandomBytes } = require('crypto');

// ── helpers ────────────────────────────────────────────────────

const randomBytes = (n) => cryptoRandomBytes(n);

const u8 = (v) => Buffer.from([v & 0xff]);
const u16be = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const u32be = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const concat = (...bufs) => Buffer.concat(bufs.map((b) => Buffer.isBuffer(b) ? b : Buffer.from(b)));

// ── DNS ────────────────────────────────────────────────────────

const DNS_HOSTS = [
  'www.google.com', 'cloudflare.com', 'discord.com',
  'youtube.com', 'api.telegram.org', 'cdn.jsdelivr.net',
];
const DNS_QTYPES = [0x0001, 0x001c, 0x0041]; // A, AAAA, CAA

const encodeDnsName = (host) => {
  const parts = host.split('.');
  const bufs = parts.map((p) => {
    const lbl = Buffer.from(p, 'ascii');
    return concat(u8(lbl.length), lbl);
  });
  return concat(...bufs, u8(0));
};

const generateDnsPayload = () => {
  const txid = u16be(randomInt(1, 65535));
  const flags = u16be(0x0100); // standard query, recursion desired
  const qdcount = u16be(1);
  const zero = u16be(0);
  const host = DNS_HOSTS[randomInt(0, DNS_HOSTS.length)];
  const qname = encodeDnsName(host);
  const qtype = u16be(DNS_QTYPES[randomInt(0, DNS_QTYPES.length)]);
  const qclass = u16be(0x0001); // IN

  // OPT record (EDNS0)
  const opt = concat(
    u8(0),        // root name
    u16be(0x0029), // type OPT
    u16be(1232),   // payload size
    u32be(0),      // extended RCODE + version
    u16be(0),      // RDLENGTH
  );

  return concat(txid, flags, qdcount, zero, zero, zero, qname, qtype, qclass, opt);
};

// ── STUN ───────────────────────────────────────────────────────

const STUN_MAGIC = 0x2112a442;

const crc32 = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return (buf) => {
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
})();

const stunAttr = (type, value) => {
  const pad = (4 - (value.length % 4)) % 4;
  return concat(u16be(type), u16be(value.length), value, Buffer.alloc(pad));
};

const generateStunPayload = () => {
  const txId = randomBytes(12);
  // USERNAME attr (0x0006): random ICE ufrag pair
  const ufrag1 = randomBytes(4).toString('hex');
  const ufrag2 = randomBytes(4).toString('hex');
  const username = stunAttr(0x0006, Buffer.from(`${ufrag1}:${ufrag2}`, 'utf8'));
  // PRIORITY attr (0x0024): 4 bytes
  const priority = stunAttr(0x0024, u32be(randomInt(1000000, 2130706431)));
  // ICE-CONTROLLING (0x802a): 8 bytes tiebreaker
  const tiebreaker = randomBytes(8);
  const iceCtrl = stunAttr(0x802a, tiebreaker);

  // Build header + attrs first, then append FINGERPRINT
  const attrs = concat(username, priority, iceCtrl);
  const msgLen = attrs.length + 8; // +8 for FINGERPRINT attr (4 header + 4 value)
  const header = concat(u16be(0x0001), u16be(msgLen), u32be(STUN_MAGIC), txId);
  const partial = concat(header, attrs);
  const fp = (crc32(partial) ^ 0x5354554e) >>> 0;
  const fingerprintAttr = stunAttr(0x8028, u32be(fp));

  return concat(partial, fingerprintAttr);
};

// ── TLS ClientHello ────────────────────────────────────────────

const TLS_HOSTS = [
  'www.google.com', 'cloudflare.com', 'discord.com',
  'api.telegram.org', 'youtube.com',
];

const tlsExt = (type, data) => concat(u16be(type), u16be(data.length), data);

const generateTlsPayload = () => {
  const host = TLS_HOSTS[randomInt(0, TLS_HOSTS.length)];
  const clientRandom = randomBytes(32);
  const sessionId = randomBytes(32);

  // SNI extension (0x0000)
  const hostBuf = Buffer.from(host, 'ascii');
  const sniEntry = concat(u8(0), u16be(hostBuf.length), hostBuf);
  const sniList = concat(u16be(sniEntry.length), sniEntry);
  const sniExt = tlsExt(0x0000, sniList);

  // supported_versions (0x002b): TLS 1.3 + 1.2
  const versExt = tlsExt(0x002b, concat(u8(4), u16be(0x0304), u16be(0x0303)));

  // supported_groups (0x000a): x25519, secp256r1
  const groupsExt = tlsExt(0x000a, concat(u16be(4), u16be(0x001d), u16be(0x0017)));

  // ALPN (0x0010): h2, http/1.1
  const h2 = concat(u8(2), Buffer.from('h2'));
  const http11 = concat(u8(8), Buffer.from('http/1.1'));
  const alpnList = concat(u16be(h2.length + http11.length), h2, http11);
  const alpnExt = tlsExt(0x0010, concat(u16be(alpnList.length), alpnList));

  // key_share (0x0033): x25519 key
  const pubKey = randomBytes(32);
  const ksEntry = concat(u16be(0x001d), u16be(32), pubKey);
  const ksExt = tlsExt(0x0033, concat(u16be(ksEntry.length), ksEntry));

  const extensions = concat(sniExt, versExt, groupsExt, alpnExt, ksExt);

  // Cipher suites: TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256
  const ciphers = concat(u16be(0x1301), u16be(0x1302), u16be(0x1303));

  // ClientHello body
  const chBody = concat(
    u16be(0x0303),             // legacy version
    clientRandom,
    u8(sessionId.length), sessionId,
    u16be(ciphers.length), ciphers,
    u8(1), u8(0),              // compression methods: null
    u16be(extensions.length), extensions,
  );

  // Handshake header: type=1 (ClientHello), 3-byte length
  const chLen = chBody.length;
  const handshake = concat(
    u8(0x01),
    u8((chLen >> 16) & 0xff), u8((chLen >> 8) & 0xff), u8(chLen & 0xff),
    chBody,
  );

  // TLS record: type=22 (handshake), version=0x0301, length
  return concat(u8(0x16), u16be(0x0301), u16be(handshake.length), handshake);
};

// ── QUIC Initial (plaintext, no encryption) ───────────────────
// Produces a valid-looking QUIC Initial packet with a TLS ClientHello
// inside a CRYPTO frame. Not RFC-9001-encrypted (no secret derivation)
// but structurally correct and sufficient for DPI camouflage.

const QUIC_VERSION = 0x00000001; // QUIC v1

const varInt = (n) => {
  if (n < 64) return u8(n);
  if (n < 16384) return u16be(n | 0x4000);
  return u32be(n | 0x80000000);
};

const generateQuicPayload = () => {
  const host = TLS_HOSTS[randomInt(0, TLS_HOSTS.length)];
  const dcid = randomBytes(8);
  const scid = randomBytes(8);
  const pktNum = randomInt(0, 256);

  // Build TLS ClientHello (reuse same logic, QUIC variant has no TLS record wrapper)
  const clientRandom = randomBytes(32);
  const sessionId = Buffer.alloc(0); // QUIC uses empty session ID

  const hostBuf = Buffer.from(host, 'ascii');
  const sniEntry = concat(u8(0), u16be(hostBuf.length), hostBuf);
  const sniList = concat(u16be(sniEntry.length), sniEntry);
  const sniExt = tlsExt(0x0000, sniList);
  const versExt = tlsExt(0x002b, concat(u8(2), u16be(0x0304)));
  const groupsExt = tlsExt(0x000a, concat(u16be(2), u16be(0x001d)));
  const pubKey = randomBytes(32);
  const ksEntry = concat(u16be(0x001d), u16be(32), pubKey);
  const ksExt = tlsExt(0x0033, concat(u16be(ksEntry.length), ksEntry));
  // QUIC transport parameters ext (0x0039)
  const qtpExt = tlsExt(0x0039, concat(
    u8(0x01), u8(2), u16be(65527), // max_idle_timeout
    u8(0x04), u8(4), u32be(1048576), // initial_max_data
  ));

  const exts = concat(sniExt, versExt, groupsExt, ksExt, qtpExt);
  const ciphers = concat(u16be(0x1301), u16be(0x1302));
  const chBody = concat(
    u16be(0x0303), clientRandom,
    u8(0),                         // empty session ID
    u16be(ciphers.length), ciphers,
    u8(1), u8(0),
    u16be(exts.length), exts,
  );
  const chLen = chBody.length;
  const ch = concat(
    u8(0x01),
    u8((chLen >> 16) & 0xff), u8((chLen >> 8) & 0xff), u8(chLen & 0xff),
    chBody,
  );

  // CRYPTO frame: type=0x06, offset=0, length=ch.length, data=ch
  const cryptoFrame = concat(u8(0x06), varInt(0), varInt(ch.length), ch);

  // Padding PING frames to ~1200 bytes total
  const targetPayloadLen = 1162;
  const pad = Math.max(0, targetPayloadLen - cryptoFrame.length);
  const padding = Buffer.alloc(pad, 0x00); // PADDING frames

  const payload = concat(cryptoFrame, padding);

  // QUIC Initial packet header (Long Header, type=0x00)
  // First byte: 1 (long) | 1 (fixed) | 00 (initial) | 00 (reserved) | 00 (pkt num len-1)
  const firstByte = 0xc0; // long header, initial type, 1-byte pkt number
  const header = concat(
    u8(firstByte),
    u32be(QUIC_VERSION),
    u8(dcid.length), dcid,
    u8(scid.length), scid,
    u8(0),           // token length = 0
    varInt(payload.length + 1), // payload length + 1 for pkt number
    u8(pktNum),
  );

  return concat(header, payload);
};

// ── SIP (reuse from warpCpsPayloads) ──────────────────────────

const generateSipPayload = () => {
  const { generateSipCpsPair } = require('./warpCpsPayloads');
  return generateSipCpsPair().i1;
};

// ── Static (existing pool) ────────────────────────────────────

const generateStaticPayload = () => {
  const { pickRandomCpsPayload } = require('./warpCpsPayloads');
  return pickRandomCpsPayload();
};

// ── Dispatcher ────────────────────────────────────────────────

const AUTO_PROTOCOLS = ['quic', 'dns', 'stun', 'tls', 'sip'];

const toHex = (buf) => `<b 0x${buf.toString('hex')}>`;

/**
 * Generate a CPS payload for the given protocol key.
 * Returns a string ready for `I1 = ` in the config.
 * @param {string} protocol  auto | quic | dns | stun | tls | sip | static
 * @returns {Promise<string>}
 */
const generateCpsPayload = async (protocol) => {
  const key = String(protocol || 'auto').toLowerCase().trim();

  if (key === 'auto') {
    const picked = AUTO_PROTOCOLS[randomInt(0, AUTO_PROTOCOLS.length)];
    return generateCpsPayload(picked);
  }

  if (key === 'static') return generateStaticPayload();
  if (key === 'sip')    return generateSipPayload();

  let buf;
  if (key === 'quic') buf = generateQuicPayload();
  else if (key === 'dns')  buf = generateDnsPayload();
  else if (key === 'stun') buf = generateStunPayload();
  else if (key === 'tls')  buf = generateTlsPayload();
  else {
    // Unknown protocol → fallback to auto
    const picked = AUTO_PROTOCOLS[randomInt(0, AUTO_PROTOCOLS.length)];
    return generateCpsPayload(picked);
  }

  return toHex(buf);
};

module.exports = { generateCpsPayload };
