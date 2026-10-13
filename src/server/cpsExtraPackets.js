'use strict';

const { randomBytes, randomInt } = require('crypto');

/**
 * I2..I5 for `cps5=1`: concealment packets the client sends after I1, before Jc junk and the
 * handshake initiation, on every initiation attempt (amneziawg-go `SendHandshakeInitiation`).
 *
 * Each field is a CPS chain of runtime tags, so most of its bytes change per handshake:
 *   <r N> — N random bytes, regenerated on every send;
 *   <t>   — unix timestamp, regenerated on every send (8 bytes in v0.2.13–v0.2.15, 4 in v0.2.16+);
 *   <b 0x…> — short fixed bytes chosen here, once per config.
 *
 * Only b/r/t: amneziawg-go v0.2.13 (1abd24b) rejects `<rc>`/`<rd>` with `invalid tag` and the whole
 * config fails to apply; they appeared in v0.2.15 (f654220). v0.2.13 also caps `<r>` at 1000 and allows
 * one `<t>` per field. Source audit: docs/research/cps-runtime-tags-audit.md.
 */
const tagB = (len) => `<b 0x${randomBytes(len).toString('hex')}>`;
const tagR = (min, max) => `<r ${randomInt(min, max + 1)}>`;
const tagT = () => '<t>';

/** Different shape per field; fixed `<b>` bytes stay a minority of each packet. */
const TEMPLATES = Object.freeze({
  I2: () => `${tagB(randomInt(4, 9))}${tagT()}${tagR(48, 120)}`,
  I3: () => `${tagR(8, 24)}${tagB(randomInt(2, 5))}${tagR(40, 96)}`,
  I4: () => `${tagT()}${tagR(24, 64)}${tagB(randomInt(3, 7))}${tagR(16, 48)}`,
  I5: () => `${tagB(randomInt(6, 13))}${tagR(64, 140)}`,
});

/** @returns {{ I2: string, I3: string, I4: string, I5: string }} */
const generateI2I5 = () => ({
  I2: TEMPLATES.I2(),
  I3: TEMPLATES.I3(),
  I4: TEMPLATES.I4(),
  I5: TEMPLATES.I5(),
});

module.exports = { generateI2I5 };
