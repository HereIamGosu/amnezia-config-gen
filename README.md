# 🌐🔧 AmneziaWG Config Generator

[English](./README.md) | [Русский](./README.ru.md)

Web UI and HTTP API for building `.conf` files for the **AmneziaWG** client (WireGuard with Amnezia obfuscation extensions). Primary use case: **Cloudflare WARP** profiles — registers a fresh WARP device via Cloudflare's official API, returns the keys and tunnel parameters, optionally narrows `AllowedIPs` to selected domain presets. Since 3.0 the endpoint can also come from **Endpoint Lab** — the project's own check of WARP endpoints.

| | |
| --- | --- |
| **Generator** | <https://awgconfig.com/> |
| **Telegram channel** | <https://t.me/amnezia_config> |
| **Source code** | <https://github.com/HereIamGosu/amnezia-config-gen> |

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-22.x-brightgreen)](https://nodejs.org/)
[![CI](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml/badge.svg)](https://github.com/HereIamGosu/amnezia-config-gen/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/releases/latest)
[![Last Commit](https://img.shields.io/github/last-commit/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/commits/main)
[![Open Issues](https://img.shields.io/github/issues/HereIamGosu/amnezia-config-gen)](https://github.com/HereIamGosu/amnezia-config-gen/issues)

![AmneziaWG Config Generator 3.0: profile choice, parameter summary and system status](docs/images/awgconfig-3.0-en.png)

## Features

- Explicit routing mode selection: full tunnel (all traffic) or split tunnel (selected presets only)
- Four config formats: **Legacy**, **AWG 2.0**, **AWG 3.0**, and **AWG 3.1** (`mode=legacy|awg2|awg3|awg31`). AWG 3.x modes use a WARP-safe client-side profile.
- Up to three configs per request (`count=1..3`), each with its own WARP registration and keys.
- **Endpoint Lab** (`/lab`, `/en/lab`, `GET /api/lab`): a read-only view of Cloudflare WARP endpoints (`IP:UDP port`) that the project server checks with a real WireGuard handshake and HTTPS traffic through the tunnel. An endpoint that passes is ACTIVE for 7 minutes and has to pass again to stay. The checks run from the project server, so they show that an endpoint works from there, not from every network.
- **Lab Auto** (`endpointMode=lab`): every config gets its own fresh ACTIVE endpoint from the Lab, with distinct IPs. Without fresh Lab data no config is created (`503 lab_*`), never a silent fallback. In the web interface it is the default endpoint while the Lab pool is fresh; otherwise the interface selects the hostname `engage.cloudflareclient.com` and says why, and a Lab refusal offers an explicit "Generate with the hostname" button. The API default stays the hostname.
- Dark interface in Russian (`/`) and English (`/en`); the language follows the address. The "System status" card shows the generator API, WARP registration, the WARP endpoint, the route lists (the site catalogue and iplist.opencck.org) and the Endpoint Lab.
- Route presets in ten categories; each tile shows its price in `AllowedIPs` lines and how exact the addresses are. Catalogue presets take their networks from the site's address catalogue `src/server/ipCatalog/snapshot.json`, built in advance from the services' official lists, their AS announcements and the project's own resolution of their domains. Transitional presets (YouTube, Instagram, Facebook, WhatsApp, Discord and the presets whose catalogue recipe did not pass the coverage check) read iplist.opencck.org and the itdoginfo lists per request, with a reserve from the catalogue. The IPv4 part leaves out the four WARP subnets `162.159.192.0/24`, `162.159.193.0/24`, `162.159.195.0/24`, `162.159.204.0/24` and is merged into the fewest blocks that cover exactly the same addresses; a split config never routes its own `Endpoint` into the tunnel. With no selection, defaults to `0.0.0.0/0`; `::/0` is added only when IPv6 is explicitly enabled.
- DNS presets for the `DNS` line in the config.
- One-click `.conf` download for import into AmneziaWG and compatible clients.
- After generation, an explainable result card summarizes the AWG format, variants, endpoint and route sources, profiles, IPv6, `vpn://` availability, risk labels, and practical first diagnostic steps.
- `cps5`, `mobile`, `link` opt-in extras (see [Optional Extras](#optional-extras)).
- Cloudflare WARP API requests retry on network errors and 429 / 502 / 503 / 504 responses.

## Telegram channel

The **[Amnezia Config](https://t.me/amnezia_config)** Telegram channel publishes breakdowns of generator updates, diagnostics for endpoint, DNS, UDP, AllowedIPs, mobile profile, and config import issues.

The channel does not promise universal connectivity in any network. The materials explain how the settings work and where to look if the tunnel behaves differently across devices or networks.

## Requirements

- **Node.js 22** (`engines` in `package.json`).
- **Vercel CLI** only for `npm start` (`vercel dev`): `npm i -g vercel` or `npx vercel dev`.

No `.env` is required — the app calls Cloudflare's public WARP API directly.

## Local development

```bash
npm install
npm start          # vercel dev → http://localhost:3000
# or the same runtime as production, without Vercel:
node server.js     # http://localhost:3000 (PORT, HOST)
```

If you open the static files in `public/` without a server, the UI loads the preset catalogue with each preset's price from `public/static/presets-fallback.json` and shows the route counter as an estimate (the sum of the tile prices), but `/api/iplist` and `/api/warp` won't work.

Endpoint Lab data is not part of the repository. Locally, `/lab` reports that the Lab data is unavailable, `/api/lab` answers `503 lab_not_available` and Lab Auto answers `503 lab_unavailable`; the hostname mode works. To see the Lab locally, point `ENDPOINT_LAB_PUBLIC_DIR` (absolute path, read at start-up) to a copy of the Lab public directory.

## Deploy

The official site <https://awgconfig.com/> is self-hosted: every push to `main` that passes CI is built
once, tested, and published to GHCR by digest; the server pulls the verified image and switches
traffic blue/green with an automatic rollback. Details: [`deploy/CI_CD.md`](deploy/CI_CD.md),
[`deploy/CONTROLLER.md`](deploy/CONTROLLER.md).

Endpoint Lab runs on the same server as a separate host service (`deploy/endpoint-lab/`); the web
container only gets the Lab's secret-free public directory, mounted read-only. Details:
[`deploy/ENDPOINT_LAB.md`](deploy/ENDPOINT_LAB.md).

Forks keep working on **Vercel** as before: connect the repository in the Vercel dashboard or run
`vercel` / `vercel --prod` from the project root. A fork has no Endpoint Lab: the generator works in
the hostname mode, `/lab` reports that the Lab data is unavailable.

## Privacy-safe telemetry

Product events use the existing Yandex.Metrika integration through the no-op-safe adapter in `public/static/analytics.js`. If analytics is unavailable or blocked, product actions continue normally.

Tracked events: `generation_started`, `generation_succeeded`, `generation_partially_succeeded`, `generation_failed`, `config_downloaded`, `config_preview_opened`, `vpn_link_copied`, `history_item_previewed`, `history_item_downloaded`, `healthcheck_opened`, and `status_modal_opened`.

Only bounded product metadata is allowed: mode, requested/produced counts, endpoint/route source categories, warning counts, full/split route mode, mobile/router flags, CPS mode, AWG WARP-safe/timing/experimental-padding booleans, non-negative generation duration, and a coarse error category. The adapter does **not** collect `.conf` contents, `PrivateKey`, `PresharedKey`, WARP tokens, full endpoint strings, `AllowedIPs`, custom CIDRs, raw error messages, or a full user agent supplied by the application.

## Repository layout

| Path | Purpose |
|---|---|
| `public/index.html` | UI entry point (Russian, `/`) |
| `public/en/index.html`, `public/en/lab/index.html` | English pages (`/en`, `/en/lab`), generated by `npm run seo:en` — do not edit |
| `public/lab/` | Endpoint Lab page (`/lab`): markup, styles and scripts |
| `public/404.html`, `robots.txt`, `sitemap.xml`, `llms.txt`, `.well-known/security.txt` | Error page and files for search engines, AI search and security reports |
| `public/static/*.js`, `styles.css` | Frontend: `script.js` (generation and wiring) plus `i18n.js`, `common.js`, `status.js`, `live-status.js`, `result.js`, `result-explanation.js`, `settings.js`, `settings-link.js`, `history.js`, `share-link.js`, `ui-shell.js`, `analytics.js`, `metrika.js`, `status-page.js`; styles |
| `public/locales/{ru,en}.json` | Interface strings for both languages |
| `public/static/presets-fallback.json` | Offline fallback preset catalogue |
| `api/warp.js` | WARP config generation endpoint (hostname mode and Lab Auto) |
| `api/iplist.js` | Preset list and CIDR preview |
| `api/status.js`, `api/healthcheck.js` | Data for the "System status" card |
| `api/lab.js` | Read-only Endpoint Lab data for `/lab` |
| `src/server/awg/` | AWG profiles, strict ranges, WARP safety, and final serialization |
| `src/server/routePresets.js` | Source of truth for all route and DNS presets |
| `src/server/ipCatalog/` | Preset address catalogue: `snapshot.json` (built by `npm run ipcatalog:build`), its lazy loader, the resolver of `/api/warp` and `/api/iplist`, the checks of `npm run ipcatalog:check` |
| `src/server/ipListFetch.js` | Live route lists of transitional presets: iplist.opencck.org, then itdoginfo (10-min in-memory cache of non-empty answers) |
| `src/server/presetStats.js` | `[preset-stats]` log line: successful split generations per preset every 10 minutes, no IP |
| `src/server/warpCpsPayloads.js`, `src/server/cps/` | Pool of verified WARP-compatible CPS payloads and CPS packet generators |
| `src/server/cps-presets/` | Text files referenced via `i1Ref` query param |
| `src/server/cpsExtraPackets.js` | Generates I2..I5 for `cps5=1` (runtime `<b>`/`<r>`/`<t>` chains) |
| `src/server/vpnLinkBuilder.js` | Builds `vpn://...` AmneziaVPN one-tap import URI |
| `src/server/labPublic.js`, `src/server/endpointProvider.js` | Reading and validating the Lab public files; endpoint selection for Lab Auto |
| `src/server/_rateLimit.js` | Per-IP rate limiter (10 generations/min) |
| `server.js` | Self-hosted runtime used in production: routes and headers from `vercel.json` |
| `deploy/` | Docker image, nginx, blue/green deploy controller, Endpoint Lab host service (`deploy/endpoint-lab/`) |
| `scripts/dump-presets-fallback.js` | Regenerates `presets-fallback.json` from `routePresets.js` and the catalogue snapshot |
| `scripts/ipcatalog/` | Catalogue builder (run by the maintainer, never in the request path or CI) and its check |
| `__tests__/` | `node:test` suite, including the critical-invariant tests `invariant-*.test.js` |
| `e2e/` | Browser tests in a local Chrome (`npm run test:e2e`) |

## Critical invariants

These rules are non-obvious, easy to break, and silently fatal. They are enforced by `__tests__/invariant-*.test.js`. **If you change any of them, update both the test and this block.**

| ID | Rule | Why |
|---|---|---|
| **I1** | The `[Interface]` line MUST be uppercase `I1`, not `i1`. | Lowercase `i1` is silently ignored by the AmneziaWG Windows client. Reference: [wg-easy/wg-easy#2439](https://github.com/wg-easy/wg-easy/issues/2439). |
| **I2** | For every WARP-safe AWG 2/3.x profile: `S1 = S2 = S3 = S4 = 0`. | Cloudflare's peer is stock WireGuard and does not add AWG byte prefixes. |
| **I3** | For every WARP-safe AWG 2/3.x profile: `H1..H4 = 1, 2, 3, 4`. | Cloudflare expects the standard WireGuard message types. |
| **I4** | WARP-safe profiles use `MTU = 1280`; AWG 3.x never emits `HeaderProtectionKey` or enables `RandomTrailers`; `DisableCookies` is an opt-in local setting (`disableCookies=on`) and is omitted by default. | Peer-dependent wire-format changes cannot interoperate with the stock Cloudflare peer; local cookie behaviour does not require Cloudflare support. |
| **I5** | AmneziaWG 2.0 `[Interface]` field order: `PrivateKey → Address → DNS → MTU → Jc → Jmin → Jmax → S1..S4 → H1..H4 → I1`. | Matches the order `amneziawg-go` UAPI accepts. |
| **I6** | `AllowedIPs` defaults to **IPv4-only**; IPv6 is opt-in via the Settings IPv6 toggle (`?ipv6=1`). A registration without an IPv6 address gives the IPv4-only config, also with `ipv6=1`. | Routers (GL.iNet, Keenetic, MikroTik) and mobile clients have limited routing-table capacity; doubling the route count via IPv6 causes silent failures. |
| **I7** | `mobile=1` overrides: `Jc=3, Jmin=64, Jmax=128, MTU=1280`, IPv4-only enforced (overrides `ipv6=1`, strips IPv6 from `Address` and `AllowedIPs`). | Mobile-tuned profile within AWG 2.0 spec; reduces battery drain and silent resets on iOS. |
| **I8** | When both `mobile=1` and `router=1` are set, `mobile` is applied first, then `router` caps via `Math.min`/`Math.max`. Router caps win on overlap (e.g. final `Jc = 2`). | Composition rule applied in `applyRouterModeCaps` after `applyMobileModeOverrides`. |
| **I9** | `cps5=1` adds `I2`–`I5` for AWG 2.0/3.x when `I1` is non-empty. | Legacy mode and AWG modes without `I1` must not emit partial CPS chains. |
| **I10** | `vpn://` must survive the Qt `qCompress` round-trip, identify the payload as a ready third-party AWG profile and carry the structured fields AmneziaVPN reads on connect (`hostName`, numeric `port`, `client_priv_key`, `client_ip`, `server_pub_key`, `allowed_ips`, AWG keys), not only the `.conf` text. | Prevents AmneziaVPN from treating the import as a protocol-installation flow. |
| **I11** | Lab Auto (`endpointMode=lab`) changes only `Endpoint`: for the same request every other field, its order and the response metadata match hostname mode (keys, junk sizes and CPS packets are random in both). Without usable Lab data it answers `503 lab_*` before any WARP registration and never falls back to hostname, also when every fresh endpoint lies inside the split routes (`503 lab_endpoints_in_routes`). | Lab endpoints are chosen per request from a pool verified minutes ago; a silent hostname fallback would hide that the requested verification did not happen. |
| **I14** | The IPv4 part of a split `AllowedIPs` covers exactly the routes of the selected presets minus E4 — the WARP endpoint subnets `162.159.192.0/24`, `162.159.193.0/24`, `162.159.195.0/24`, `162.159.204.0/24` — and minus O4, the /32 of a manual endpoint inside those routes, in no more blocks than that set needs. With `ipv6=1` the IPv6 part is the presets' IPv6 routes minus E6 (`2606:4700:d0::/48`, `2606:4700:d1::/48`) and O6, the /128 of a manual endpoint; entries that do not touch them pass unchanged, IPv6 is never merged. The same in hostname and Lab Auto mode; the full tunnel is never cut. | A route that is wider than the presets sends other traffic through WARP; a route to the config's own WARP endpoint puts the endpoint inside the tunnel's routes (whether a client then loops its own packets is not verified). |
| **I15** | A split `AllowedIPs` never covers the config's `Endpoint`: for the hostname through E4/E6 (`engage.cloudflareclient.com` = `162.159.192.1`, `2606:4700:d0::a29f:c001`), for Lab Auto and the built-in endpoints by skipping the candidates the routes cover, for a manual endpoint by cutting its /32 (/128). | The tunnel's own packets to its endpoint must not be routed into the tunnel; `188.114.96.0/22` holds endpoints and ordinary sites at once, so it is not cut. |

I12 and I13 are reserved for planned releases.

## API

### `GET` / `POST` `/api/warp`

Returns JSON: `success`, on success `content` (`.conf` body in **base64**; with `count` > 1 the first config), `configs` (every config with its own `content`, `endpointSource`, CPS fields and `vpnLink`), `count`, `mode` (`legacy` | `awg2` | `awg3` | `awg31`), optionally `routesSource`, privacy-safe `routesTelemetrySource`, `routesPresets`, `presetSitesCount`, `appliedExtras`, `vpnLink`, `compatibility`, and AWG 3.x-only `awg` capability metadata.

Parameters via query string (`GET`) or JSON body fields (`POST`). Body field names match query param names (handy for long `i1`).

| Param | Description |
|---|---|
| `mode` | `legacy` (default), `awg2`, `awg3`, or `awg31`; accepted AWG 3.x aliases include `3`, `3.0`, `awg30`, `v3`, `3.1`, and `v3.1` |
| `count` | `1`–`3` configs in one response (default `1`); each config is a separate WARP registration |
| `presets` | Comma-separated preset keys (or array in JSON body). An old key is accepted as its preset (`rutracker_local` → `rutracker`); a retired key (the Russian services taken out in 3.2.0) is skipped with a `warning`; a set left without a preset to route → `400 empty_split_tunnel`; an unknown key → 400 |
| `dns` | DNS preset key; UI default is `cloudflare` |
| `template` | See [Templates](#templates) |
| `peerEndpoint`, `endpoint` | `IPv4:port` or `[IPv6]:port` for `Endpoint`, used as given. A value of that shape with an invalid address or a port outside 1–65535 → `400 peer_endpoint_invalid` before registration; any other value is ignored. Inside the split routes its /32 (/128 with `ipv6=1`) is left out of `AllowedIPs` and `warning` gains `Endpoint override inside routes: <address>` (I15) |
| `warpPort` | UDP port for `engage…` or IP fallback; one of **2408, 500, 4500, 1701, 880, 8854**, otherwise HTTP 400 (default for WARP templates: **4500**; classic wgcf often: **2408**) |
| `endpointMode` | `hostname` (default, unchanged behaviour) or `lab` — Lab Auto: each config gets a distinct fresh ACTIVE endpoint of the Endpoint Lab. The requested port is a preference: the Lab verifies 2408/500/1701/4500, a shortfall on that port is filled from other verified ports and reported. Fewer distinct endpoints than `count` → fewer configs plus a warning, never duplicates. Only for WARP templates; not with `peerEndpoint`. |
| `persistentKeepalive`, `keepalive` | Integer for older modes; strict integer or `min-max` range for AWG 3.x (default `25-35`) |
| `rekeyAfterTime`, `rekeyTimeout`, `rejectAfterTime`, `keepaliveTimeout`, `maxHandshakeAttempts` | AWG 3.x strict integer/range overrides; defaults: `100-120`, `3-7`, `150-180`, `5-15`, `15-20` |
| `contentPaddingAddition` | AWG 3.x encrypted payload padding; defaults to `10-100`; `off`, `0`, or `0-0` disables it; accepts a strict `0..65535` integer/range |
| `experimentalContentPadding` | Deprecated compatibility flag; `true` remains accepted, while padding now follows `contentPaddingAddition` directly |
| `disableCookies` | AWG 3.1-only strict `on/off` toggle (also `true/false/1/0`); omitted by default, opt-in (AmneziaWG iOS/macOS before v3.1.3 reject the key) |
| `i1` … `i5` | Own CPS chains for `I1`–`I5` (query or JSON body of a POST). Tags `<b 0x…>`, `<r N>`, `<rd N>`, `<rc N>`, `<t>`; N 1–1000, one `<t>` per field, up to 1472 bytes per packet. Checked by `public/static/cps-chain.js` (the same parser as the web editor) and written in canonical form; an invalid chain returns HTTP 400 `cps_chain_invalid` with `field`, before any WARP registration. An own `I2`–`I5` replaces that field of the `cps5` template; without `cps5` only the given fields are written. `I2`–`I5` still need `I1` and an AWG 2.0/3.x mode, and must not leave a gap (`I3` without `I2` and without `cps5` returns HTTP 400 `cps_chain_gap`: amneziawg-go before v0.2.16 rejects such a config). |
| `cpsCompat` | `all` — only `<b>`/`<r>`/`<t>` (every client with I1–I5, amneziawg-go v0.2.13+); `modern` (default) — also `<rd>`/`<rc>` (v0.2.15+). |
| `i1Ref` | Filename from `src/server/cps-presets/` |
| `cps` | `auto` (stable `static` / `sip` / `stun` only), or explicit `static`, `sip`, `stun`, `quic`, `dns`, `dtls`; the latter three are experimental. `tls` and unknown IDs return HTTP 400. |
| `plainAddress` | `1` / `true` — omit `/32` and `/128` from `Address` |
| `ipv6` | `1` — also include IPv6 CIDRs from presets (without the WARP endpoint /48s, see I14) |
| `cps5` | `1` — append `I2`..`I5` CPS chains to `[Interface]` (for `mode=awg2`, `awg3`, `awg31`; requires non-empty `I1`) |
| `mobile` | `1` — mobile profile (see I7) |
| `router` | `1` — router caps profile |
| `link` | `1` — include `vpnLink: "vpn://..."` in JSON response for AmneziaVPN one-tap import |

Errors: JSON `{ success: false, message }`; HTTP 4xx/5xx as appropriate.

A failed Cloudflare WARP registration answers by class, with a fixed `message` that carries nothing of Cloudflare's answer and no `error` field (since 3.1.8):

| Cloudflare outcome | HTTP | `Retry-After` |
|---|---|---|
| 429 (after the retries) | 429 | Cloudflare's value if it is an integer 1–3600, otherwise 60 |
| 408, 500, 502–504 and other 5xx except 501; network failure; timeout (20 s) | 503 | 60 |
| 3xx, 4xx except 408 and 429, 501 | 502 | — |
| 2xx that is not JSON, lacks `id`/`token`/peers or has an unusable IPv4 address; an answer over 2 MB | 502 | — |

The network errors `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `EPIPE`, «socket hang up», timeouts and 429 / 502 / 503 / 504 are retried (three attempts in all); another network code (such as `EHOSTUNREACH`) and every other outcome is one attempt. Our own rate limit stays `429` with `Retry-After` and the message «Слишком много запросов. Попробуйте позже.»

A registration without a usable IPv6 address no longer fails: the config is IPv4-only (the config of `ipv6=0`, also when `ipv6=1` was asked), and `warning` gains `WARP registration returned no IPv6 address for config(s) N: the config is IPv4-only.` With `mobile=1` the config is IPv4-only anyway and gets no such warning.

Split routes (`presets`) are resolved once per request, before any WARP registration, and every config of a `count` > 1 request gets the same list. From 3.2.0 catalogue presets take their networks from `src/server/ipCatalog/snapshot.json` without any network request; a transitional preset asks iplist.opencck.org and its itdoginfo lists on its own call, and when that call gives no IPv4 network it takes the reserve of the snapshot and `warning` gains `Route source fallback: <keys>`. The antifilter substitute of earlier versions is gone. A retired preset is skipped (`Presets retired: <keys>`), a preset without data too (`Presets without data: <keys>`); a set left with no preset to route answers `400 empty_split_tunnel` before Lab Auto and registration, with or without `routeMode`. The WARP endpoint subnets `162.159.192.0/24`, `162.159.193.0/24`, `162.159.195.0/24`, `162.159.204.0/24` are left out of the IPv4 routes, the same in hostname and Lab Auto mode, and the rest is merged into the fewest aligned blocks that cover exactly the same addresses (I14); with `ipv6=1` the IPv6 routes lose `2606:4700:d0::/48` and `2606:4700:d1::/48`. A list with nothing left after the cut answers `502` («Сервис списков IP вернул пустой ответ…»). `188.114.96.0/22`, which also holds WARP endpoints, is shared with ordinary sites and is not cut; instead the Endpoint choice skips the candidates the routes cover — Lab Auto and the built-in endpoints of the `awg2_random` and `awg2_dpi` templates (I15). The full tunnel stays `0.0.0.0/0` (`::/0` with `ipv6=1`). Above 1000 IPv4 routes in `AllowedIPs` the config is still given and `warning` gains `Route budget: N IPv4 routes in AllowedIPs (M in the source lists) is above the limit of 1000; …`; there is no refusal. A catalogue snapshot that cannot be read answers a split request `503` with a fixed text before registration; the full tunnel never reads it. The web UI counts `routes4` of `/api/iplist`, the IPv4 lines of the config: warning from 800, unchecked tiles disabled at 1000, over the limit above 1000. It cannot know two cuts made per request: the IPv4-only filter of a registration without IPv6 and the cut of a manual endpoint.

Lab Auto adds `endpointSource: "lab"` per config and `lab: { requested, selected, requestedPort, portMatched, ports }`. Its refusals are `{ success: false, error, message }`: `400 invalid_endpoint_mode`, `400 endpoint_mode_conflict` (with `peerEndpoint`), `400 lab_template_unsupported` (non-WARP template); `503 lab_unavailable` (no or unusable Lab data, or the Lab reports itself unavailable), `503 lab_stale`, `503 lab_no_endpoints`, `503 lab_endpoints_in_routes` (every fresh endpoint lies inside the split routes) with `Retry-After: 60`. The order is: Lab readiness (a Lab without usable data answers at once, before the route lists), the routes, the selection that skips the endpoints the routes cover, the registration. Freshness is decided by the selection, once, before registration; the request then keeps those endpoints.

### `GET` `/api/iplist`

Without `?presets=...`: the catalogue — `presets` (each with `id`, `label`, `category`, `sitesCount` = its domains, and from the snapshot `routes4`, `precision` = `exact` | `approx` | `wide`, `noData`, `source` = `catalog` | `live`; for a transitional preset `routes4` is the line count of its live lists at the last build), `categories` (display order), `groupRfPopular` (the quick pick), `aliases`, `retired`, `catalogBuiltAt`, `dnsPresets`, `dnsDefault`.

With `?presets=key1,key2` (and `ipv6=1`): `{ presets, sites, sitesQueried, count, count4, count6, cidrs, cidrSource, routes4, routes6, presetStatus, warnings, catalogBuiltAt }`. `cidrs`, `count4`, `count6` and `count` keep their meaning: the raw union of the sources, no cut and no merge between presets (from 3.2.0 the IPv4 part stays in `cidrs` with `ipv6=1`, and `count6` counts only IPv6 entries). `routes4` and `routes6` are what the config would carry after the WARP endpoint cut and the exact merge. `cidrSource` is `catalog` when no transitional preset is in the set or all of them went to the reserve, otherwise the source of the live part (`opencck`, `community`, `mixed`). `presetStatus` gives per key `source` (`catalog`, `live`, `catalog-fallback`, `retired`, `noData`) with `routes4` and `precision`. Only retired or only no-data presets → 200 with zero routes and `warnings`; nothing left after the cut → 200 with `routes4: 0` and `Empty after endpoint cut`; unknown keys → 400 with the offending list; a catalogue snapshot that cannot be read → 503.

### `GET` `/api/lab`

Read-only Endpoint Lab data for `/lab`; it never controls the Lab. Without parameters: the overview (`status`, `generatedAt`, `freshness`, events and `endpoints` with the public states `ACTIVE`, `VERIFIED`, `SUSPECT`). With `?endpoint=<ip:port>&range=24h|7d|30d|all` (default `all`): the history of one endpoint.

Errors are `{ success: false, code }`: `400 endpoint_invalid`, `400 range_invalid`, `404 endpoint_not_found`, `405 method_not_allowed`; `503 lab_not_available` when the Lab public files are missing (Vercel, forks, no Lab mount) and `503 lab_malformed` when they fail validation, both with `Retry-After`. Responses are `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.

### `GET` `/api/status`

Endpoint registry summary for the "System status" card: `status`, `updated_at`, `active_endpoints`, per-port `ports` and `candidates` (counts only, never IPs), `health_source`, `message`, and `lab: { available }`, which tells the page whether Endpoint Lab data is there.

### `GET` `/api/healthcheck`

TCP reachability of `api.cloudflareclient.com:443`, `engage.cloudflareclient.com:443` and `iplist.opencck.org:443` (transitional presets read it per request): `{ services: { api, engage, cidr }, checkedAt, catalogBuiltAt }`, where `catalogBuiltAt` is the build time of the catalogue snapshot (null when it cannot be read). The probes are cached for 30 seconds.

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

### CPS protocol status

| Protocol | Status | Auto | Notes |
|---|---|---:|---|
| Static | stable | yes | Verified project WARP payload pool |
| SIP | stable | yes | Coherent randomized SIP INVITE |
| STUN | stable | yes | Binding Request with valid FINGERPRINT |
| QUIC | experimental | no | Protected QUIC v1 Initial-shaped packet; interop pending |
| DNS | experimental | no | Response-shaped DNS packet; interop pending |
| DTLS | experimental | no | DTLS 1.2 ClientHello-shaped packet; interop pending |
| TLS | unsupported | no | Rejected with HTTP 400 |

| Param | Effect |
|---|---|
| `cps5=1` | When `mode` is `awg2`, `awg3` or `awg31` and `I1` is non-empty, server appends `I2..I5` to `[Interface]`: four differently shaped chains of `<b 0x…>`, `<r N>` and `<t>` (about 50–150 bytes each). The `<r>` and `<t>` bytes are generated by the client on every handshake initiation, so these packets vary between handshakes of the same config; only a few `<b>` bytes are fixed per config. `<rc>`/`<rd>` are not used: amneziawg-go before v0.2.15 rejects them and the whole config. Source audit: [docs/research/cps-runtime-tags-audit.md](docs/research/cps-runtime-tags-audit.md). Silently ignored for Legacy or empty `I1`. |
| `mobile=1` | Mobile-tuned profile per invariant **I7**. |
| `router=1` | Router caps profile (`Jc≤2`, `Jmin∈[40,64]`, `Jmax∈[Jmin+64,128]`) in every mode, Legacy included; composes with `mobile` per invariant **I8**. |
| `link=1` | Response gains `vpnLink: vpn://<base64url(qCompress(JSON))>` for one-tap import in AmneziaVPN mobile app. |

`appliedExtras: { cps5, mobile, customCps }` in the response reports what was actually applied (`cps5` may be `false` even when requested — Legacy mode silently ignores it; `customCps` lists the I1–I5 fields that use own chains, which have no protocol evidence status).

Successful responses also report secret-free `cpsRequested`, `cpsResolved`, `cpsStability`, and additive `cpsEvidenceStatus` fields. For `count=1..3`, every `configs[]` entry carries its own resolution; Auto is resolved independently for each config. QUIC is a protected 1200-byte QUIC v1 Initial-shaped packet split into adjacent fixed-byte CPS tags without truncation, but remains experimental until WARP interoperability is confirmed. Static/SIP/STUN are stable with verified project evidence; QUIC/DNS/DTLS are experimental, TLS is unsupported, and Auto selects stable protocols only.

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

Cloudflare remains a standard WireGuard peer. The generator enables client-side AWG 3.x features: junk/CPS packets, randomized rekey/handshake/keepalive timing, a `PersistentKeepalive` range, and encrypted `ContentPaddingAddition` (`10-100` by default, disableable with `off`, `0`, or `0-0`). AWG 3.1 writes `DisableCookies` only when asked (`disableCookies=on`); it suppresses the local under-load Cookie Reply branch, reduces local anti-DoS protection, and AmneziaWG iOS/macOS before v3.1.3 reject the key. A WARP client config only initiates handshakes, so the setting probably does not change the tunnel. `H1..H4` stay `1..4`, `S1..S4` stay zero, Header Protection is unavailable, and `RandomTrailers=on` is always rejected: Cloudflare's tolerance of trailers is undocumented and the mechanism depends on peer receive behaviour. See [current protocol evidence](docs/protocol-evidence.md); historical release notes describe their own snapshots.

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
| `npm run test:e2e` | Browser tests in a local Chrome (`e2e/`) |
| `npm run test:coverage` | Run tests with experimental coverage |
| `npm run presets:fallback` | Regenerate `public/static/presets-fallback.json` from `src/server/routePresets.js` and the catalogue snapshot |
| `npm run ipcatalog:build` | Rebuild the catalogue snapshot `src/server/ipCatalog/snapshot.json` (network; `-- --report <file>` writes the build summary); run before every release |
| `npm run ipcatalog:check` | Check the committed snapshot without network (also part of `npm test`) |
| `npm run evidence:check` | Check that the protocol evidence (`docs/protocol-evidence.md`) is current; `evidence:generate` regenerates it |
| `npm run release:check` | Release consistency: `package.json`, CHANGELOG, asset `?v=` keys, version claims in the READMEs |
| `npm run indexnow` | Submit the sitemap URLs to IndexNow (Bing, Yandex and others); `--wait-revision <sha>` waits for the deploy, `--since <commit>` skips unchanged releases, `--dry-run` |
| `npm run seo:en` | Regenerate the English pages `public/en/index.html` and `public/en/lab/index.html` from the Russian pages and `public/locales/en.json` (`seo:check` verifies) |
| `npm run assets:build -- <dir>` | Minify and precompress static assets in `<dir>`; the Docker build runs it on a copy of `public/` |
| `npm run build` | No-op (no build step required) |

To run a single test file: `node --test __tests__/invariant-i1-uppercase.test.js`.

Release 2.4.1 fallback smoke coverage is in `__tests__/fallback-smoke.test.js`: no-KV generation, partial endpoint failure, a failed primary list without the antifilter substitute and the snapshot reserve of a transitional preset (3.2.0), `/api/status` registry source, and the catalogue route source of `/api/iplist`.

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

- Discord: <https://discord.gg/sZTgtD7SyB>
- Server site: <https://valokda.vercel.app/>
