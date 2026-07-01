# 🌐🔧 AmneziaWG Config Generator

[English](./README.md) | [Русский](./README.ru.md)

Web UI and HTTP API for building `.conf` files for the **AmneziaWG** client (WireGuard with Amnezia obfuscation extensions). Primary use case: **Cloudflare WARP** profiles — registers a fresh WARP device via Cloudflare's official API, returns the keys and tunnel parameters, optionally narrows `AllowedIPs` to selected domain presets.

| | |
| --- | --- |
| **Generator** | <https://valokda-amnezia.vercel.app/> |
| **Project info page** | <https://hereiamgosu.github.io/amnezia-config-gen/> |
| **Telegram channel** | <https://t.me/amnezia_config> |
| **Source code** | <https://github.com/HereIamGosu/amnezia-config-gen> |

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-22.x-brightgreen)](https://nodejs.org/)
[![CI](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/releases/latest)
[![Last Commit](https://img.shields.io/github/last-commit/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/commits/main)
[![Open Issues](https://img.shields.io/github/issues/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/issues)

![App screenshot](https://i.imgur.com/xjgNNQX.png)

## Features

- Explicit routing mode selection: full tunnel (all traffic) or split tunnel (selected presets only). Split tunnel requires at least one selected preset — an empty split tunnel is rejected instead of silently falling back to a full tunnel.
- Two config formats: **Legacy** (`mode=legacy`) and **AmneziaWG 2.0** (`mode=awg2`).
- Route presets: tile-selectable domain bundles → aggregated IPv4 (or IPv4+IPv6) CIDRs in `AllowedIPs`. With no selection, defaults to `0.0.0.0/0`; `::/0` is added only when IPv6 is explicitly enabled. The UI caps route lists at **1000 IPv4 CIDRs** — larger lists are unstable on phones and routers.
- DNS presets for the `DNS` line in the config.
- One-click `.conf` download plus two Windows Task Scheduler templates: `public/static/SchedulerAmnezia-15.bat` (Legacy 1.5 → `AmneziaWarp.conf`) and `SchedulerAmnezia-20.bat` (AWG 2.0 → `AmneziaWarp-AWG2.conf`); edit the `amneziawg.exe` path in the .bat if needed.
- After generation, an explainable result card summarizes the AWG format, variants, endpoint and route sources, profiles, IPv6, `vpn://` availability, risk labels, and practical first diagnostic steps.
- `cps5`, `mobile`, `link` opt-in extras (see [Optional Extras](#optional-extras)).
- Cloudflare WARP API requests retry on network errors and 429 / 502 / 503 / 504 responses.

## Telegram channel

The **[Amnezia Config](https://t.me/amnezia_config)** Telegram channel publishes breakdowns of generator updates, diagnostics for endpoint, DNS, UDP, AllowedIPs, mobile profile, and config import issues.

The channel does not promise universal connectivity in any network. The materials explain how the settings work and where to look if the tunnel behaves differently across devices or networks.

## Requirements

- **Node.js 22** (`engines.node: 22.x`; CI also runs on Node 22).
- **Vercel CLI** for local serverless functions: `npm i -g vercel` or `npx vercel dev`.

No `.env` is required — the app calls Cloudflare's public WARP API directly.

## Local development

```bash
npm install
npm start    # vercel dev → http://localhost:3000
```

If you open the static files in `public/` without `vercel dev`, the UI loads presets from `public/static/presets-fallback.json` but `/api/iplist` and `/api/warp` won't work.

## Deploy

Designed for **Vercel**. Connect the repository in the Vercel dashboard or run `vercel` / `vercel --prod` from the project root.

## Privacy-safe telemetry

Product events use the existing Yandex.Metrika integration through the no-op-safe adapter in `public/static/analytics.js`. If analytics is unavailable or blocked, product actions continue normally.

Tracked events: `generation_started`, `generation_succeeded`, `generation_partially_succeeded`, `generation_failed`, `config_downloaded`, `config_preview_opened`, `vpn_link_copied`, `history_item_previewed`, `history_item_downloaded`, `healthcheck_opened`, and `status_modal_opened`.

Only bounded product metadata is allowed: mode, requested/produced counts, endpoint/route source categories, warning counts, full/split route mode, mobile/router flags, CPS mode, non-negative generation duration, and a coarse error category. The adapter does **not** collect `.conf` contents, `PrivateKey`, `PresharedKey`, WARP tokens, full endpoint strings, `AllowedIPs`, custom CIDRs, raw error messages, or a full user agent supplied by the application.

## Repository layout

| Path | Purpose |
|---|---|
| `public/index.html` | UI entry point |
| `public/static/script.js`, `styles.css` | Frontend logic and styles |
| `public/static/result-explanation.js` | Post-generation explainable result card |
| `public/static/analytics.js` | No-op-safe privacy-limited telemetry adapter |
| `public/static/presets-fallback.json` | Offline fallback preset catalogue |
| `api/warp.js` | WARP config generation endpoint |
| `api/iplist.js` | Preset list and CIDR preview |
| `api/status.js` | Public endpoint-pool status (per-port `ok`/`degraded`/`down`) |
| `api/healthcheck.js` | TCP probe of Cloudflare `api`/`engage` hosts (30-s cache) |
| `src/server/routePresets.js` | Source of truth for all route and DNS presets |
| `src/server/ipListFetch.js` | Domain → CIDR resolution (10-min in-memory cache) |
| `src/server/communityIpFetch.js` | Community CIDR source (itdog.info) |
| `src/server/warpCpsPayloads.js` | Pool of verified WARP-compatible CPS payloads |
| `src/server/cpsGenerator.js` | Generates `I1` payloads (`quic`, `dns`, `stun`, `dtls`, `sip`, `auto`) |
| `src/server/cps-presets/` | Text files referenced via `i1Ref` query param |
| `src/server/cpsExtraPackets.js` | Generates I2..I5 for `cps5=1` |
| `src/server/vpnLinkBuilder.js` | Builds `vpn://...` AmneziaVPN one-tap import URI |
| `src/server/endpointCache.js`, `endpointHealth.js` | Endpoint candidate pool and latency-based selection |
| `src/server/_rateLimit.js` | Per-IP rate limiter (10 generations/min) |
| `scripts/dump-presets-fallback.js` | Regenerates `presets-fallback.json` from `routePresets.js` |
| `__tests__/invariant-*.test.js` | Critical-invariant regression tests |

## Critical invariants

These rules are non-obvious, easy to break, and silently fatal. They are enforced by `__tests__/invariant-*.test.js`. **If you change any of them, update both the test and this block.**

| ID | Rule | Why |
|---|---|---|
| **I1** | The `[Interface]` line MUST be uppercase `I1`, not `i1`. | Lowercase `i1` is silently ignored by the AmneziaWG Windows client. Reference: [wg-easy/wg-easy#2439](https://github.com/wg-easy/wg-easy/issues/2439). |
| **I2** | For WARP / AmneziaWG 2.0: `S1 = S2 = S3 = S4 = 0`. | Cloudflare's peer is stock WireGuard and does not add S1–S4 byte prefixes. The AmneziaWG receive path strips S2/S3/S4 from incoming packets — non-zero values silently break the tunnel. |
| **I3** | For WARP / AmneziaWG 2.0: `H1..H4 = 1, 2, 3, 4`. | These are the default WireGuard packet types; Cloudflare's stock peer uses them. |
| **I4** | For WARP / AmneziaWG 2.0: `MTU = 1280`. | Required for WARP path-MTU compatibility. |
| **I5** | AmneziaWG 2.0 `[Interface]` field order: `PrivateKey → Address → DNS → MTU → Jc → Jmin → Jmax → S1..S4 → H1..H4 → I1`. | Matches the order `amneziawg-go` UAPI accepts. |
| **I6** | `AllowedIPs` defaults to **IPv4-only**; IPv6 is opt-in via the Settings IPv6 toggle (`?ipv6=1`). | Routers (GL.iNet, Keenetic, MikroTik) and mobile clients have limited routing-table capacity; doubling the route count via IPv6 causes silent failures. |
| **I7** | `mobile=1` overrides: `Jc=3, Jmin=64, Jmax=128, MTU=1280`, IPv4-only enforced (overrides `ipv6=1`, strips IPv6 from `Address` and `AllowedIPs`). | Mobile-tuned profile within AWG 2.0 spec; reduces battery drain and silent resets on iOS. |
| **I8** | When both `mobile=1` and `router=1` are set, `mobile` is applied first, then `router` caps via `Math.min`/`Math.max`. Router caps win on overlap (e.g. final `Jc = 2`). | Composition rule applied in `applyRouterModeCaps` after `applyMobileModeOverrides`. |
| **I9** | `cps5=1` adds `I2`–`I5` only for AWG 2.0 when `I1` is non-empty. | Legacy mode and AWG 2.0 without `I1` must not emit partial CPS chains. |
| **I10** | `vpn://` must survive the Qt `qCompress` round-trip and identify the payload as a ready third-party AWG profile. | Prevents AmneziaVPN from treating the import as a protocol-installation flow. |

## API

### `GET` / `POST` `/api/warp`

Returns JSON: `success`, on success `content` (`.conf` body in **base64**), `mode` (`legacy` | `awg2`), `routeMode` (`full` | `split`), `configs` (array of `{ index, content, appliedExtras, endpointSource, vpnLink }` when `count > 1`), `count`, optionally `routesSource`, privacy-safe `routesTelemetrySource` (`opencck` | `itdoginfo` | `antifilter` | `static` | `fallback` | `unknown`), `routesPresets`, `presetSitesCount`, `appliedExtras`, `vpnLink`. Top-level `content` / `vpnLink` / `appliedExtras` mirror the first config for backward compatibility.

Parameters via query string (`GET`) or JSON body fields (`POST`). Body field names match query param names (handy for long `i1`).

| Param | Description |
|---|---|
| `mode` | `legacy` (default) or `awg2` (aliases: `2`, `v2`; or query `awg`) |
| `routeMode` | `full` (ignore presets, route everything) or `split` (requires ≥ 1 preset). Omitted → inferred from `presets` |
| `count` | Number of configs to generate in one request, `1`–`3` (default `1`); all returned in `configs[]` |
| `presets` | Comma-separated preset keys (or array in JSON body) |
| `dns` | DNS preset key; UI default is `cloudflare` |
| `template` | See [Templates](#templates) |
| `peerEndpoint`, `endpoint` | Full `host:port` for `Endpoint` (used as-is when given) |
| `warpPort` | UDP port for `engage…` or IP fallback (default for WARP templates: **4500**; classic wgcf often: **2408**) |
| `persistentKeepalive`, `keepalive` | E.g. `25`; `0` omits the keepalive line |
| `i1` | Raw CPS / obfuscation string (AWG 2.0) |
| `i1Ref` | Filename from `src/server/cps-presets/` |
| `cps` | `I1` payload protocol: `auto` (default), `quic`, `dns`, `stun`, `dtls`, `sip` |
| `plainAddress` | `1` / `true` — omit `/32` and `/128` from `Address` |
| `ipv6` | `1` — also include IPv6 CIDRs from presets |
| `cps5` | `1` — append random `I2`..`I5` to `[Interface]` (only for `mode=awg2`, requires non-empty `I1`) |
| `mobile` | `1` — mobile profile (see I7) |
| `router` | `1` — router caps profile |
| `link` | `1` — include `vpnLink: "vpn://..."` in JSON response for AmneziaVPN one-tap import |

Errors: JSON `{ success: false, message }`; HTTP 4xx/5xx as appropriate. Named 400 errors: `invalid_route_mode` (value other than `full`/`split`) and `empty_split_tunnel` (`routeMode=split` without presets).

### `GET` `/api/iplist`

Without `?presets=...`: returns the full preset catalogue (`presets`, categories, `dnsPresets`, `dnsDefault`, etc.).

With `?presets=key1,key2`: resolves domains to CIDRs. Response: `{ count, count4, count6, cidrs, sites, sitesQueried, cidrSource }`. `cidrSource` reports the actual route source (`opencck`, `community`, `mixed`, `antifilter`, or `static`). Unknown keys → 400 with the offending list.

### `GET` `/api/status`

Public status of the WARP endpoint pool: overall `status` (`ok` | `degraded`), per-port `ok`/`degraded`/`down` counters, and the registry source (`kv` | `fallback`). No auth, no IP leakage.

### `GET` `/api/healthcheck`

TCP reachability probe of `api.cloudflareclient.com` and `engage.cloudflareclient.com` (port 443) with latency; results cached for 30 s.

## Templates

| Value | Behaviour |
|---|---|
| *(none)* + `mode=legacy` | Same as `warp_amnezia` |
| *(none)* + `mode=awg2` | Same as `warp_amnezia_awg2` |
| `warp_amnezia`, `amnezia`, `amnezia_warp` | Legacy WARP with engage-host endpoint, embedded `I1` if no user-supplied one, `plainAddress`, keepalive 25 |
| `warp_amnezia_awg2`, `amnezia_awg2`, `awg2_amnezia`, `warp_awg2_amnezia` | AWG 2.0 WARP — same peer/DNS/Address/I1 as Legacy WARP, with WARP-safe S=0 / H=1..4 / MTU=1280 |
| `wgcf` | `engage.cloudflareclient.com`, UDP 4500, no embedded I1 |
| `awg2_random`, `awg2_dpi` | Random H bands — **NOT** for Cloudflare WARP; bring your own endpoint |

## Optional Extras

| Param | Effect |
|---|---|
| `cps5=1` | When `mode=awg2` + non-empty `I1`, server appends `I2..I5` (random hex 16–64 bytes each via `crypto.randomBytes`) to `[Interface]`. Silently ignored for Legacy or empty `I1`. |
| `mobile=1` | Mobile-tuned profile per invariant **I7**. |
| `router=1` | Router caps profile (`Jc≤2`, `Jmin∈[40,128]`, `Jmax∈[Jmin+1,128]`); composes with `mobile` per invariant **I8**. |
| `link=1` | Response gains `vpnLink: vpn://<base64url(qCompress(JSON))>` for one-tap import in AmneziaVPN mobile app. |

`appliedExtras: { cps5, mobile }` in the response reports what was actually applied (`cps5` may be `false` even when requested — Legacy mode silently ignores it).

## NPM scripts

| Command | Action |
|---|---|
| `npm start` | `vercel dev` |
| `npm run lint` | ESLint (`--max-warnings 0`) |
| `npm test` | Run all tests via built-in `node:test` |
| `npm run test:coverage` | Run tests with experimental coverage |
| `npm run presets:fallback` | Regenerate `public/static/presets-fallback.json` from `src/server/routePresets.js` |
| `npm run build` | No-op (no build step required) |

To run a single test file: `node --test __tests__/invariant-i1-uppercase.test.js`.

Release 2.4.1 fallback smoke coverage is in `__tests__/fallback-smoke.test.js`: no-KV generation, partial endpoint failure, CIDR source fallback, `/api/status` registry source, and `/api/iplist` route source.

Manual `vpn://` import verification for iOS: [docs/manual-checks/vpn-link-ios.md](docs/manual-checks/vpn-link-ios.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). For security reports: [SECURITY.md](./SECURITY.md). All contributors are bound by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[AGPL-3.0-only](./LICENSE) — © 2026 HereIamGosu.

## Star History

<a href="https://star-history.com/#HereIamGosu/amnezia-config-gen&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=HereIamGosu/amnezia-config-gen&type=Date" />
 </picture>
</a>

## Contacts

- Discord: <https://discord.gg/XGNtYyGbmM>
- Server site: <https://valokda.vercel.app/>
