'use strict';

/**
 * Strict parser for the I2..I5 chains the generator emits. It accepts the intersection of
 * amneziawg-go v0.2.13 `device/awg/tag_parser.go` and master `device/obf.go`:
 * only `<b 0x…>`, `<r N>` (1..1000) and one `<t>` per field, no text between tags.
 * Throws on anything else.
 * @returns {{ tags: { name: string, param: string }[], fixedBytes: number, runtimeBytes: number }}
 */
const parseCompatChain = (value) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error('empty chain');
  const tags = [];
  const rest = value.replace(/<([a-z]+)(?: ([^<>]+))?>/g, (_, name, param = '') => {
    tags.push({ name, param });
    return '';
  });
  if (rest !== '') throw new Error(`text outside tags: ${JSON.stringify(rest)}`);
  let fixedBytes = 0;
  let runtimeBytes = 0;
  let timestamps = 0;
  for (const { name, param } of tags) {
    if (name === 'b') {
      if (!/^0x(?:[0-9a-f]{2})+$/.test(param)) throw new Error(`bad <b> param: ${param}`);
      fixedBytes += (param.length - 2) / 2;
    } else if (name === 'r') {
      if (!/^[1-9][0-9]*$/.test(param) || Number(param) > 1000) throw new Error(`bad <r> param: ${param}`);
      runtimeBytes += Number(param);
    } else if (name === 't') {
      if (param !== '') throw new Error('<t> takes no param');
      timestamps += 1;
      runtimeBytes += 4; // 4 bytes in v0.2.16+, 8 in v0.2.13–v0.2.15
    } else {
      throw new Error(`tag outside the compat set: <${name}>`);
    }
  }
  if (timestamps > 1) throw new Error('more than one <t> (v0.2.13 rejects it)');
  if (!tags.some((t) => t.name === 'r' || t.name === 't')) throw new Error('no runtime tag');
  return { tags, fixedBytes, runtimeBytes };
};

/** Tag-name sequence with params dropped, e.g. `b,t,r`. */
const chainShape = (value) => parseCompatChain(value).tags.map((t) => t.name).join(',');

module.exports = { parseCompatChain, chainShape };
