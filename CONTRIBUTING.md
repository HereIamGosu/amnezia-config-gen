# Contributing to AmneziaWG Config Generator

Thanks for your interest! This document describes the workflow we follow.

## Development setup

```bash
git clone https://github.com/HereIamGosu/amnezia-config-gen.git
cd amnezia-config-gen
npm install
npm start    # vercel dev — local server on http://localhost:3000
```

Requires **Node.js ≥20**.

## Workflow

1. Fork the repository.
2. Branch from `main`: `git checkout -b feat/short-description` (or `fix/...`, `docs/...`).
3. Make your changes.
4. Run `npm run lint` and `npm test` locally; ensure both pass.
5. If you touched `api/routePresets.js`, run `npm run presets:fallback` and commit the regenerated `public/static/presets-fallback.json`.
6. Push to your fork and open a Pull Request against `main`.

## Commit messages

We recommend (but do not enforce) [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add IPv6-only preset toggle
fix(api): correct vpn:// format for AmneziaVPN
docs: clarify mobile mode behaviour in README
chore: bump tweetnacl to 1.0.4
refactor: extract endpoint resolution into helper
test: add invariant test for AWG 2.0 field order
ci: cache npm dependencies in GitHub Actions
```

Use the imperative mood ("add", not "added"). Squash trivial fixups into the meaningful commit.

## Code style

- ESLint config in `eslint.config.mjs` is the source of truth: single quotes, semicolons, no unused vars, prefer-const, no-var.
- `npm run lint` must pass with **zero warnings** (`--max-warnings 0`).

## Tests

- Test runner: built-in `node:test` (no extra dependencies).
- Run all tests: `npm test`.
- Run a single test: `node --test __tests__/invariant-i1-uppercase.test.js`.
- Add new tests in `__tests__/` with the `*.test.js` suffix.

## Critical invariants

This project encodes several non-obvious AmneziaWG-specific invariants (uppercase `I1`, S-zero for WARP, specific MTU, field order). They are documented in [README.md → Critical Invariants](./README.md#critical-invariants) and enforced by `__tests__/invariant-*.test.js`. **If your change touches any of those, update both the test and the README block in the same PR.**

## Reporting issues

Use the templates in `.github/ISSUE_TEMPLATE/`.

For security-sensitive reports, see [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree your contributions will be licensed under the [AGPL-3.0-only](./LICENSE).
