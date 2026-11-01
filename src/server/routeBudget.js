// src/server/routeBudget.js
// Route budget of a split config (3.1.9, spec R6 4.3). One place for the limit of IPv4 routes in AllowedIPs. The
// server never refuses a list over the budget (DECISIONS No. 30: a refusal leaves the visitor without a config);
// /api/warp adds a fixed English warning that the UI localises by its prefix (result-explanation.js).
// The UI counter (public/static/settings.js, MAX_CIDR_LIMIT) still counts the raw list of /api/iplist.

'use strict';

/** 1000 until gate G4 measures a client threshold (DECISIONS No. 29, PRD FR-15). */
const ROUTE_LIMIT = 1000;
const WARN_RATIO = 0.8;

/** 'over' only above the limit (DECISIONS No. 31), 'warn' from 80 % up to the limit itself, else 'ok'. */
const classifyBudget = (after4, limit = ROUTE_LIMIT) => {
  if (after4 > limit) return 'over';
  if (after4 >= limit * WARN_RATIO && after4 <= limit) return 'warn';
  return 'ok';
};

/** The `warning` line of /api/warp for a list over the budget. The prefix "Route budget:" is its UI code. */
const routeBudgetWarning = ({ before4, after4, limit = ROUTE_LIMIT }) =>
  `Route budget: ${after4} IPv4 routes in AllowedIPs (${before4} in the source lists) is above the limit of ${limit}; phones and routers may handle a list this long unstably.`;

module.exports = { ROUTE_LIMIT, WARN_RATIO, classifyBudget, routeBudgetWarning };
