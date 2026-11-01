// __tests__/route-budget.test.js
// Route budget of a split config (3.1.9, spec R6 4.3, T-B1…T-B3): one limit, "over" only above it (DECISIONS No. 31),
// "warn" from 80 % up to the limit itself, and a fixed English warning that names the three numbers. The server
// never refuses over the budget (DECISIONS No. 30); /api/warp adds the warning line.

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { ROUTE_LIMIT, WARN_RATIO, classifyBudget, routeBudgetWarning } = require('../src/server/routeBudget');

describe('route budget', () => {
  test('T-B1 the limit is 1000 IPv4 routes, the warning ratio 0.8 (PRD FR-15; DECISIONS No. 29: 1000 until G4)', () => {
    assert.equal(ROUTE_LIMIT, 1000);
    assert.equal(WARN_RATIO, 0.8);
  });

  test('T-B2 boundaries at the default limit: 799 ok, 800 warn, 1000 warn, 1001 over', () => {
    assert.deepEqual([0, 799, 800, 999, 1000, 1001, 5000].map((n) => classifyBudget(n)),
      ['ok', 'ok', 'warn', 'warn', 'warn', 'over', 'over']);
  });

  test('T-B2 boundaries at limit 10: 7 ok, 8 warn, 10 warn, 11 over', () => {
    assert.deepEqual([7, 8, 10, 11].map((n) => classifyBudget(n, 10)), ['ok', 'warn', 'warn', 'over']);
  });

  test('T-B3 the warning names the routes in AllowedIPs, the routes of the source lists and the limit', () => {
    const text = routeBudgetWarning({ before4: 998, after4: 1007 });
    assert.ok(text.startsWith('Route budget: '), text);
    assert.match(text, /\b1007\b/);
    assert.match(text, /\b998\b/);
    assert.match(text, /\b1000\b/);
    assert.equal(routeBudgetWarning({ before4: 30, after4: 12, limit: 10 }),
      'Route budget: 12 IPv4 routes in AllowedIPs (30 in the source lists) is above the limit of 10; phones and routers may handle a list this long unstably.');
  });
});
