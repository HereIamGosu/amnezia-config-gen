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
[![Node.js ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![CI](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/releases/latest)
[![Last Commit](https://img.shields.io/github/last-commit/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/commits/main)
[![Open Issues](https://img.shields.io/github/issues/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/issues)

![App screenshot](https://i.imgur.com/xjgNNQX.png)

## Features

- Explicit routing mode selection: full tunnel (all traffic) or split tunnel (selected presets only)
- Four config formats: **Legacy**, **AWG 2.0**, **AWG 3.0**, and **AWG 3.1** (`mode=legacy|awg2|awg3|awg31`). AWG 3.x modes use a WARP-safe client-side profile.
- Route presets: tile-selectable domain bundles → aggregated IPv4 (or IPv4+IPv6) CIDRs in `AllowedIPs`. With no selection, defaults to `0.0.0.0/0`; `::/0` is added only when IPv6 is explicitly enabled.
- DNS presets for the `DNS` line in the config.
- One-click `.conf` download plus two Windows Task Scheduler templates: `public/static/SchedulerAmnezia-15.bat` (Legacy 1.5 → `AmneziaWarp.conf`) and `SchedulerAmnezia-20.bat` (AWG 2.0 → `AmneziaWarp-AWG2.conf`); edit the `amneziawg.exe` path in the .bat if needed.
- After generation, an explainable result card summarizes the AWG format, variants, endpoint and route sources, profiles, IPv6, `vpn://` availability, risk labels, and practical first diagnostic steps.
- `cps5`, `mobile`, `link` opt-in extras (see [Optional Extras](#optional-extras)).
- Cloudflare WARP API requests retry on network errors and 429 / 502 / 503 / 504 responses.

## Telegram channel

The **[Amnezia Config](https://t.me/amnezia_config)** Telegram channel publishes breakdowns of generator updates, diagnostics for endpoint, DNS, UDP, AllowedIPs, mobile profile, and config import issues.

The channel does not promise universal connectivity in any network. The materials explain how the settings work and where to look if the tunnel behaves differently across devices or networks.

## Requirements

- **Node.js ≥ 20** (LTS).
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

Only bounded product metadata is allowed: mode, requested/produced counts, endpoint/route source categories, warning counts, full/split route mode, mobile/router flags, CPS mode, AWG WARP-safe/timing/experimental-padding booleans, non-negative generation duration, and a coarse error category. The adapter does **not** collect `.conf` contents, `PrivateKey`, `PresharedKey`, WARP tokens, full endpoint strings, `AllowedIPs`, custom CIDRs, raw error messages, or a full user agent supplied by the application.

## Repository layout

| Path | Purpose |
|---|---|
| `public/index.html` | UI entry point |
| `public/static/script.js`, `styles.css` | Frontend logic and styles |
| `public/static/presets-fallback.json` | Offline fallback preset catalogue |
| `api/warp.js` | WARP config generation endpoint |
| `src/server/awg/` | AWG profiles, strict ranges, WARP safety, and final serialization |
| `api/iplist.js` | Preset list and CIDR preview |
| `api/routePresets.js` | Source of truth for all route and DNS presets |
| `api/ipListFetch.js` | Domain → CIDR resolution (10-min in-memory cache) |
| `api/warpCpsPayloads.js` | Pool of verified WARP-compatible CPS payloads |
| `api/cps-presets/` | Text files referenced via `i1Ref` query param |
| `api/cpsExtraPackets.js` | Generates I2..I5 for `cps5=1` |
| `api/vpnLinkBuilder.js` | Builds `vpn://...` AmneziaVPN one-tap import URI |
| `api/_rateLimit.js` | Per-IP rate limiter (10 generations/min) |
| `scripts/dump-presets-fallback.js` | Regenerates `presets-fallback.json` from `routePresets.js` |
| `__tests__/invariant-*.test.js` | Critical-invariant regression tests |

## Critical invariants

These rules are non-obvious, easy to break, and silently fatal. They are enforced by `__tests__/invariant-*.test.js`. **If you change any of them, update both the test and this block.**

| ID | Rule | Why |
|---|---|---|
| **I1** | The `[Interface]` line MUST be uppercase `I1`, not `i1`. | Lowercase `i1` is silently ignored by the AmneziaWG Windows client. Reference: [wg-easy/wg-easy#2439](https://github.com/wg-easy/wg-easy/issues/2439). |
| **I2** | For every WARP-safe AWG 2/3.x profile: `S1 = S2 = S3 = S4 = 0`. | Cloudflare's peer is stock WireGuard and does not add AWG byte prefixes. |
| **I3** | For every WARP-safe AWG 2/3.x profile: `H1..H4 = 1, 2, 3, 4`. | Cloudflare expects the standard WireGuard message types. |
| **I4** | WARP-safe profiles use `MTU = 1280`; AWG 3.x never emits `HeaderProtectionKey` or enables `RandomTrailers`/`DisableCookies`. | Peer-dependent wire-format changes cannot interoperate with the stock Cloudflare peer. |
| **I5** | AmneziaWG 2.0 `[Interface]` field order: `PrivateKey → Address → DNS → MTU → Jc → Jmin → Jmax → S1..S4 → H1..H4 → I1`. | Matches the order `amneziawg-go` UAPI accepts. |
| **I6** | `AllowedIPs` defaults to **IPv4-only**; IPv6 is opt-in via the Settings IPv6 toggle (`?ipv6=1`). | Routers (GL.iNet, Keenetic, MikroTik) and mobile clients have limited routing-table capacity; doubling the route count via IPv6 causes silent failures. |
| **I7** | `mobile=1` overrides: `Jc=3, Jmin=64, Jmax=128, MTU=1280`, IPv4-only enforced (overrides `ipv6=1`, strips IPv6 from `Address` and `AllowedIPs`). | Mobile-tuned profile within AWG 2.0 spec; reduces battery drain and silent resets on iOS. |
| **I8** | When both `mobile=1` and `router=1` are set, `mobile` is applied first, then `router` caps via `Math.min`/`Math.max`. Router caps win on overlap (e.g. final `Jc = 2`). | Composition rule applied in `applyRouterModeCaps` after `applyMobileModeOverrides`. |
| **I9** | `cps5=1` adds `I2`–`I5` only for AWG 2.0 when `I1` is non-empty. | Legacy mode and AWG 2.0 without `I1` must not emit partial CPS chains. |
| **I10** | `vpn://` must survive the Qt `qCompress` round-trip and identify the payload as a ready third-party AWG profile. | Prevents AmneziaVPN from treating the import as a protocol-installation flow. |

## API

### `GET` / `POST` `/api/warp`

Returns JSON: `success`, on success `content` (`.conf` body in **base64**), `mode` (`legacy` | `awg2` | `awg3` | `awg31`), optionally `routesSource`, privacy-safe `routesTelemetrySource`, `routesPresets`, `presetSitesCount`, `appliedExtras`, `vpnLink`, `compatibility`, and AWG 3.x-only `awg` capability metadata.

Parameters via query string (`GET`) or JSON body fields (`POST`). Body field names match query param names (handy for long `i1`).

| Param | Description |
|---|---|
| `mode` | `legacy` (default), `awg2`, `awg3`, or `awg31`; accepted AWG 3.x aliases include `3`, `3.0`, `awg30`, `v3`, `3.1`, and `v3.1` |
| `presets` | Comma-separated preset keys (or array in JSON body) |
| `dns` | DNS preset key; UI default is `cloudflare` |
| `template` | See [Templates](#templates) |
| `peerEndpoint`, `endpoint` | Full `host:port` for `Endpoint` (used as-is when given) |
| `warpPort` | UDP port for `engage…` or IP fallback (default for WARP templates: **4500**; classic wgcf often: **2408**) |
| `persistentKeepalive`, `keepalive` | Integer for older modes; strict integer or `min-max` range for AWG 3.x (default `25-35`) |
| `rekeyAfterTime`, `rekeyTimeout`, `rejectAfterTime`, `keepaliveTimeout`, `maxHandshakeAttempts` | AWG 3.x strict integer/range overrides; defaults: `100-120`, `3-7`, `150-180`, `5-15`, `15-20` |
| `experimentalContentPadding`, `contentPaddingAddition` | API-only AWG 3.x experiment. Opt-in is required; default range when enabled is `10-100` and the response includes an interoperability warning |
| `i1` | Raw CPS / obfuscation string (AWG 2.0) |
| `i1Ref` | Filename from `api/cps-presets/` |
| `plainAddress` | `1` / `true` — omit `/32` and `/128` from `Address` |
| `ipv6` | `1` — also include IPv6 CIDRs from presets |
| `cps5` | `1` — append random `I2`..`I5` to `[Interface]` (only for `mode=awg2`, requires non-empty `I1`) |
| `mobile` | `1` — mobile profile (see I7) |
| `router` | `1` — router caps profile |
| `link` | `1` — include `vpnLink: "vpn://..."` in JSON response for AmneziaVPN one-tap import |

Errors: JSON `{ success: false, message }`; HTTP 4xx/5xx as appropriate.

### `GET` `/api/iplist`

Without `?presets=...`: returns the full preset catalogue (`presets`, categories, `dnsPresets`, `dnsDefault`, etc.).

With `?presets=key1,key2`: resolves domains to CIDRs. Response: `{ count, count4, count6, cidrs, sites, sitesQueried, cidrSource }`. `cidrSource` reports the actual route source (`opencck`, `community`, `mixed`, `antifilter`, or `static`). Unknown keys → 400 with the offending list.

## Templates

| Value | Behaviour |
|---|---|
| *(none)* + `mode=legacy` | Same as `warp_amnezia` |
| *(none)* + `mode=awg2` | Same as `warp_amnezia_awg2` |
| *(none)* + `mode=awg3` / `mode=awg31` | WARP-safe AWG 3.0 / 3.1 client profile |
| `warp_amnezia`, `amnezia`, `amnezia_warp` | Legacy WARP with engage-host endpoint, embedded `I1` if no user-supplied one, `plainAddress`, keepalive 25 |
| `warp_amnezia_awg2`, `amnezia_awg2`, `awg2_amnezia`, `warp_awg2_amnezia` | AWG 2.0 WARP — same peer/DNS/Address/I1 as Legacy WARP, with WARP-safe S=0 / H=1..4 / MTU=1280 |
| `warp_amnezia_awg3`, `warp_awg3_amnezia` | AWG 3.0 WARP-safe profile |
| `warp_amnezia_awg31`, `warp_awg31_amnezia` | AWG 3.1 WARP-safe profile with explicit safe 3.1 flags |
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

## Compatibility

Since 2.7.0 the `/api/warp` response carries an optional, additive `compatibility` summary
(`recommended` / `experimental` / `notRecommended` / `warnings`). It is metadata only:
it never contains keys, `.conf` text, or the `vpn://` payload, and it does not change any
existing response field. After a generation the UI shows a compatibility card that tells you
which clients are a reasonable target for the produced profile.

The compatibility model lives in [`src/server/clientCompatibility.js`](src/server/clientCompatibility.js)
via `getCompatibilityForGeneration({ mode, exportType, mobile, router, link })`.

### AWG 2.0 and Cloudflare WARP

AWG 2.0 refers to **client-side configuration parameters**. The Cloudflare WARP peer remains a
standard WireGuard peer, so some WARP parameters are intentionally fixed (see the AWG 2.0 / WARP
invariants above). Selecting AWG 2.0 does **not** mean Cloudflare's server supports AWG 2.0.

### AWG 3.0 / 3.1 and Cloudflare WARP

Cloudflare remains a standard WireGuard peer. The generator therefore enables only client-side AWG 3.x features that do not require peer-side support: junk/CPS packets, randomized rekey/handshake/keepalive timing, and a `PersistentKeepalive` range. `H1..H4` stay `1..4`, `S1..S4` stay zero, Header Protection is unavailable, and RandomTrailers cannot be enabled. `ContentPaddingAddition` is API-only, experimental, off by default, and may reduce interoperability.

AWG 3.x requires a modern compatible parser. For AWG 3.1, AmneziaVPN 5.0.1.5+ or a compatible AWG 3.1 client is recommended. Router compatibility depends on the router implementation. AWG 3.0 `vpn://` export is deliberately unavailable because its historical `protocol_version` mapping has not been confirmed; AWG 3.1 uses the confirmed `3.1` envelope.

### Export targets

[`src/server/exportTargets.js`](src/server/exportTargets.js) is a v0 registry describing output
formats and how ready each one is:

| Target | Status |
|---|---|
| `.conf` | stable |
| `vpn://` | stable for existing modes and AWG 3.1; unavailable for AWG 3.0 pending protocol evidence |
| QR | experimental |
| sing-box / Mihomo / Clash | experimental |
| Throne | research |
| OpenWrt | documentation |

Experimental and research targets are **not** stable exporters — they are labelled honestly so
they are not mistaken for a working import path. The generator reduces manual configuration, but
it does not guarantee connectivity in every network or client.

## NPM scripts

| Command | Action |
|---|---|
| `npm start` | `vercel dev` |
| `npm run lint` | ESLint (`--max-warnings 0`) |
| `npm test` | Run all tests via built-in `node:test` |
| `npm run test:coverage` | Run tests with experimental coverage |
| `npm run presets:fallback` | Regenerate `public/static/presets-fallback.json` from `api/routePresets.js` |
| `npm run build` | No-op (no build step required) |

To run a single test file: `node --test __tests__/invariant-i1-uppercase.test.js`.

Release 2.4.1 fallback smoke coverage is in `__tests__/fallback-smoke.test.js`: no-KV generation, partial endpoint failure, CIDR source fallback, `/api/status` registry source, and `/api/iplist` route source.

Manual `vpn://` import verification for iOS: [docs/manual-checks/vpn-link-ios.md](docs/manual-checks/vpn-link-ios.md).

## External source usage

This project may study external open-source projects for architecture ideas, compatibility notes, endpoint intelligence patterns, diagnostics, and UI references.

Do not copy external code before checking its license. If a repository has no license, an unclear license, or an incompatible license, reimplement the mechanism independently and use only the idea or behaviour as a reference.

External IP feeds and endpoint sources must never be exposed directly to generated user configs. They must go through the internal candidate pipeline and health checks.

The per-project license review lives in [docs/research/external-source-license-audit.md](docs/research/external-source-license-audit.md) (engineering audit, not legal advice).

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
