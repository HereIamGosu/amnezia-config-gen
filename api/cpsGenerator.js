'use strict';

const { randomInt, randomBytes: cryptoRandomBytes } = require('crypto');

// ── helpers ────────────────────────────────────────────────────

const randomBytes = (n) => cryptoRandomBytes(n);

const u8 = (v) => Buffer.from([v & 0xff]);
const u16be = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const u32be = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const concat = (...bufs) => Buffer.concat(bufs.map((b) => Buffer.isBuffer(b) ? b : Buffer.from(b)));

/**
 * Hard ceiling per AmneziaWG `splitPad` undocumented limit (1000 bytes/tag).
 * Any single I1 payload above this risks ErrorCode 1000 in older AWG clients.
 * Source: AmneziaWG-Architect generator.ts splitPad logic.
 */
const PAYLOAD_MAX_BYTES = 1000;

const capPayload = (buf, label) => {
  if (buf.length <= PAYLOAD_MAX_BYTES) return buf;
  // Truncate from the tail: header + early extensions stay intact, padding/junk drops first.
  if (process.env.VERCEL_ENV !== 'production') {
    console.warn(`[cps] ${label} payload ${buf.length}B exceeds ${PAYLOAD_MAX_BYTES}B cap, truncating`);
  }
  return buf.slice(0, PAYLOAD_MAX_BYTES);
};

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

/**
 * Realistic USERNAME pool — mimics ICE agents from real WebRTC providers.
 * Format: "<server-ufrag>:<client-ufrag>". Username strings observed in
 * Wireshark captures for: stun.l.google.com, global.turn.twilio.com, *.cloudflare.com.
 */
const STUN_USERNAME_TEMPLATES = [
  () => `${randomBytes(4).toString('hex')}:${randomBytes(4).toString('hex')}`,                  // generic ICE ufrag pair
  () => `${randomBytes(3).toString('hex').toUpperCase()}/${randomBytes(2).toString('hex')}`,    // Google STUN style
  () => `wa-${randomInt(1000000000, 9999999999)}:${randomBytes(4).toString('hex')}`,           // WhatsApp-like
  () => `${randomInt(1700000000, 1900000000)}:${randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 12)}`, // Twilio-like (timestamp + b64 frag)
];

const STUN_SOFTWARE_VALUES = [
  'libwebrtc', 'Cisco-libsrtp', 'pjnath', 'twilio-srtp', 'cloudflare-stun',
];

const generateStunPayload = () => {
  const txId = randomBytes(12);
  const username = stunAttr(0x0006, Buffer.from(STUN_USERNAME_TEMPLATES[randomInt(0, STUN_USERNAME_TEMPLATES.length)](), 'utf8'));
  // SOFTWARE attr (0x8022): identifies the agent — DPI-realistic since real ICE agents always set it.
  const software = stunAttr(0x8022, Buffer.from(STUN_SOFTWARE_VALUES[randomInt(0, STUN_SOFTWARE_VALUES.length)], 'utf8'));
  // PRIORITY attr (0x0024): 4 bytes
  const priority = stunAttr(0x0024, u32be(randomInt(1000000, 2130706431)));
  // ICE-CONTROLLING (0x802a): 8 bytes tiebreaker
  const iceCtrl = stunAttr(0x802a, randomBytes(8));
  // USE-CANDIDATE (0x0025): 0-byte flag, frequently present in Binding requests
  const useCand = stunAttr(0x0025, Buffer.alloc(0));

  const baseAttrs = concat(software, username, priority, iceCtrl, useCand);

  // Optional padding (0x0026) to reach a realistic ICE packet size 100-220 bytes.
  // Small variance in length removes static-length DPI signal.
  const targetLen = 100 + randomInt(0, 121); // total UDP body 100..220
  const headerLen = 20; // STUN header
  const fpLen = 8; // FINGERPRINT attr (header+value)
  const padNeeded = Math.max(0, targetLen - headerLen - baseAttrs.length - fpLen);
  // Padding attribute value must be 4-byte aligned by stunAttr; choose multiple of 4.
  const padBytes = padNeeded > 0 ? stunAttr(0x0026, randomBytes(padNeeded - (padNeeded % 4))) : Buffer.alloc(0);

  const attrs = concat(baseAttrs, padBytes);
  const msgLen = attrs.length + fpLen;
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

/**
 * GREASE values per RFC 8701: reserved 0x?A?A pattern in cipher/extension/version slots.
 * Real Chrome/Firefox always insert these to keep middleboxes honest about unknown TLS values.
 * Their presence is itself a fingerprint marker — absence flags the client as non-browser.
 */
const TLS_GREASE_VALUES = [
  0x0a0a, 0x1a1a, 0x2a2a, 0x3a3a, 0x4a4a, 0x5a5a, 0x6a6a, 0x7a7a,
  0x8a8a, 0x9a9a, 0xaaaa, 0xbaba, 0xcaca, 0xdada, 0xeaea, 0xfafa,
];
const pickGrease = () => TLS_GREASE_VALUES[randomInt(0, TLS_GREASE_VALUES.length)];

/** TLS record + handshake wrapping for a finished ClientHello body. */
const wrapTlsRecord = (chBody) => {
  const chLen = chBody.length;
  const handshake = concat(
    u8(0x01),
    u8((chLen >> 16) & 0xff), u8((chLen >> 8) & 0xff), u8(chLen & 0xff),
    chBody,
  );
  return concat(u8(0x16), u16be(0x0301), u16be(handshake.length), handshake);
};

/** Target ClientHello body size — Chrome aligns to 512 boundary via padding extension. */
const TLS_PADDED_TARGET = 512;

const generateTlsPayload = () => {
  const host = TLS_HOSTS[randomInt(0, TLS_HOSTS.length)];
  const clientRandom = randomBytes(32);
  const sessionId = randomBytes(32);
  const greaseCipher = pickGrease();
  const greaseExt = pickGrease();
  const greaseGroup = pickGrease();
  const greaseVersion = pickGrease();

  // SNI extension (0x0000)
  const hostBuf = Buffer.from(host, 'ascii');
  const sniEntry = concat(u8(0), u16be(hostBuf.length), hostBuf);
  const sniList = concat(u16be(sniEntry.length), sniEntry);
  const sniExt = tlsExt(0x0000, sniList);

  // supported_versions (0x002b): GREASE + TLS 1.3 + 1.2
  const versExt = tlsExt(0x002b, concat(u8(6), u16be(greaseVersion), u16be(0x0304), u16be(0x0303)));

  // supported_groups (0x000a): GREASE + x25519 + secp256r1
  const groupsExt = tlsExt(0x000a, concat(u16be(6), u16be(greaseGroup), u16be(0x001d), u16be(0x0017)));

  // ALPN (0x0010): h2, http/1.1
  const h2 = concat(u8(2), Buffer.from('h2'));
  const http11 = concat(u8(8), Buffer.from('http/1.1'));
  const alpnList = concat(u16be(h2.length + http11.length), h2, http11);
  const alpnExt = tlsExt(0x0010, alpnList);

  // signature_algorithms (0x000d): RSA-PSS-RSAE/SHA256, ECDSA-SHA256, RSA-PKCS1-SHA256
  const sigAlgs = tlsExt(0x000d, concat(u16be(8), u16be(0x0804), u16be(0x0403), u16be(0x0807), u16be(0x0401)));

  // psk_key_exchange_modes (0x002d): psk_dhe_ke (1)
  const pskModes = tlsExt(0x002d, concat(u8(1), u8(1)));

  // ec_point_formats (0x000b): uncompressed
  const ecPoints = tlsExt(0x000b, concat(u8(1), u8(0)));

  // extended_master_secret (0x0017): empty
  const ems = tlsExt(0x0017, Buffer.alloc(0));

  // renegotiation_info (0xff01): empty (1 byte length=0)
  const renegoInfo = tlsExt(0xff01, u8(0));

  // session_ticket (0x0023): empty
  const sessionTicket = tlsExt(0x0023, Buffer.alloc(0));

  // status_request (0x0005): OCSP, status_type=1, responder_id_list=0, request_extensions=0
  const statusReq = tlsExt(0x0005, concat(u8(1), u16be(0), u16be(0)));

  // signed_certificate_timestamp (0x0012): empty
  const sct = tlsExt(0x0012, Buffer.alloc(0));

  // key_share (0x0033): GREASE (1-byte placeholder) + x25519 with real pub key
  const greaseKsEntry = concat(u16be(greaseGroup), u16be(1), u8(0));
  const x25519Pub = randomBytes(32);
  const ksEntry = concat(u16be(0x001d), u16be(32), x25519Pub);
  const ksList = concat(greaseKsEntry, ksEntry);
  const ksExt = tlsExt(0x0033, concat(u16be(ksList.length), ksList));

  // Two GREASE extensions (Chrome puts GREASE at start AND end of ext list)
  const greaseExtFirst = tlsExt(greaseExt, Buffer.alloc(0));
  const greaseExtLast = tlsExt(pickGrease(), u8(0));

  // Mid extensions in randomized order (Chrome shuffles non-anchor extensions)
  const midExts = [sniExt, sigAlgs, pskModes, ecPoints, ems, renegoInfo, sessionTicket, statusReq, sct, alpnExt, versExt, groupsExt];
  for (let i = midExts.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [midExts[i], midExts[j]] = [midExts[j], midExts[i]];
  }

  // Compose initial extensions (without padding) to compute padding size.
  const fixedExts = concat(greaseExtFirst, ...midExts, ksExt, greaseExtLast);

  // ClientHello body shell (without padding ext) — used to compute final padding length.
  // Cipher suites: GREASE + TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256
  const ciphers = concat(u16be(greaseCipher), u16be(0x1301), u16be(0x1302), u16be(0x1303));
  const beforePad = concat(
    u16be(0x0303),
    clientRandom,
    u8(sessionId.length), sessionId,
    u16be(ciphers.length), ciphers,
    u8(1), u8(0),
    u16be(fixedExts.length), // placeholder, real length depends on padding ext
  );

  // padding ext header (4 bytes) + value bytes; choose value size so final body ≈ TLS_PADDED_TARGET.
  // Final ext-block length = fixedExts.length + 4 + padValueLen.
  // Final ch body = beforePad.length (without ext-len rewrite) + extBlockLen (we redo concat below).
  const baseBodyNoExtLen = beforePad.length - 2; // strip the 2-byte placeholder ext-len
  const targetExtBlockLen = Math.max(fixedExts.length, TLS_PADDED_TARGET - baseBodyNoExtLen - 2);
  const padValueLen = Math.max(0, targetExtBlockLen - fixedExts.length - 4);
  const paddingExt = tlsExt(0x0015, Buffer.alloc(padValueLen, 0));

  const extensions = concat(greaseExtFirst, ...midExts, ksExt, greaseExtLast, paddingExt);

  const chBody = concat(
    u16be(0x0303),
    clientRandom,
    u8(sessionId.length), sessionId,
    u16be(ciphers.length), ciphers,
    u8(1), u8(0),
    u16be(extensions.length), extensions,
  );

  return wrapTlsRecord(chBody);
};

// ── DTLS 1.2 ClientHello ──────────────────────────────────────
// DTLS = TLS over UDP. Same handshake structure as TLS but record header carries
// epoch+seqnum, handshake header carries fragment offset/length.
// DPI-realistic since WebRTC always uses DTLS 1.2 for SRTP key derivation.

const generateDtlsPayload = () => {
  const host = TLS_HOSTS[randomInt(0, TLS_HOSTS.length)];
  const clientRandom = randomBytes(32);
  const sessionId = Buffer.alloc(0); // DTLS often empty
  const cookie = Buffer.alloc(0); // first ClientHello has no cookie (server sends HelloVerifyRequest)

  const hostBuf = Buffer.from(host, 'ascii');
  const sniEntry = concat(u8(0), u16be(hostBuf.length), hostBuf);
  const sniList = concat(u16be(sniEntry.length), sniEntry);
  const sniExt = tlsExt(0x0000, sniList);

  // supported_groups: x25519, P-256
  const groupsExt = tlsExt(0x000a, concat(u16be(4), u16be(0x001d), u16be(0x0017)));
  const ecPoints = tlsExt(0x000b, concat(u8(1), u8(0)));

  // use_srtp (0x000e): SRTP_AEAD_AES_128_GCM (0x0007), MKI=0
  const useSrtp = tlsExt(0x000e, concat(u16be(2), u16be(0x0007), u8(0)));

  // signature_algorithms
  const sigAlgs = tlsExt(0x000d, concat(u16be(6), u16be(0x0403), u16be(0x0804), u16be(0x0401)));

  // extended_master_secret
  const ems = tlsExt(0x0017, Buffer.alloc(0));

  const extensions = concat(sniExt, groupsExt, ecPoints, useSrtp, sigAlgs, ems);

  // DTLS 1.2 cipher suites for WebRTC: ECDHE-ECDSA-AES128-GCM, ECDHE-RSA-AES128-GCM
  const ciphers = concat(u16be(0xc02b), u16be(0xc02f), u16be(0xc00a), u16be(0xc014));

  const chBody = concat(
    u16be(0xfefd),               // DTLS version 1.2
    clientRandom,
    u8(sessionId.length), sessionId,
    u8(cookie.length), cookie,
    u16be(ciphers.length), ciphers,
    u8(1), u8(0),                // compression: null
    u16be(extensions.length), extensions,
  );

  // DTLS handshake header: type, total length (3 bytes), msg_seq (2), fragment_offset (3), fragment_length (3) + body
  const chLen = chBody.length;
  const handshake = concat(
    u8(0x01),                                                                       // ClientHello
    u8((chLen >> 16) & 0xff), u8((chLen >> 8) & 0xff), u8(chLen & 0xff),             // total length
    u16be(0),                                                                        // message_seq
    u8(0), u8(0), u8(0),                                                             // fragment_offset = 0
    u8((chLen >> 16) & 0xff), u8((chLen >> 8) & 0xff), u8(chLen & 0xff),             // fragment_length = total length
    chBody,
  );

  // DTLS record header: ContentType=22 (Handshake), version=0xfefd, epoch=0, seqnum=0, length, fragment
  const epochAndSeq = Buffer.alloc(8, 0); // 2-byte epoch + 6-byte sequence number
  return concat(u8(0x16), u16be(0xfefd), epochAndSeq, u16be(handshake.length), handshake);
};

// ── QUIC Initial (plaintext, no encryption) ───────────────────
// Produces a valid-looking QUIC Initial packet with a TLS ClientHello
// inside a CRYPTO frame. Not RFC-9001-encrypted (no secret derivation)
// but structurally correct and sufficient for DPI camouflage.

const QUIC_VERSION = 0x00000001; // QUIC v1

/**
 * QUIC variable-length integer per RFC 9000 §16.
 * Two-bit prefix encodes the byte length (1, 2, 4, or 8 bytes), so the value range is:
 *   00b → 6-bit  (0..63)
 *   01b → 14-bit (0..16383)
 *   10b → 30-bit (0..2^30 − 1)
 *   11b → 62-bit (0..2^62 − 1)
 *
 * Previous implementation only handled 1/2/4-byte forms, and the 4-byte branch used
 * `n | 0x80000000` which produces a sign-flipped 32-bit value when n ≥ 2^30 — making
 * any payload length ≥ 1 GiB encoded as a malformed QUIC packet. Realistic CPS payloads
 * never reach that range, but the function should be correct regardless.
 */
const varInt = (n) => {
  if (n < 0) throw new RangeError(`varInt: negative value ${n}`);
  if (n < 64) return u8(n);
  if (n < 16384) return u16be(n | 0x4000);
  if (n < 0x40000000) return u32be((n | 0x80000000) >>> 0);
  // 8-byte form: top 2 bits = 11b, remaining 62 bits hold the value.
  // Use BigInt to avoid 53-bit-precision loss on values > 2^53.
  if (n > Number.MAX_SAFE_INTEGER) throw new RangeError(`varInt: ${n} exceeds safe integer`);
  const bn = BigInt(n) | 0xc000000000000000n;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(bn);
  return buf;
};

const generateQuicPayload = () => {
  const host = TLS_HOSTS[randomInt(0, TLS_HOSTS.length)];
  const dcid = randomBytes(8);
  const scid = randomBytes(8);
  const pktNum = randomInt(0, 256);

  // Build TLS ClientHello (reuse same logic, QUIC variant has no TLS record wrapper)
  const clientRandom = randomBytes(32);

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

  // Pad to a realistic QUIC Initial size, but stay under PAYLOAD_MAX_BYTES (1000B AmneziaWG cap).
  // Real QUIC Initial packets target 1200B, but the AmneziaWG splitPad ceiling enforces 1000B/tag.
  // Total wire size = header (~24B) + payload, so target payload ≈ 940B leaves headroom.
  const targetPayloadLen = 900 + randomInt(0, 41); // 900..940 — varies length, evades static signature
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

const AUTO_PROTOCOLS = ['quic', 'dns', 'stun', 'tls', 'dtls', 'sip'];

const toHex = (buf) => `<b 0x${buf.toString('hex')}>`;

/**
 * Generate a CPS payload for the given protocol key.
 * Returns a string ready for `I1 = ` in the config.
 * All binary protocols are capped at PAYLOAD_MAX_BYTES per the AmneziaWG splitPad limit.
 * @param {string} protocol  auto | quic | dns | stun | tls | dtls | sip | static
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
  if (key === 'quic')      buf = generateQuicPayload();
  else if (key === 'dns')  buf = generateDnsPayload();
  else if (key === 'stun') buf = generateStunPayload();
  else if (key === 'tls')  buf = generateTlsPayload();
  else if (key === 'dtls') buf = generateDtlsPayload();
  else {
    const picked = AUTO_PROTOCOLS[randomInt(0, AUTO_PROTOCOLS.length)];
    return generateCpsPayload(picked);
  }

  return toHex(capPayload(buf, key));
};

module.exports = { generateCpsPayload, PAYLOAD_MAX_BYTES };
