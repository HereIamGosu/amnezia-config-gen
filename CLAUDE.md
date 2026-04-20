# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

```bash
npm install                   # install dependencies
npm start                     # vercel dev — local server at http://localhost:3000
npm run lint                  # eslint on all JS files
npx eslint api/warp.js        # lint a single file
npm run presets:fallback      # regenerate public/static/presets-fallback.json from api/routePresets.js
```

No `.env` needed — the app calls the public Cloudflare WARP API directly.
There is no build step and no test suite.

---

## Architecture

**Vercel serverless** project: static frontend in `public/`, API functions in `api/`.
Routing in `vercel.json`: `/api/*` → `api/$1.js`, everything else served from `public/`.

### File map

| File | Role |
| --- | --- |
| `public/static/script.js` | Browser UI: loads presets, drives settings modal, calls API, triggers download |
| `public/index.html` | Single-page HTML shell with settings modal |
| `public/static/styles.css` | All CSS |
| `public/static/presets-fallback.json` | Static snapshot of routePresets.js (offline fallback) |
| `api/warp.js` | Main endpoint: registers WARP device, builds WireGuard `.conf`, returns base64 |
| `api/iplist.js` | Serves preset catalogue or resolves preset keys → CIDR lists |
| `api/ipListFetch.js` | Fetches CIDRs from iplist.opencck.org; in-memory cache, 10-min TTL |
| `api/routePresets.js` | Single source of truth for all route presets and DNS presets |
| `api/warpCpsPayloads.js` | Pool of 3 verified WARP CPS binary payloads; `pickRandomCpsPayload()` used for `I1` |
| `api/cpsSignatureGenerator.js` | Generates CPS signature chains |
| `api/cps-presets/` | Raw text files referenced by `i1Ref` query param |
| `api/_rateLimit.js` | Per-IP rate limiter (10 gen/min) used by warp.js |
| `api/warpAmneziaCpsPayload.js` | Static fallback CPS payload (superseded by warpCpsPayloads pool) |

### Request flow

1. On page load, `script.js` calls `GET /api/iplist` → gets preset catalogue + DNS preset list.
   Falls back to `public/static/presets-fallback.json` if API is unavailable.
2. User picks route/DNS presets; after each change `script.js` calls `GET /api/iplist?presets=...`
   to fetch the live CIDR count (`count4`) and update the counter + warning in the UI.
3. On generate click, `script.js` calls `GET /api/warp?mode=...&presets=...&dns=...`
   → `api/warp.js` registers a new WARP device, resolves preset CIDRs, builds the `.conf` string,
   returns it base64-encoded.
4. `script.js` decodes the base64, triggers a file download.

---

## Config modes

### Legacy (`mode=legacy`, template `warp_amnezia`)

Standard WireGuard `[Interface]` + `[Peer]` with AmneziaWG obfuscation fields:
`Jc`, `Jmin`, `Jmax`, `S1`–`S4`, `H1`–`H4`, `I1`.

### AWG 2.0 (`mode=awg2`, template `warp_amnezia_awg2`)

Same as Legacy plus `S3`, `S4`; enforces **S1=S2=S3=S4=0**, **H1–H4=1..4**, **MTU=1280**
for WARP compatibility. Self-hosted templates (`awg2_random`, `awg2_dpi`) generate random S/H.

---

## Critical invariants

### AWG 2.0 / WARP — S3/S4 must be zero

Cloudflare's peer is stock WireGuard and does **not** add S1–S4 byte prefixes.
Non-zero S3/S4 on the client breaks the tunnel silently.
`warp_amnezia_awg2` template enforces `S1=S2=S3=S4=0`. **Never change this for WARP templates.**

### `I1` field case

The `.conf` format uses **uppercase `I1`** in both modes.
`amneziawg-go` UAPI internally uses lowercase `i1`, but that is a different channel.
Lowercase `i1` in the file causes the AmneziaWG Windows client to silently ignore the CPS payload.
All verified working configs use uppercase `I1`.
Ref: [wg-easy #2439](https://github.com/wg-easy/wg-easy/issues/2439).

### Field order in AWG 2.0 `[Interface]`

`PrivateKey` → `Address` → `DNS` → `MTU` → `Jc` → `Jmin` → `Jmax` → `S1`–`S4` → `H1`–`H4` → `I1` (optional).

---

## AllowedIPs — IPv4 default and CIDR limit

### IPv4-only by default

`api/ipListFetch.js` exports:

```js
fetchCidrsForDomains(sites, { includeIpv6 = false } = {})
```

Default returns **only IPv4 CIDRs** from `iplist.opencck.org`.
Pass `{ includeIpv6: true }` to also include IPv6.
Cache key includes version flag (`_4` / `_46`) so both variants cache independently.

**Rationale**: IPv6 CIDRs double the route count and are not required for most blocked services.
Routers (GL.iNet, Keenetic, MikroTik) and iOS/Android clients have limited routing-table capacity
and can fail silently or reset the tunnel when the route list is too large.

### CIDR limit in the frontend

`MAX_CIDR_LIMIT = 2000` (IPv4 CIDRs) in `public/static/script.js`.

Key functions:

| Function | What it does |
| --- | --- |
| `refreshPresetStats()` | Debounced (480 ms). Calls `/api/iplist?presets=...` after each tile toggle. Reads `count4` from response. |
| `updateCidrCounter(count4)` | Updates `#cidrCounter` text and CSS state (`--warn` at 80 %, `--over` at 100 %). |
| `updateTileDisabledState()` | Disables unchecked tiles when `cidrCount4 ≥ MAX_CIDR_LIMIT`. Checked tiles stay interactive so users can deselect. |

Warning shown in `#presetStats` when limit is reached. Tile checkboxes (unchecked) become `disabled` + `.cfg-tile--disabled`.

### IPv6 toggle

`#ipv6Toggle` checkbox in the settings modal → sets `cfgState.includeIpv6`.
When on, `/api/iplist` and `/api/warp` requests include `?ipv6=1`.
The CIDR counter **always shows IPv4 count** regardless of toggle state.

### API response fields (iplist.js, preset resolution mode)

```json
{ "count": 120, "count4": 120, "count6": 0, "cidrs": [...], "sitesQueried": 15 }
```

`count4` — IPv4-only count (used by the UI counter).
`count6` — extra IPv6 CIDRs added when `ipv6=1` (informational).
`count` — total (equals `count4` when IPv6 is off, equals `count4 + count6` when on).

---

## Preset fallback

`public/static/presets-fallback.json` is a static snapshot of `api/routePresets.js`.
The frontend loads it when `/api/iplist` is unreachable (e.g. opening `public/` without `vercel dev`).
**Always run `npm run presets:fallback` after editing `routePresets.js`.**
