# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- LICENSE file (AGPL-3.0-only, © 2026 HereIamGosu).
- Community-standards files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.editorconfig`.
- GitHub issue and pull-request templates under `.github/`.
- English `README.md` (now the canonical entry point) plus Russian `README.ru.md`.
- "Critical Invariants" block in README — single source of truth for AmneziaWG-specific rules.
- CI workflow (`.github/workflows/ci.yml`): lint, tests (`node:test`), `presets-fallback` drift check on Node 20.
- Invariant test suite `__tests__/invariant-*.test.js` (I1–I10) covering uppercase `I1`, WARP `S=0`/`H=1..4`/`MTU=1280`, AWG2 field order, IPv4 default, mobile-mode overrides, mobile→router composition, `cps5` payload shape, `vpn://` link round-trip.
- `npm test` and `npm run test:coverage` scripts; `npm run lint` now enforces `--max-warnings 0`.
- `package.json` metadata: `author`, `repository`, `bugs`, `homepage`, `keywords`, `engines.node ≥ 20`.

### Changed
- License: `ISC` → `AGPL-3.0-only`.
- Healthcheck workflow now writes snapshots to the orphan branch `healthcheck-snapshots` instead of committing back to `main` (eliminates ~70% of historical commit noise).

### Removed
- Deprecated `api/warpAmneziaCpsPayload.js` (superseded by `pickRandomCpsPayload()` in `api/warpCpsPayloads.js`).
- Private documentation moved to gitignored on-disk-only state: `CLAUDE.md`, `docs/**`. These were also purged from git history via `git filter-repo`.

### Security
- Repository git history rewritten with `git filter-repo` to remove private documentation paths. All pre-rewrite commit SHAs are invalid; existing clones must re-clone or `git reset --hard origin/main`. See [SECURITY.md](./SECURITY.md).

## [2.4.1] - 2026-06-08

### Added
- Explicit regression coverage for invariants I1–I10, including IPv4-only default routes, mobile `AllowedIPs`, empty-`I1` CPS handling, and `vpn://` third-party profile round-trip.
- Fallback smoke tests for missing Vercel KV, partial endpoint failure, CIDR source fallback, `/api/status` registry source, and `/api/iplist` route source.
- Manual iOS `vpn://` verification checklist at `docs/manual-checks/vpn-link-ios.md`.

### Fixed
- Default full-tunnel routes are IPv4-only unless IPv6 is explicitly enabled.
- `/api/iplist` reports `cidrSource: "static"` when the response is built only from bundled static CIDRs.

## [2.1.0] - 2026-05

Pre-canonization snapshot. Notable features added in this line:

- `cps5` extra concealment packets (I2..I5) for AmneziaWG 2.0.
- `mobile=1` profile (Jc=3, Jmin=64, Jmax=128, MTU=1280, IPv4-only).
- `link=1` response field producing `vpn://...` AmneziaVPN one-tap import URI.
- Mobile vs router mode composition rule (router caps win on overlap).
- Fix: `vpn://` format compatible with AmneziaVPN (resolves Error 900).
- Fix: copy-vpn-link button wraps to its own row on mobile viewports.
