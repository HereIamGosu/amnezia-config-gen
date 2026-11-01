# Security Policy

## Supported Versions

This project tracks `main`. There are no LTS branches; security fixes ship to `main` and are deployed to <https://awgconfig.com/> within hours.

## Reporting a Vulnerability

**Please do not open public GitHub issues for security reports.**

Use one of:

1. [GitHub Security Advisory](https://github.com/HereIamGosu/amnezia-config-gen/security/advisories/new) (preferred; private, lets us coordinate a fix before disclosure).
2. Direct message via the project Discord: <https://discord.gg/sZTgtD7SyB>.

We aim to acknowledge within 72 hours.

## Scope

In scope:

- The serverless API at `api/` (warp.js, iplist.js, etc.) and the server code in `src/server/` (ipListFetch.js, the preset address catalogue `ipCatalog/`, etc.).
- The static frontend in `public/`.
- The CI workflows in `.github/workflows/`.
- Build and dependency manifests (`package.json`, `package-lock.json`).
- The preset catalogue builder in `scripts/ipcatalog/` (it runs on the maintainer's machine, not on the server).

Out of scope:

- Cloudflare WARP itself (report to Cloudflare).
- AmneziaWG client (report to <https://github.com/amnezia-vpn/amneziawg-tools>).
- Third-party address sources: `iplist.opencck.org` and the itdoginfo lists, which transitional presets read per request, and the sources the catalogue is built from (official lists of the services, ipverse/iptoasn, Google DNS-over-HTTPS, rekryt/iplist portal configs).

## Historical note (2026-05 git history rewrite)

In May 2026 the git history of this repository was rewritten with `git filter-repo` to remove private documentation files (`CLAUDE.md`, `DEV_CHECKLIST.md`, `docs/**`, `api/warpAmneziaCpsPayload.js`). All commit SHAs prior to the rewrite are invalid. If you have an existing clone, please re-clone:

```bash
git fetch origin
git reset --hard origin/main
# or simply
rm -rf amnezia-config-gen && git clone https://github.com/HereIamGosu/amnezia-config-gen.git
```

Any historical Cloudflare WARP private keys that may have appeared in deprecated example files (`api/warpAmneziaCpsPayload.js`) were ephemeral device-bound keys with no user-identifying data; Cloudflare rotates them on device deregistration. They have no continuing security value.
