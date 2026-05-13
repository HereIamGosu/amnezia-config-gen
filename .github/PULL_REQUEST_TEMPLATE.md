## Summary

<!-- 1–3 sentences: what changes and why. -->

## Linked issues

<!-- Closes #123, refs #456 -->

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would change existing behaviour)
- [ ] Refactor (no behaviour change)
- [ ] Documentation
- [ ] CI / tooling

## Checklist

- [ ] `npm run lint` passes with zero warnings.
- [ ] `npm test` passes (existing tests + any new ones).
- [ ] If `api/routePresets.js` changed: ran `npm run presets:fallback` and committed the regenerated `public/static/presets-fallback.json`.
- [ ] If a critical invariant is touched (uppercase I1, S-zero for WARP, MTU 1280, field order, IPv4 default, mobile/router compose): updated **both** the test in `__tests__/invariant-*.test.js` **and** the README "Critical Invariants" block.
- [ ] Updated `CHANGELOG.md` under `[Unreleased]`.
- [ ] Tested locally with `npm start` (vercel dev) — generated config and confirmed it imports / connects.

## Notes for reviewer

<!-- Anything reviewers should pay extra attention to. -->
