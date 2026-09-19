'use strict';

const DNS_NAMES = Object.freeze(['cloudflare.com', 'google.com', 'icloud.com']);

const u16 = (value) => {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
};

const u32 = (value) => {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
};

const encodeName = (name) => Buffer.concat([
  ...name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')])),
  Buffer.from([0]),
]);

const generateDnsTemplate = (name = DNS_NAMES[Math.floor(Math.random() * DNS_NAMES.length)]) => {
  const question = Buffer.concat([encodeName(name), u16(1), u16(1)]);
  const answer = Buffer.concat([u16(0xc00c), u16(1), u16(1), u32(300), u16(4), Buffer.from([1, 1, 1, 1])]);
  const body = Buffer.concat([u16(0x8180), u16(1), u16(1), u16(0), u16(0), question, answer]);
  return `<r 2><b 0x${body.toString('hex')}>`;
};

module.exports = { DNS_NAMES, generateDnsTemplate };
