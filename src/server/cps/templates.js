'use strict';

const FIXED_BYTES_TAG_LIMIT = 1000;

const fixedBytesTemplate = (value, chunkSize = FIXED_BYTES_TAG_LIMIT) => {
  const buffer = Buffer.from(value);
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError('chunkSize must be a positive integer');
  const tags = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    tags.push(`<b 0x${buffer.subarray(offset, offset + chunkSize).toString('hex')}>`);
  }
  return tags.join('');
};

const parseFixedBytesTemplate = (template) => {
  const chunks = [...String(template).matchAll(/<b 0x([0-9a-f]*)>/gi)]
    .map((match) => Buffer.from(match[1], 'hex'));
  if (chunks.length === 0) throw new Error('Template contains no fixed-byte tags');
  return Buffer.concat(chunks);
};

module.exports = { FIXED_BYTES_TAG_LIMIT, fixedBytesTemplate, parseFixedBytesTemplate };
