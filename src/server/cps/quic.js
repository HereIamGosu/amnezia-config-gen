'use strict';

const { createCipheriv, createDecipheriv, createHmac, randomBytes } = require('node:crypto');

const QUIC_V1_INITIAL_SALT = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');
const MAX_VARINT = (1n << 62n) - 1n;

const u16 = (value) => {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
};
const u24 = (value) => Buffer.from([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const u32 = (value) => {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value >>> 0);
  return result;
};

const encodeQuicVarInt = (input) => {
  const value = typeof input === 'bigint' ? input : BigInt(input);
  if (value < 0n || value > MAX_VARINT) throw new RangeError(`QUIC varint out of range: ${value}`);
  if (value < 64n) return Buffer.from([Number(value)]);
  if (value < 16384n) {
    const result = Buffer.alloc(2);
    result.writeUInt16BE(Number(value | 0x4000n));
    return result;
  }
  if (value < (1n << 30n)) {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(Number(value | 0x80000000n));
    return result;
  }
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(value | 0xc000000000000000n);
  return result;
};

const decodeQuicVarInt = (buffer, offset = 0) => {
  const bytes = 1 << (buffer[offset] >> 6);
  if (offset + bytes > buffer.length) throw new RangeError('Truncated QUIC varint');
  let value = BigInt(buffer[offset] & 0x3f);
  for (let index = 1; index < bytes; index += 1) value = (value << 8n) | BigInt(buffer[offset + index]);
  return { value, bytes };
};

const hkdfExtract = (salt, inputKeyMaterial) => createHmac('sha256', salt).update(inputKeyMaterial).digest();
const hkdfExpand = (pseudoRandomKey, info, length) => {
  const blocks = [];
  let previous = Buffer.alloc(0);
  let generated = 0;
  for (let counter = 1; generated < length; counter += 1) {
    previous = createHmac('sha256', pseudoRandomKey)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    blocks.push(previous);
    generated += previous.length;
  }
  return Buffer.concat(blocks).subarray(0, length);
};
const hkdfExpandLabel = (secret, label, length) => {
  const fullLabel = Buffer.from(`tls13 ${label}`, 'ascii');
  const info = Buffer.concat([u16(length), Buffer.from([fullLabel.length]), fullLabel, Buffer.from([0])]);
  return hkdfExpand(secret, info, length);
};

const deriveInitialSecrets = (dcid) => {
  const initialSecret = hkdfExtract(QUIC_V1_INITIAL_SALT, dcid);
  const clientInitialSecret = hkdfExpandLabel(initialSecret, 'client in', 32);
  return {
    initialSecret,
    clientInitialSecret,
    key: hkdfExpandLabel(clientInitialSecret, 'quic key', 16),
    iv: hkdfExpandLabel(clientInitialSecret, 'quic iv', 12),
    hp: hkdfExpandLabel(clientInitialSecret, 'quic hp', 16),
  };
};

const tlsExtension = (type, value) => Buffer.concat([u16(type), u16(value.length), value]);
const transportParameter = (id, value) => {
  const encoded = encodeQuicVarInt(value);
  return Buffer.concat([encodeQuicVarInt(id), encodeQuicVarInt(encoded.length), encoded]);
};

const buildClientHello = ({ clientRandom, keyShare, serverName }) => {
  const host = Buffer.from(serverName, 'ascii');
  const serverNameEntry = Buffer.concat([Buffer.from([0]), u16(host.length), host]);
  const extensions = Buffer.concat([
    tlsExtension(0x0000, Buffer.concat([u16(serverNameEntry.length), serverNameEntry])),
    tlsExtension(0x002b, Buffer.concat([Buffer.from([2]), u16(0x0304)])),
    tlsExtension(0x000a, Buffer.concat([u16(2), u16(0x001d)])),
    tlsExtension(0x000d, Buffer.concat([u16(6), u16(0x0804), u16(0x0403), u16(0x0807)])),
    tlsExtension(0x0033, Buffer.concat([u16(36), u16(0x001d), u16(32), keyShare])),
    tlsExtension(0x0039, Buffer.concat([
      transportParameter(0x01, 30000),
      transportParameter(0x04, 1048576),
    ])),
  ]);
  const body = Buffer.concat([
    u16(0x0303), clientRandom, Buffer.from([0]),
    u16(2), u16(0x1301), Buffer.from([1, 0]),
    u16(extensions.length), extensions,
  ]);
  return Buffer.concat([Buffer.from([1]), u24(body.length), body]);
};

const packetNonce = (iv, packetNumber) => {
  const nonce = Buffer.from(iv);
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(packetNumber));
  for (let index = 0; index < encoded.length; index += 1) nonce[nonce.length - encoded.length + index] ^= encoded[index];
  return nonce;
};
const headerProtectionMask = (hp, sample) => {
  const cipher = createCipheriv('aes-128-ecb', hp, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(sample), cipher.final()]).subarray(0, 5);
};

const buildQuicInitial = (options = {}) => {
  const dcid = Buffer.from(options.dcid || randomBytes(8));
  const scid = Buffer.from(options.scid || randomBytes(8));
  const packetNumber = BigInt(options.packetNumber ?? 0);
  const packetNumberLength = 2;
  const targetLength = options.targetLength ?? 1200;
  if (packetNumber < 0n || packetNumber > 0xffffn) throw new RangeError('Packet number must fit two bytes');
  const clientHello = buildClientHello({
    clientRandom: Buffer.from(options.clientRandom || randomBytes(32)),
    keyShare: Buffer.from(options.keyShare || randomBytes(32)),
    serverName: options.serverName || 'cloudflare.com',
  });
  const cryptoFrame = Buffer.concat([
    Buffer.from([0x06]), encodeQuicVarInt(0), encodeQuicVarInt(clientHello.length), clientHello,
  ]);
  const prefix = Buffer.concat([
    Buffer.from([0xc0 | (packetNumberLength - 1)]), u32(1),
    Buffer.from([dcid.length]), dcid,
    Buffer.from([scid.length]), scid,
    encodeQuicVarInt(0),
  ]);

  let lengthField = encodeQuicVarInt(packetNumberLength + cryptoFrame.length + 16);
  let plaintextLength = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    plaintextLength = targetLength - prefix.length - lengthField.length - packetNumberLength - 16;
    if (plaintextLength < cryptoFrame.length) throw new RangeError('QUIC targetLength is too small for ClientHello');
    lengthField = encodeQuicVarInt(packetNumberLength + plaintextLength + 16);
  }
  const plaintext = Buffer.concat([cryptoFrame, Buffer.alloc(plaintextLength - cryptoFrame.length)]);
  const packetNumberBytes = Buffer.alloc(packetNumberLength);
  packetNumberBytes.writeUIntBE(Number(packetNumber), 0, packetNumberLength);
  const header = Buffer.concat([prefix, lengthField, packetNumberBytes]);
  const secrets = deriveInitialSecrets(dcid);
  const cipher = createCipheriv('aes-128-gcm', secrets.key, packetNonce(secrets.iv, packetNumber));
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const packet = Buffer.concat([header, ciphertext]);
  const packetNumberOffset = prefix.length + lengthField.length;
  const mask = headerProtectionMask(secrets.hp, packet.subarray(packetNumberOffset + 4, packetNumberOffset + 20));
  packet[0] ^= mask[0] & 0x0f;
  for (let index = 0; index < packetNumberLength; index += 1) packet[packetNumberOffset + index] ^= mask[index + 1];
  return { packet, plaintext, clientHello, dcid, scid, packetNumber };
};

const unprotectQuicInitial = (protectedPacket) => {
  const packet = Buffer.from(protectedPacket);
  let offset = 5;
  const dcidLength = packet[offset++];
  const dcid = packet.subarray(offset, offset + dcidLength);
  offset += dcidLength;
  const scidLength = packet[offset++];
  const scid = packet.subarray(offset, offset + scidLength);
  offset += scidLength;
  const tokenLength = decodeQuicVarInt(packet, offset);
  offset += tokenLength.bytes + Number(tokenLength.value);
  const payloadLength = decodeQuicVarInt(packet, offset);
  offset += payloadLength.bytes;
  const packetNumberOffset = offset;
  const secrets = deriveInitialSecrets(dcid);
  const mask = headerProtectionMask(secrets.hp, packet.subarray(packetNumberOffset + 4, packetNumberOffset + 20));
  const firstByte = packet[0] ^ (mask[0] & 0x0f);
  const packetNumberLength = (firstByte & 0x03) + 1;
  const packetNumberBytes = Buffer.alloc(packetNumberLength);
  for (let index = 0; index < packetNumberLength; index += 1) {
    packetNumberBytes[index] = packet[packetNumberOffset + index] ^ mask[index + 1];
  }
  let packetNumber = 0n;
  for (const byte of packetNumberBytes) packetNumber = (packetNumber << 8n) | BigInt(byte);
  const header = Buffer.concat([Buffer.from([firstByte]), packet.subarray(1, packetNumberOffset), packetNumberBytes]);
  const encryptedLength = Number(payloadLength.value) - packetNumberLength;
  const encrypted = packet.subarray(packetNumberOffset + packetNumberLength, packetNumberOffset + packetNumberLength + encryptedLength);
  const decipher = createDecipheriv('aes-128-gcm', secrets.key, packetNonce(secrets.iv, packetNumber));
  decipher.setAAD(header);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  return { plaintext, packetNumber, dcid: Buffer.from(dcid), scid: Buffer.from(scid), firstByte };
};

module.exports = {
  QUIC_V1_INITIAL_SALT,
  buildQuicInitial,
  decodeQuicVarInt,
  deriveInitialSecrets,
  encodeQuicVarInt,
  unprotectQuicInitial,
};
