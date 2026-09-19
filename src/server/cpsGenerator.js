'use strict';

const { randomBytes, randomInt } = require('node:crypto');
const { generateDnsTemplate } = require('./cps/dns');
const { AUTO_PROTOCOLS, getCpsProtocol, validateCpsProtocol } = require('./cps/protocols');
const { buildQuicInitial } = require('./cps/quic');
const { fixedBytesTemplate } = require('./cps/templates');
const { generateSipCpsPair, pickRandomCpsPayload } = require('./warpCpsPayloads');

const u8 = (value) => Buffer.from([value & 0xff]);
const u16 = (value) => { const result = Buffer.alloc(2); result.writeUInt16BE(value & 0xffff); return result; };
const u32 = (value) => { const result = Buffer.alloc(4); result.writeUInt32BE(value >>> 0); return result; };
const concat = (...values) => Buffer.concat(values);

const crc32 = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value;
  }
  return (buffer) => {
    let checksum = 0xffffffff;
    for (const byte of buffer) checksum = table[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
    return (checksum ^ 0xffffffff) >>> 0;
  };
})();

const stunAttribute = (type, value) => {
  const padding = Buffer.alloc((4 - (value.length % 4)) % 4);
  return concat(u16(type), u16(value.length), value, padding);
};

const STUN_USERNAME_TEMPLATES = [
  () => `${randomBytes(4).toString('hex')}:${randomBytes(4).toString('hex')}`,
  () => `${randomBytes(3).toString('hex').toUpperCase()}/${randomBytes(2).toString('hex')}`,
  () => `wa-${randomInt(1000000000, 9999999999)}:${randomBytes(4).toString('hex')}`,
  () => `${randomInt(1700000000, 1900000000)}:${randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 12)}`,
];
const STUN_SOFTWARE_VALUES = ['libwebrtc', 'Cisco-libsrtp', 'pjnath', 'twilio-srtp', 'cloudflare-stun'];

const generateStunPayload = () => {
  const username = stunAttribute(0x0006, Buffer.from(STUN_USERNAME_TEMPLATES[randomInt(0, STUN_USERNAME_TEMPLATES.length)](), 'utf8'));
  const software = stunAttribute(0x8022, Buffer.from(STUN_SOFTWARE_VALUES[randomInt(0, STUN_SOFTWARE_VALUES.length)], 'utf8'));
  const priority = stunAttribute(0x0024, u32(randomInt(1000000, 2130706431)));
  const controlling = stunAttribute(0x802a, randomBytes(8));
  const candidate = stunAttribute(0x0025, Buffer.alloc(0));
  const baseAttributes = concat(software, username, priority, controlling, candidate);
  const targetLength = 100 + randomInt(0, 121);
  const paddingNeeded = Math.max(0, targetLength - 20 - baseAttributes.length - 8);
  const padding = paddingNeeded > 0
    ? stunAttribute(0x0026, randomBytes(paddingNeeded - (paddingNeeded % 4)))
    : Buffer.alloc(0);
  const attributes = concat(baseAttributes, padding);
  const messageLength = attributes.length + 8;
  const partial = concat(u16(0x0001), u16(messageLength), u32(0x2112a442), randomBytes(12), attributes);
  const fingerprint = stunAttribute(0x8028, u32((crc32(partial) ^ 0x5354554e) >>> 0));
  return concat(partial, fingerprint);
};

const tlsExtension = (type, value) => concat(u16(type), u16(value.length), value);
const generateDtlsPayload = () => {
  const host = Buffer.from('cloudflare.com', 'ascii');
  const serverName = concat(u8(0), u16(host.length), host);
  const extensions = concat(
    tlsExtension(0x0000, concat(u16(serverName.length), serverName)),
    tlsExtension(0x000a, concat(u16(4), u16(0x001d), u16(0x0017))),
    tlsExtension(0x000b, Buffer.from([1, 0])),
    tlsExtension(0x000e, concat(u16(2), u16(0x0007), u8(0))),
    tlsExtension(0x000d, concat(u16(6), u16(0x0403), u16(0x0804), u16(0x0401))),
    tlsExtension(0x0017, Buffer.alloc(0)),
  );
  const ciphers = concat(u16(0xc02b), u16(0xc02f), u16(0xc00a), u16(0xc014));
  const body = concat(
    u16(0xfefd), randomBytes(32), u8(0), u8(0),
    u16(ciphers.length), ciphers, u8(1), u8(0), u16(extensions.length), extensions,
  );
  const length = Buffer.from([(body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff]);
  const handshake = concat(u8(1), length, u16(0), Buffer.alloc(3), length, body);
  return concat(u8(0x16), u16(0xfefd), Buffer.alloc(8), u16(handshake.length), handshake);
};

const generators = Object.freeze({
  static: () => pickRandomCpsPayload(),
  sip: () => generateSipCpsPair().i1,
  stun: () => fixedBytesTemplate(generateStunPayload()),
  quic: () => fixedBytesTemplate(buildQuicInitial().packet),
  dns: () => generateDnsTemplate(),
  dtls: () => fixedBytesTemplate(generateDtlsPayload()),
});

const shuffledAutoProtocols = () => {
  const values = [...AUTO_PROTOCOLS];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = randomInt(0, index + 1);
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
};

const generateResolved = async (requested, resolved) => {
  const protocol = getCpsProtocol(resolved);
  return {
    value: await generators[resolved](),
    requested,
    resolved,
    stability: protocol.status,
  };
};

const generateCpsPayload = async (protocol = 'auto') => {
  const requested = validateCpsProtocol(protocol);
  if (requested !== 'auto') return generateResolved(requested, requested);

  const attempted = [];
  for (const resolved of shuffledAutoProtocols()) {
    attempted.push(resolved);
    try {
      return { ...(await generateResolved('auto', resolved)), attempted };
    } catch (_error) {
      // Each stable generator gets one bounded attempt; payload data is never logged.
    }
  }
  const error = new Error('All stable CPS generators failed');
  error.statusCode = 500;
  error.code = 'cps_generation_failed';
  error.attempted = attempted;
  throw error;
};

const generateCpsValue = async (protocol) => (await generateCpsPayload(protocol)).value;

module.exports = {
  crc32,
  generateCpsPayload,
  generateCpsValue,
  generateDtlsPayload,
  generateStunPayload,
};
