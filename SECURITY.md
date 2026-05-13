# Security Policy

## Supported Versions

This project tracks `main`. There are no LTS branches; security fixes ship to `main` and are deployed to <https://valokda-amnezia.vercel.app/> within hours.

## Reporting a Vulnerability

**Please do not open public GitHub issues for security reports.**

Use one of:

1. [GitHub Security Advisory](https://github.com/HereIamGosu/amnezia-config-gen/security/advisories/new) (preferred; private, lets us coordinate a fix before disclosure).
2. Direct message via the project Discord: <https://discord.gg/XGNtYyGbmM>.

We aim to acknowledge within 72 hours.

## Scope

In scope:

- The serverless API at `api/` (warp.js, iplist.js, ipListFetch.js, etc.).
- The static frontend in `public/`.
- The CI workflows in `.github/workflows/`.
- Build and dependency manifests (`package.json`, `package-lock.json`).

Out of scope:

- Cloudflare WARP itself (report to Cloudflare).
- AmneziaWG client (report to <https://github.com/amnezia-vpn/amneziawg-tools>).
- Third-party CIDR sources (`iplist.opencck.org`, `antifilter.download`).

## Historical note (2026-05 git history rewrite)

In May 2026 the git history of this repository was rewritten with `git filter-repo` to remove private documentation files (`CLAUDE.md`, `DEV_CHECKLIST.md`, `docs/**`, `api/warpAmneziaCpsPayload.js`). All commit SHAs prior to the rewrite are invalid. If you have an existing clone, please re-clone:

```bash
git fetch origin
git reset --hard origin/main
# or simply
rm -rf amnezia-config-gen && git clone https://github.com/HereIamGosu/amnezia-config-gen.git
```

Any historical Cloudflare WARP private keys that may have appeared in deprecated example files (`api/warpAmneziaCpsPayload.js`) were ephemeral device-bound keys with no user-identifying data; Cloudflare rotates them on device deregistration. They have no continuing security value.
