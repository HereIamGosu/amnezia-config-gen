'use strict';

const RANGE_EXPECTED = 'single integer or min-max range';

class AwgRangeValidationError extends Error {
  constructor(field) {
    super(`Invalid ${field} range.`);
    this.name = 'AwgRangeValidationError';
    this.statusCode = 400;
    this.expected = RANGE_EXPECTED;
  }
}

const parseAwgRange = (value, options = {}) => {
  const {
    field = 'AWG',
    min = 0,
    max = 65535,
    allowOff = false,
    allowSingle = true,
  } = options;
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (allowOff && raw.toLowerCase() === 'off') return 'off';

  const single = /^\d+$/.exec(raw);
  if (single) {
    const parsed = Number(raw);
    if (!allowSingle || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new AwgRangeValidationError(field);
    }
    return String(parsed);
  }

  const range = /^(\d+)-(\d+)$/.exec(raw);
  if (!range) throw new AwgRangeValidationError(field);
  const lower = Number(range[1]);
  const upper = Number(range[2]);
  if (
    !Number.isSafeInteger(lower) ||
    !Number.isSafeInteger(upper) ||
    lower < min || upper > max || lower > upper
  ) {
    throw new AwgRangeValidationError(field);
  }
  return `${lower}-${upper}`;
};

module.exports = { AwgRangeValidationError, RANGE_EXPECTED, parseAwgRange };
