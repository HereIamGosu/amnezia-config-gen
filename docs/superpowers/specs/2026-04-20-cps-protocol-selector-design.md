# CPS Protocol Selector — Design Spec

**Date:** 2026-04-20  
**Status:** Approved

## Summary

Add a user-selectable CPS protocol option to the AmneziaWG config generator. Each generated config's `I1` field will contain a live payload mimicking a chosen network protocol (QUIC, DNS, STUN, TLS, SIP) instead of rotating among 3 static binary blobs. Default mode `auto` picks randomly per generation. A compact UI row is added to the existing settings modal (⚙).

Source of generator logic: [payloadGen](https://github.com/Sketchystan1/payloadGen) by Sketchystan1 (MIT), adapted for Node.js server-side use.

---

## Architecture

### New file: `api/cpsGenerator.js`

Single-responsibility module. Exports one function:

```js
generateCpsPayload(protocol: string): Promise<string>
```

Returns a `<b 0x...>` string ready for `I1 =` insertion.

**Supported protocols:**

| Key | Description | Source |
|-----|-------------|--------|
| `auto` | Random from `[quic, dns, stun, tls, sip]` | picks one at runtime |
| `quic` | QUIC Initial packet with TLS 1.3 ClientHello, encrypted per RFC 9001 | adapted from payloadGen `generateQuicPayloadAsync` + `crypto.js` |
| `dns` | DNS query with random transaction ID and EDNS OPT | adapted from payloadGen `generateDnsPayload` |
| `stun` | STUN Binding Request with CRC32 fingerprint | adapted from payloadGen `generateStunBindingPayload` |
| `tls` | TLS 1.3 ClientHello record | adapted from payloadGen `generateTlsClientHelloPayload` |
| `sip` | SIP INVITE + 100 Trying (randomised Call-ID, branch, tag) | already in `warpCpsPayloads.js` as `generateSipCpsPair`, reused |
| `static` | Existing 3-blob pool from `warpCpsPayloads.js` | unchanged fallback |

`auto` excludes `static` to maximise DPI diversity.

**Internal structure:**

```
generateCpsPayload(protocol)
  → resolveProtocol(protocol)   // 'auto' → random pick
  → dispatch to generator fn
  → return "<b 0x{hex}>"
```

All generators produce a `Buffer` or `Uint8Array`, converted to hex at the end. Async generators (QUIC) use `await`; sync ones are wrapped in `Promise.resolve`.

**Dependencies:** Only Node built-ins (`crypto`, `buffer`) — no new npm packages.

---

### Modified: `api/warp.js`

1. Import `generateCpsPayload` from `./cpsGenerator`.
2. Read `cps` query/body param in the request handler (alongside existing params).
3. Pass `cpsProtocol` into `generateWarpConfig()` → `resolveI1ForGeneration()`.
4. In `resolveI1ForGeneration`: when `useEmbeddedAmneziaI1` is true, call `generateCpsPayload(cpsProtocol)` instead of `pickRandomCpsPayload()`.

`pickRandomCpsPayload` stays available as the `static` protocol implementation — no removal.

Valid `cps` values: `auto`, `quic`, `dns`, `stun`, `tls`, `sip`, `static`. Unknown values fall back to `auto`.

---

### Modified: `public/index.html`

Add a compact CPS row inside the existing `cidr-limit-row` div (or immediately after it), within the routes `fieldset`. Matches the visual style of existing toggle labels:

```html
<div class="cidr-limit-row cps-protocol-row">
  <span class="cps-label" data-i18n="cps_label">CPS:</span>
  <label class="ipv6-toggle" title="..."><input type="radio" name="cpsProtocol" value="auto" checked><span data-i18n="cps_auto">Auto</span></label>
  <label class="ipv6-toggle" title="..."><input type="radio" name="cpsProtocol" value="quic"><span>QUIC</span></label>
  <label class="ipv6-toggle" title="..."><input type="radio" name="cpsProtocol" value="dns"><span>DNS</span></label>
  <label class="ipv6-toggle" title="..."><input type="radio" name="cpsProtocol" value="stun"><span>STUN</span></label>
  <label class="ipv6-toggle" title="..."><input type="radio" name="cpsProtocol" value="tls"><span>TLS</span></label>
  <label class="ipv6-toggle" title="..."><input type="radio" name="cpsProtocol" value="sip"><span>SIP</span></label>
  <label class="ipv6-toggle" title="..."><input type="radio" name="cpsProtocol" value="static"><span data-i18n="cps_static">Static</span></label>
</div>
```

Uses existing `.ipv6-toggle` styles — no new CSS class needed. Row wraps naturally on narrow screens.

---

### Modified: `public/static/script.js`

1. Add `cfgState.cpsProtocol = 'auto'` to state object.
2. On `change` event on `[name="cpsProtocol"]` radios → update `cfgState.cpsProtocol`.
3. In `buildApiUrl()` (or equivalent request builder) → always append `&cps=${cfgState.cpsProtocol}` (including `'auto'`), so server behaviour is explicit and not reliant on a "missing param = auto" assumption.

---

### Modified: `public/static/styles.css`

No new rules required. `.ipv6-toggle` and `.cidr-limit-row` already handle wrapping layout. If visual separation is needed, one rule may be added to give the CPS row a top border or margin — decision deferred to implementation.

---

## Data flow

```
User picks "QUIC" in settings modal
  → cfgState.cpsProtocol = 'quic'
  → GET /api/warp?mode=awg2&cps=quic&...
  → warp.js reads cps='quic'
  → resolveI1ForGeneration({ ..., cpsProtocol: 'quic' })
  → cpsGenerator.generateCpsPayload('quic')
  → encrypted QUIC Initial packet as <b 0x...>
  → I1 = <b 0x...> in generated .conf
```

---

## Constraints & invariants

- `static` mode calls `pickRandomCpsPayload()` unchanged — no regression for current behaviour.
- `auto` (default, no `cps` param) calls `generateCpsPayload('auto')` which picks randomly — slight improvement over old static-only random.
- QUIC generator uses Node `crypto` module (SubtleCrypto polyfill not needed — server-side only).
- No new npm dependencies.
- CPS row adds ~20px height to settings modal body — stays within `max-height: min(90dvh, 900px)`, no new scroll on typical screens.
- i18n keys added: `cps_label`, `cps_auto`, `cps_static` (other protocol names are proper nouns, no translation needed).

---

## Files changed

| File | Change |
|------|--------|
| `api/cpsGenerator.js` | **New** — all protocol generators |
| `api/warp.js` | Read `cps` param, wire to `cpsGenerator` |
| `public/index.html` | CPS radio row in settings modal |
| `public/static/script.js` | State + request param for CPS choice |
| `public/static/styles.css` | Minor tweak only if needed |
| `locales/ru.json` + `locales/en.json` | 3 new i18n keys |
