# CPS Protocol Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-selectable CPS protocol option (Auto/QUIC/DNS/STUN/TLS/SIP/Static) that controls the `I1` field in generated AmneziaWG configs, providing unique DPI fingerprints per generation.

**Architecture:** New `api/cpsGenerator.js` module exports `generateCpsPayload(protocol)` — pure Node.js, no npm deps. `api/warp.js` reads `?cps=` param and calls the new module. Settings modal gets a compact radio-button CPS row using existing `.ipv6-toggle` styles.

**Tech Stack:** Node.js built-ins (`crypto`, `buffer`), vanilla JS frontend, existing i18n system.

---

## File map

| File | Change |
|------|--------|
| `api/cpsGenerator.js` | **New** — all 5 protocol generators + dispatcher |
| `api/warp.js` | Read `cps` param, pass to `resolveI1ForGeneration` |
| `public/index.html` | CPS radio row in settings modal |
| `public/static/script.js` | `cfgState.cpsProtocol`, event handler, `buildWarpQueryString` |
| `public/locales/ru.json` | 3 new keys |
| `public/locales/en.json` | 3 new keys |

---

## Task 1: Create `api/cpsGenerator.js`

**Files:**
- Create: `api/cpsGenerator.js`

- [ ] **Step 1: Create the file with DNS and SIP generators**

Create `api/cpsGenerator.js` with this exact content:

```js
'use strict';

const { randomInt, randomBytes: cryptoRandomBytes } = require('crypto');

// ── helpers ────────────────────────────────────────────────────

const randomBytes = (n) => cryptoRandomBytes(n);

const u8 = (v) => Buffer.from([v & 0xff]);
const u16be = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const u32be = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const concat = (...bufs) => Buffer.concat(bufs.map((b) => Buffer.isBuffer(b) ? b : Buffer.from(b)));

// ── DNS ────────────────────────────────────────────────────────

const DNS_HOSTS = [
  'www.google.com', 'cloudflare.com', 'discord.com',
  'youtube.com', 'api.telegram.org', 'cdn.jsdelivr.net',
];
const DNS_QTYPES = [0x0001, 0x001c, 0x0041]; // A, AAAA, CAA

const encodeDnsName = (host) => {
  const parts = host.split('.');
  const bufs = parts.map((p) => {
    const lbl = Buffer.from(p, 'ascii');
    return concat(u8(lbl.length), lbl);
  });
  return concat(...bufs, u8(0));
};

const generateDnsPayload = () => {
  const txid = u16be(randomInt(1, 65535));
  const flags = u16be(0x0100); // standard query, recursion desired
  const qdcount = u16be(1);
  const zero = u16be(0);
  const host = DNS_HOSTS[randomInt(0, DNS_HOSTS.length)];
  const qname = encodeDnsName(host);
  const qtype = u16be(DNS_QTYPES[randomInt(0, DNS_QTYPES.length)]);
  const qclass = u16be(0x0001); // IN

  // OPT record (EDNS0)
  const opt = concat(
    u8(0),        // root name
    u16be(0x0029), // type OPT
    u16be(1232),   // payload size
    u32be(0),      // extended RCODE + version
    u16be(0),      // RDLENGTH
  );

  return concat(txid, flags, qdcount, zero, zero, zero, qname, qtype, qclass, opt);
};

// ── STUN ───────────────────────────────────────────────────────

const STUN_MAGIC = 0x2112a442;

const crc32 = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return (buf) => {
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
})();

const stunAttr = (type, value) => {
  const pad = (4 - (value.length % 4)) % 4;
  return concat(u16be(type), u16be(value.length), value, Buffer.alloc(pad));
};

const generateStunPayload = () => {
  const txId = randomBytes(12);
  // USERNAME attr (0x0006): random ICE ufrag pair
  const ufrag1 = randomBytes(4).toString('hex');
  const ufrag2 = randomBytes(4).toString('hex');
  const username = stunAttr(0x0006, Buffer.from(`${ufrag1}:${ufrag2}`, 'utf8'));
  // PRIORITY attr (0x0024): 4 bytes
  const priority = stunAttr(0x0024, u32be(randomInt(1000000, 2130706431)));
  // ICE-CONTROLLING (0x802a): 8 bytes tiebreaker
  const tiebreaker = randomBytes(8);
  const iceCtrl = stunAttr(0x802a, tiebreaker);

  // Build header + attrs first, then append FINGERPRINT
  const attrs = concat(username, priority, iceCtrl);
  const msgLen = attrs.length + 8; // +8 for FINGERPRINT attr (4 header + 4 value)
  const header = concat(u16be(0x0001), u16be(msgLen), u32be(STUN_MAGIC), txId);
  const partial = concat(header, attrs);
  const fp = (crc32(partial) ^ 0x5354554e) >>> 0;
  const fingerprintAttr = stunAttr(0x8028, u32be(fp));

  return concat(partial, fingerprintAttr);
};

// ── TLS ClientHello ────────────────────────────────────────────

const TLS_HOSTS = [
  'www.google.com', 'cloudflare.com', 'discord.com',
  'api.telegram.org', 'youtube.com',
];

const tlsExt = (type, data) => concat(u16be(type), u16be(data.length), data);

const generateTlsPayload = () => {
  const host = TLS_HOSTS[randomInt(0, TLS_HOSTS.length)];
  const clientRandom = randomBytes(32);
  const sessionId = randomBytes(32);

  // SNI extension (0x0000)
  const hostBuf = Buffer.from(host, 'ascii');
  const sniEntry = concat(u8(0), u16be(hostBuf.length), hostBuf);
  const sniList = concat(u16be(sniEntry.length), sniEntry);
  const sniExt = tlsExt(0x0000, sniList);

  // supported_versions (0x002b): TLS 1.3 + 1.2
  const versExt = tlsExt(0x002b, concat(u8(4), u16be(0x0304), u16be(0x0303)));

  // supported_groups (0x000a): x25519, secp256r1
  const groupsExt = tlsExt(0x000a, concat(u16be(4), u16be(0x001d), u16be(0x0017)));

  // ALPN (0x0010): h2, http/1.1
  const h2 = concat(u8(2), Buffer.from('h2'));
  const http11 = concat(u8(8), Buffer.from('http/1.1'));
  const alpnList = concat(u16be(h2.length + http11.length), h2, http11);
  const alpnExt = tlsExt(0x0010, concat(u16be(alpnList.length), alpnList));

  // key_share (0x0033): x25519 key
  const pubKey = randomBytes(32);
  const ksEntry = concat(u16be(0x001d), u16be(32), pubKey);
  const ksExt = tlsExt(0x0033, concat(u16be(ksEntry.length), ksEntry));

  const extensions = concat(sniExt, versExt, groupsExt, alpnExt, ksExt);

  // Cipher suites: TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256
  const ciphers = concat(u16be(0x1301), u16be(0x1302), u16be(0x1303));

  // ClientHello body
  const chBody = concat(
    u16be(0x0303),             // legacy version
    clientRandom,
    u8(sessionId.length), sessionId,
    u16be(ciphers.length), ciphers,
    u8(1), u8(0),              // compression methods: null
    u16be(extensions.length), extensions,
  );

  // Handshake header: type=1 (ClientHello), 3-byte length
  const chLen = chBody.length;
  const handshake = concat(
    u8(0x01),
    u8((chLen >> 16) & 0xff), u8((chLen >> 8) & 0xff), u8(chLen & 0xff),
    chBody,
  );

  // TLS record: type=22 (handshake), version=0x0301, length
  return concat(u8(0x16), u16be(0x0301), u16be(handshake.length), handshake);
};

// ── QUIC Initial (plaintext, no encryption) ───────────────────
// Produces a valid-looking QUIC Initial packet with a TLS ClientHello
// inside a CRYPTO frame. Not RFC-9001-encrypted (no secret derivation)
// but structurally correct and sufficient for DPI camouflage.

const QUIC_VERSION = 0x00000001; // QUIC v1

const varInt = (n) => {
  if (n < 64) return u8(n);
  if (n < 16384) return u16be(n | 0x4000);
  return u32be(n | 0x80000000);
};

const generateQuicPayload = () => {
  const host = TLS_HOSTS[randomInt(0, TLS_HOSTS.length)];
  const dcid = randomBytes(8);
  const scid = randomBytes(8);
  const pktNum = randomInt(0, 256);

  // Build TLS ClientHello (reuse same logic, QUIC variant has no TLS record wrapper)
  const clientRandom = randomBytes(32);
  const sessionId = Buffer.alloc(0); // QUIC uses empty session ID

  const hostBuf = Buffer.from(host, 'ascii');
  const sniEntry = concat(u8(0), u16be(hostBuf.length), hostBuf);
  const sniList = concat(u16be(sniEntry.length), sniEntry);
  const sniExt = tlsExt(0x0000, sniList);
  const versExt = tlsExt(0x002b, concat(u8(2), u16be(0x0304)));
  const groupsExt = tlsExt(0x000a, concat(u16be(2), u16be(0x001d)));
  const pubKey = randomBytes(32);
  const ksEntry = concat(u16be(0x001d), u16be(32), pubKey);
  const ksExt = tlsExt(0x0033, concat(u16be(ksEntry.length), ksEntry));
  // QUIC transport parameters ext (0x0039)
  const qtpExt = tlsExt(0x0039, concat(
    u8(0x01), u8(2), u16be(65527), // max_idle_timeout
    u8(0x04), u8(4), u32be(1048576), // initial_max_data
  ));

  const exts = concat(sniExt, versExt, groupsExt, ksExt, qtpExt);
  const ciphers = concat(u16be(0x1301), u16be(0x1302));
  const chBody = concat(
    u16be(0x0303), clientRandom,
    u8(0),                         // empty session ID
    u16be(ciphers.length), ciphers,
    u8(1), u8(0),
    u16be(exts.length), exts,
  );
  const chLen = chBody.length;
  const ch = concat(
    u8(0x01),
    u8((chLen >> 16) & 0xff), u8((chLen >> 8) & 0xff), u8(chLen & 0xff),
    chBody,
  );

  // CRYPTO frame: type=0x06, offset=0, length=ch.length, data=ch
  const cryptoFrame = concat(u8(0x06), varInt(0), varInt(ch.length), ch);

  // Padding PING frames to ~1200 bytes total
  const targetPayloadLen = 1162;
  const pad = Math.max(0, targetPayloadLen - cryptoFrame.length);
  const padding = Buffer.alloc(pad, 0x00); // PADDING frames

  const payload = concat(cryptoFrame, padding);

  // QUIC Initial packet header (Long Header, type=0x00)
  // First byte: 1 (long) | 1 (fixed) | 00 (initial) | 00 (reserved) | 00 (pkt num len-1)
  const firstByte = 0xc0; // long header, initial type, 1-byte pkt number
  const header = concat(
    u8(firstByte),
    u32be(QUIC_VERSION),
    u8(dcid.length), dcid,
    u8(scid.length), scid,
    u8(0),           // token length = 0
    varInt(payload.length + 1), // payload length + 1 for pkt number
    u8(pktNum),
  );

  return concat(header, payload);
};

// ── SIP (reuse from warpCpsPayloads) ──────────────────────────

const generateSipPayload = () => {
  const { generateSipCpsPair } = require('./warpCpsPayloads');
  return generateSipCpsPair().i1;
};

// ── Static (existing pool) ────────────────────────────────────

const generateStaticPayload = () => {
  const { pickRandomCpsPayload } = require('./warpCpsPayloads');
  return pickRandomCpsPayload();
};

// ── Dispatcher ────────────────────────────────────────────────

const AUTO_PROTOCOLS = ['quic', 'dns', 'stun', 'tls', 'sip'];

const toHex = (buf) => `<b 0x${buf.toString('hex')}>`;

/**
 * Generate a CPS payload for the given protocol key.
 * Returns a string ready for `I1 = ` in the config.
 * @param {string} protocol  auto | quic | dns | stun | tls | sip | static
 * @returns {Promise<string>}
 */
const generateCpsPayload = async (protocol) => {
  const key = String(protocol || 'auto').toLowerCase().trim();

  if (key === 'auto') {
    const picked = AUTO_PROTOCOLS[randomInt(0, AUTO_PROTOCOLS.length)];
    return generateCpsPayload(picked);
  }

  if (key === 'static') return generateStaticPayload();
  if (key === 'sip')    return generateSipPayload();

  let buf;
  if (key === 'quic') buf = generateQuicPayload();
  else if (key === 'dns')  buf = generateDnsPayload();
  else if (key === 'stun') buf = generateStunPayload();
  else if (key === 'tls')  buf = generateTlsPayload();
  else {
    // Unknown protocol → fallback to auto
    const picked = AUTO_PROTOCOLS[randomInt(0, AUTO_PROTOCOLS.length)];
    return generateCpsPayload(picked);
  }

  return toHex(buf);
};

module.exports = { generateCpsPayload };
```

- [ ] **Step 2: Smoke-test the module manually**

Run in the project root:

```bash
node -e "
const { generateCpsPayload } = require('./api/cpsGenerator');
Promise.all(['auto','quic','dns','stun','tls','sip','static','bogus'].map(async p => {
  const r = await generateCpsPayload(p);
  console.log(p, r.slice(0,30) + '...');
})).catch(console.error);
"
```

Expected: 8 lines each starting with `<b 0x...` (no errors, no undefined).

- [ ] **Step 3: Commit**

```bash
git add api/cpsGenerator.js
git commit -m "feat: add cpsGenerator module with QUIC/DNS/STUN/TLS/SIP/static payload generators"
```

---

## Task 2: Wire `cps` param into `api/warp.js`

**Files:**
- Modify: `api/warp.js`

- [ ] **Step 1: Add import at top of `warp.js`**

After the existing `require('./warpCpsPayloads')` line (line ~14), add:

```js
const { generateCpsPayload } = require('./cpsGenerator');
```

- [ ] **Step 2: Read `cps` param in the request handler**

Inside `module.exports = async (req, res) => {`, after the line that reads `routerRaw` (around line 980), add:

```js
const cpsProtocol = String(body.cps ?? pickQuery(req, 'cps') ?? 'auto').toLowerCase().trim();
```

- [ ] **Step 3: Pass `cpsProtocol` into `generateWarpConfig`**

The call to `generateWarpConfig` (line ~982) currently passes `{ includeIpv6, routerMode }` as the last argument. Change it to:

```js
const { text: conf, meta } = await generateWarpConfig(mode, presetKeys, dnsKey, warpExtras, { includeIpv6, routerMode, cpsProtocol });
```

- [ ] **Step 4: Thread `cpsProtocol` through to `resolveI1ForGeneration`**

In `generateWarpConfig` function signature (line ~855), add `cpsProtocol` to `routeOpts`:

```js
const generateWarpConfig = async (mode = 'legacy', presetKeys = [], dnsKey = '', warpExtras = {}, routeOpts = {}) => {
```

(signature unchanged — `cpsProtocol` comes in via `routeOpts.cpsProtocol`)

Then in the body of `generateWarpConfig`, find the line:
```js
const i1 = await resolveI1ForGeneration(warpExtras);
```

Change to:
```js
const i1 = await resolveI1ForGeneration(warpExtras, routeOpts.cpsProtocol);
```

- [ ] **Step 5: Update `resolveI1ForGeneration` to use the new module**

Find `resolveI1ForGeneration` (line ~662). Its current body is:

```js
const resolveI1ForGeneration = async (extras) => {
  if (extras.i1Raw != null && String(extras.i1Raw).trim() !== '') {
    return normalizeI1Payload(extras.i1Raw);
  }
  if (extras.i1Ref) return normalizeI1Payload(await loadI1FromRef(extras.i1Ref));
  if (extras.useEmbeddedAmneziaI1) {
    return normalizeI1Payload(pickRandomCpsPayload());
  }
  return '';
};
```

Replace with:

```js
const resolveI1ForGeneration = async (extras, cpsProtocol = 'auto') => {
  if (extras.i1Raw != null && String(extras.i1Raw).trim() !== '') {
    return normalizeI1Payload(extras.i1Raw);
  }
  if (extras.i1Ref) return normalizeI1Payload(await loadI1FromRef(extras.i1Ref));
  if (extras.useEmbeddedAmneziaI1) {
    return normalizeI1Payload(await generateCpsPayload(cpsProtocol));
  }
  return '';
};
```

- [ ] **Step 6: Verify API still works**

Start the dev server and run:

```bash
npm start
```

In another terminal:

```bash
node -e "
fetch('http://localhost:3000/api/warp?mode=legacy&cps=dns')
  .then(r=>r.json())
  .then(d=>{ const c = Buffer.from(d.content,'base64').toString(); console.log(c.includes('I1 =') ? 'OK: I1 present' : 'MISSING I1'); })
  .catch(console.error);
"
```

Expected output: `OK: I1 present`

Also test without cps param (should default to auto):

```bash
node -e "
fetch('http://localhost:3000/api/warp?mode=legacy')
  .then(r=>r.json())
  .then(d=>{ const c = Buffer.from(d.content,'base64').toString(); console.log(c.includes('I1 =') ? 'OK: I1 present' : 'MISSING I1'); })
  .catch(console.error);
"
```

Expected: `OK: I1 present`

- [ ] **Step 7: Commit**

```bash
git add api/warp.js
git commit -m "feat: wire cps= param to cpsGenerator in warp.js"
```

---

## Task 3: Add CPS row to `public/index.html`

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add CPS radio row inside the settings modal**

Find this block in `index.html` (inside `settings-modal__body`, inside the routes fieldset):

```html
            <div class="cidr-limit-row">
```

Insert the following **immediately before** that `<div class="cidr-limit-row">`:

```html
            <div class="cidr-limit-row">
              <span class="cps-label" data-i18n="cps_label">CPS:</span>
              <label class="ipv6-toggle" title="Случайный протокол при каждой генерации" data-i18n-title="cps_auto_title"><input type="radio" name="cpsProtocol" value="auto" checked /><span data-i18n="cps_auto">Auto</span></label>
              <label class="ipv6-toggle" title="QUIC Initial пакет (RFC 9001)" data-i18n-title="cps_quic_title"><input type="radio" name="cpsProtocol" value="quic" /><span>QUIC</span></label>
              <label class="ipv6-toggle" title="DNS query с случайным Transaction ID" data-i18n-title="cps_dns_title"><input type="radio" name="cpsProtocol" value="dns" /><span>DNS</span></label>
              <label class="ipv6-toggle" title="STUN Binding Request с CRC32" data-i18n-title="cps_stun_title"><input type="radio" name="cpsProtocol" value="stun" /><span>STUN</span></label>
              <label class="ipv6-toggle" title="TLS 1.3 ClientHello" data-i18n-title="cps_tls_title"><input type="radio" name="cpsProtocol" value="tls" /><span>TLS</span></label>
              <label class="ipv6-toggle" title="SIP INVITE (случайный Call-ID)" data-i18n-title="cps_sip_title"><input type="radio" name="cpsProtocol" value="sip" /><span>SIP</span></label>
              <label class="ipv6-toggle" title="Статичные бинарные пэйлоады (3 варианта)" data-i18n-title="cps_static_title"><input type="radio" name="cpsProtocol" value="static" /><span data-i18n="cps_static">Static</span></label>
            </div>
```

Note: this replaces the **opening** `<div class="cidr-limit-row">` tag of the existing block — the new CPS row is a *separate* div that comes before it, not nested inside it. Make sure to keep the original `<div class="cidr-limit-row">` intact below.

- [ ] **Step 2: Visually verify in browser**

Run `npm start`, open `http://localhost:3000`, click ⚙. Confirm:
- CPS row appears above the IPv6/router-mode row
- 7 radio buttons display in a horizontal line
- "Auto" is selected by default
- No new scrollbar appears in the modal on a 1080p screen

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: add CPS protocol selector row to settings modal"
```

---

## Task 4: Wire CPS state in `public/static/script.js`

**Files:**
- Modify: `public/static/script.js`

- [ ] **Step 1: Add `cpsProtocol` to `cfgState`**

Find the `cfgState` object (line ~280). After `routerMode: false,`, add:

```js
  /** CPS protocol for I1 field: auto | quic | dns | stun | tls | sip | static */
  cpsProtocol: 'auto',
```

- [ ] **Step 2: Add event listener for CPS radio buttons**

Find the block where the `routerModeToggle` change listener is wired up. Search for:

```js
routerModeToggle
```

It will be inside a `DOMContentLoaded` or init function. After the `routerModeToggle` change handler, add:

```js
  document.querySelectorAll('[name="cpsProtocol"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      cfgState.cpsProtocol = e.target.value;
    });
  });
```

- [ ] **Step 3: Add `cps` param to `buildWarpQueryString`**

Find `buildWarpQueryString` (line ~393):

```js
const buildWarpQueryString = (mode) => {
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (mode === 'legacy') params.set('template', 'warp_amnezia');
  if (mode === 'awg2') params.set('template', 'warp_amnezia_awg2');
  const routeIds = getSelectedRouteIds();
  if (routeIds.length) params.set('presets', routeIds.join(','));
  const dns = getSelectedDnsKey();
  if (dns) params.set('dns', dns);
  if (cfgState.includeIpv6) params.set('ipv6', '1');
  if (cfgState.routerMode) params.set('router', '1');
  return params.toString();
};
```

Add one line before `return params.toString()`:

```js
  params.set('cps', cfgState.cpsProtocol);
```

- [ ] **Step 4: Verify in browser**

Run `npm start`, open DevTools Network tab, click "Сгенерировать AWG 1.5". Confirm the request URL contains `&cps=auto`. Change to QUIC in settings, generate again — URL must contain `&cps=quic`.

Open the config preview modal and confirm `I1 =` is present in the config text.

- [ ] **Step 5: Commit**

```bash
git add public/static/script.js
git commit -m "feat: wire cpsProtocol state and query param in script.js"
```

---

## Task 5: Add i18n keys to locale files

**Files:**
- Modify: `public/locales/ru.json`
- Modify: `public/locales/en.json`

- [ ] **Step 1: Add keys to `ru.json`**

Open `public/locales/ru.json`. Add these entries (anywhere in the object, e.g. after the `router_mode_label` key):

```json
  "cps_label": "CPS:",
  "cps_auto": "Auto",
  "cps_static": "Static",
  "cps_auto_title": "Случайный протокол при каждой генерации",
  "cps_quic_title": "QUIC Initial пакет (RFC 9001)",
  "cps_dns_title": "DNS query с случайным Transaction ID",
  "cps_stun_title": "STUN Binding Request с CRC32 fingerprint",
  "cps_tls_title": "TLS 1.3 ClientHello",
  "cps_sip_title": "SIP INVITE (случайный Call-ID)"
```

- [ ] **Step 2: Add keys to `en.json`**

Open `public/locales/en.json`. Add:

```json
  "cps_label": "CPS:",
  "cps_auto": "Auto",
  "cps_static": "Static",
  "cps_auto_title": "Random protocol on each generation",
  "cps_quic_title": "QUIC Initial packet (RFC 9001)",
  "cps_dns_title": "DNS query with random Transaction ID",
  "cps_stun_title": "STUN Binding Request with CRC32 fingerprint",
  "cps_tls_title": "TLS 1.3 ClientHello",
  "cps_sip_title": "SIP INVITE (random Call-ID)"
```

- [ ] **Step 3: Verify tooltips appear in both languages**

Run `npm start`. Switch language to EN, open ⚙ settings. Hover over "Auto" radio — tooltip should appear in English. Switch to RU — tooltip in Russian.

- [ ] **Step 4: Final commit**

```bash
git add public/locales/ru.json public/locales/en.json
git commit -m "i18n: add CPS protocol selector locale keys (ru + en)"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| New `api/cpsGenerator.js` with 5 protocols + auto + static | Task 1 |
| `warp.js` reads `cps` param | Task 2 step 2 |
| `resolveI1ForGeneration` uses new module | Task 2 step 5 |
| CPS radio row in settings modal | Task 3 |
| `.ipv6-toggle` style reuse, compact horizontal | Task 3 (uses existing class) |
| `cfgState.cpsProtocol` + event handler | Task 4 steps 1–2 |
| `buildWarpQueryString` includes `cps=` | Task 4 step 3 |
| i18n keys: `cps_label`, `cps_auto`, `cps_static` + tooltips | Task 5 |
| No new npm dependencies | Task 1 (uses only `crypto`, `buffer`) ✓ |
| `static` uses existing `pickRandomCpsPayload` — no regression | Task 1 + Task 2 step 5 ✓ |

All spec requirements covered. No placeholders. No TBDs.
