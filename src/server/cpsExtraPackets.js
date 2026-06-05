const { randomBytes, randomInt } = require('crypto');

/**
 * AmneziaWG 2.0 spec: I2..I5 are concealment packets sent before each handshake
 * (after I1, in order I1→I5). Their purpose is to add entropy through random/counter/
 * timestamp data so DPI cannot fingerprint a constant-shape pre-handshake noise pattern.
 *
 * We generate fixed-shape random hex of 16..64 bytes per packet, wrapped in
 * `<b 0x...>` notation matching I1 format used by api/warpCpsPayloads.js.
 */
const I_MIN_BYTES = 16;
const I_MAX_BYTES = 64;

const generateExtraCpsPacket = () => {
  const len = randomInt(I_MIN_BYTES, I_MAX_BYTES + 1);
  return `<b 0x${randomBytes(len).toString('hex')}>`;
};

/** @returns {{ I2: string, I3: string, I4: string, I5: string }} */
const generateI2I5 = () => ({
  I2: generateExtraCpsPacket(),
  I3: generateExtraCpsPacket(),
  I4: generateExtraCpsPacket(),
  I5: generateExtraCpsPacket(),
});

module.exports = { generateI2I5, generateExtraCpsPacket };
