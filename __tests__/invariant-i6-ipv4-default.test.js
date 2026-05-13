const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isIpv4Cidr, fetchCidrsForDomains } = require('../api/ipListFetch');

describe('Invariant I6: IPv4-only by default', () => {
  test('isIpv4Cidr correctly identifies IPv4 vs IPv6 CIDRs', () => {
    assert.equal(isIpv4Cidr('1.2.3.4/24'), true);
    assert.equal(isIpv4Cidr('192.168.0.0/16'), true);
    assert.equal(isIpv4Cidr('10.0.0.0/8'), true);
    assert.equal(isIpv4Cidr('2606:4700::/32'), false);
    assert.equal(isIpv4Cidr('::1/128'), false);
    assert.equal(isIpv4Cidr('not-a-cidr'), false);
    assert.equal(isIpv4Cidr(''), false);
  });

  test('fetchCidrsForDomains([]) returns empty without network call (sanity)', async () => {
    const result = await fetchCidrsForDomains([]);
    assert.deepEqual(result, { cidrs: [], source: 'opencck' });
  });

  test('fetchCidrsForDomains is a function with default options shape', () => {
    assert.equal(typeof fetchCidrsForDomains, 'function');
    // .length is the count of params before defaults; 1 means second param has a default {}
    assert.equal(fetchCidrsForDomains.length, 1);
  });
});
