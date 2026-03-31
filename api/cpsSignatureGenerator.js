'use strict';

const { randomBytes, randomInt } = require('crypto');

/** CPS `<r N>`: N ≤ 1000 per AmneziaWG 2.0 spec. */
const MAX_R = 1000;
/** CPS `<rc N>` / `<rd N>`: N ≤ 1000. */
const MAX_RC_RD = 1000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const tagB = (byteLength) => {
  const len = clamp(byteLength, 1, 64);
  const buf = randomBytes(len);
  return `<b 0x${buf.toString('hex')}>`;
};

const tagT = () => '<t>';

const tagR = (n) => {
  const k = clamp(n, 1, MAX_R);
  return `<r ${k}>`;
};

const tagRc = (n) => {
  const k = clamp(n, 1, MAX_RC_RD);
  return `<rc ${k}>`;
};

const tagRd = (n) => {
  const k = clamp(n, 1, MAX_RC_RD);
  return `<rd ${k}>`;
};

/**
 * Build five CPS signature packet descriptions (i1–i5) for AmneziaWG 2.0.
 * Uses protocol-shaped static prefixes (QUIC Initial v1, DNS-like, STUN magic) plus <t>, <r>, <rc>, <rd>.
 * Values change on each call (fresh entropy for every generated config).
 * @returns {{ i1: string, i2: string, i3: string, i4: string, i5: string }}
 */
const generateSignatureChain = () => {
  const i1 = `<b 0xc700000001>${tagRc(randomInt(6, 14))}${tagT()}${tagR(randomInt(56, 181))}`;
  const i2 = `${tagB(randomInt(8, 25))}${tagT()}${tagRc(randomInt(14, 34))}${tagR(randomInt(48, 151))}`;
  const i3 = `${tagB(4)}${tagRd(randomInt(6, 18))}${tagT()}${tagR(randomInt(40, 131))}`;
  const i4 = `<b 0x2112a442>${tagR(randomInt(12, 39))}${tagT()}${tagRc(randomInt(10, 27))}${tagR(randomInt(32, 111))}`;
  const i5 = `${tagRd(randomInt(10, 23))}${tagT()}${tagB(randomInt(4, 15))}${tagR(randomInt(36, 121))}`;
  return { i1, i2, i3, i4, i5 };
};

module.exports = {
  generateSignatureChain,
  MAX_R,
  MAX_RC_RD,
};
