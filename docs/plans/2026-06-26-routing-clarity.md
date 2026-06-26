# Routing Clarity (2.6.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit Full tunnel / Split tunnel toggle so users understand what goes into AllowedIPs before generating a config.

**Architecture:** Three-layer change — (1) backend adds `routeMode` param validation with early-return guards before WARP registration; (2) frontend state gets `routeMode` field + segmented control UI in the Routes tab; (3) a dynamic AllowedIPs explanation block updates on every relevant toggle. No new dependencies, no new modules, backward-compatible API.

**Tech Stack:** Vanilla JS (browser), Node.js serverless (Vercel), node:test + node:assert for tests, ESLint, JSON i18n.

## Global Constraints

- No new npm dependencies
- No database, cron, queue, or Vercel KV
- No custom CIDR input, no import from file/URL
- All strings go through `t()` in `public/locales/ru.json` + `en.json` — no hardcoded UI strings
- `npm run lint` must pass with `--max-warnings 0`
- `npm test` runs `node --test "__tests__/**/*.test.js"`
- Backend validation must happen BEFORE WARP device registration
- Backward compat: requests without `routeMode` must behave exactly as before
- `ROUTE_MODES` constant must be used everywhere — no `'full'`/`'split'` string literals scattered in code
- Preset tile checkboxes must NOT be set to `disabled` in full tunnel mode (state must survive mode switch)

---

## File Map

| File | Action | What changes |
|---|---|---|
| `api/warp.js` | Modify | Parse `routeMode`, validate, `effectivePresetKeys`, add `routeMode` to response |
| `__tests__/routing-mode.test.js` | Create | 7 backend test cases for routeMode validation |
| `public/static/script.js` | Modify | `ROUTE_MODES` const, `routeMode` in `cfgState`, `updateRouteModeUI`, `updateAllowedIpsExplanation`, update `updateCidrCounter`, update `buildWarpQueryString`, guard in generate handler, update `getResultStateSnapshot` |
| `public/index.html` | Modify | Route-mode-block + allowedIpsExplanation divs in `#panel-routes` |
| `public/static/styles.css` | Modify | Segmented control styles + `.routes-panel--full-tunnel` dimming |
| `public/locales/ru.json` | Modify | 14 new i18n keys |
| `public/locales/en.json` | Modify | 14 new i18n keys (English) |
| `public/static/result-explanation.js` | Modify | Use `state.routeMode` directly when available |
| `CHANGELOG.md` | Modify | Add 2.6.0 section |
| `README.md` | Modify | Add one line to Features |
| `README.ru.md` | Modify | Same in Russian |
| `docs/manual-checks/routing-mode.md` | Create | Manual check checklist |

---

## Task 1: Backend validation — `routeMode` param in `api/warp.js`

**Files:**
- Modify: `api/warp.js` (around line 1188 — after `mobileMode` parsing, before `generateMultipleWarpConfigs`)
- Create: `__tests__/routing-mode.test.js`

**Interfaces:**
- Produces: `routeMode` field in 200 response (`'full' | 'split'`); 400 `{ success: false, error: 'invalid_route_mode' | 'empty_split_tunnel', message: string }` when invalid

- [ ] **Step 1: Create the test file with failing tests**

```js
// __tests__/routing-mode.test.js
'use strict';

const assert = require('node:assert/strict');
const { test, describe } = require('node:test');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const net = require('node:net');

const realNetCreate = net.createConnection.bind(net);

function makeReq(query = {}) {
  return {
    method: 'GET',
    url: '/api/warp?' + new URLSearchParams(query).toString(),
    query,
    body: null,
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
  };
}

function makeRes() {
  let status = 200;
  let body = null;
  const res = {
    setHeader() {},
    status(code) { status = code; return res; },
    json(data) { body = data; return res; },
    getStatus: () => status,
    getBody: () => body,
  };
  return res;
}

function clearModules() {
  for (const m of ['../api/warp', '../src/server/endpointCache', '../src/server/endpointHealth']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
}

describe('routeMode validation — early 400 returns (no WARP mock needed)', () => {
  test('routeMode=invalid → 400 invalid_route_mode', async () => {
    clearModules();
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2', routeMode: 'bogus' }), res);
    assert.equal(res.getStatus(), 400);
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.equal(body.error, 'invalid_route_mode');
    assert.ok(Array.isArray(body.allowedRouteModes));
    assert.ok(body.allowedRouteModes.includes('full'));
    assert.ok(body.allowedRouteModes.includes('split'));
  });

  test('routeMode=split + no presets → 400 empty_split_tunnel', async () => {
    clearModules();
    const handler = require('../api/warp');
    const res = makeRes();
    await handler(makeReq({ mode: 'awg2', routeMode: 'split' }), res);
    assert.equal(res.getStatus(), 400);
    const body = res.getBody();
    assert.equal(body.success, false);
    assert.equal(body.error, 'empty_split_tunnel');
    assert.ok(typeof body.message === 'string' && body.message.length > 0);
  });
});

const FAKE_WARP = JSON.stringify({
  result: {
    id: 'rt-id', token: 'rt-token',
    config: {
      peers: [{ public_key: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=', endpoint: { v4: '162.159.192.1:2408' } }],
      interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
    },
  },
});

function installWarpMock() {
  const { mock } = require('node:test');
  return mock.method(https, 'request', (_opts, cb) => {
    const fakeRes = new EventEmitter();
    fakeRes.statusCode = 200;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      cb(fakeRes);
      fakeRes.emit('data', Buffer.from(FAKE_WARP));
      fakeRes.emit('end');
    });
    return req;
  });
}

function mockNetOk() {
  const sock = new EventEmitter();
  sock.destroy = () => {};
  setImmediate(() => sock.emit('connect'));
  return sock;
}

describe('routeMode validation — positive paths (WARP mock)', () => {
  test('no routeMode + no presets → 200 (legacy full tunnel)', async () => {
    clearModules();
    const m = installWarpMock();
    net.createConnection = (_o, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2' }), res);
      assert.equal(res.getStatus(), 200);
      assert.equal(res.getBody().success, true);
    } finally { m.mock.restore(); net.createConnection = realNetCreate; }
  });

  test('routeMode=full + no presets → 200', async () => {
    clearModules();
    const m = installWarpMock();
    net.createConnection = (_o, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2', routeMode: 'full' }), res);
      assert.equal(res.getStatus(), 200);
      const body = res.getBody();
      assert.equal(body.success, true);
      assert.equal(body.routeMode, 'full');
    } finally { m.mock.restore(); net.createConnection = realNetCreate; }
  });

  test('routeMode=full + presets sent → response routeMode is full (presets ignored in AllowedIPs)', async () => {
    clearModules();
    const m = installWarpMock();
    net.createConnection = (_o, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2', routeMode: 'full', presets: 'youtube' }), res);
      assert.equal(res.getStatus(), 200);
      assert.equal(res.getBody().routeMode, 'full');
    } finally { m.mock.restore(); net.createConnection = realNetCreate; }
  });

  test('no routeMode + presets → 200 (legacy split behavior)', async () => {
    clearModules();
    const m = installWarpMock();
    net.createConnection = (_o, cb) => { const s = mockNetOk(); if (cb) setImmediate(cb); return s; };
    try {
      const handler = require('../api/warp');
      const res = makeRes();
      await handler(makeReq({ mode: 'awg2', presets: 'telegram' }), res);
      assert.equal(res.getStatus(), 200);
      assert.equal(res.getBody().success, true);
    } finally { m.mock.restore(); net.createConnection = realNetCreate; }
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (feature not yet implemented)**

```
npm test -- --test-name-pattern="routeMode"
```

Expected: Most tests fail — `invalid_route_mode` and `empty_split_tunnel` errors don't exist yet; positive tests may pass or fail depending on existing behavior.

- [ ] **Step 3: Add `routeMode` parsing and validation to `api/warp.js`**

Find the line `const routeOpts = { includeIpv6, routerMode, cpsProtocol, extraCps, mobileMode };` (around line 1194) and insert before it:

```js
// ── routeMode validation ──────────────────────────────────────────────────────
const routeModeRaw = String(
  body.routeMode ?? pickQuery(req, 'routeMode') ?? ''
).trim().toLowerCase();

const VALID_ROUTE_MODES = ['full', 'split'];

if (routeModeRaw && !VALID_ROUTE_MODES.includes(routeModeRaw)) {
  res.status(400).json({
    success: false,
    error: 'invalid_route_mode',
    message: 'Invalid route mode. Allowed values: full, split.',
    allowedRouteModes: VALID_ROUTE_MODES,
  });
  return;
}

const hasExplicitRouteMode = routeModeRaw === 'full' || routeModeRaw === 'split';

if (routeModeRaw === 'split' && presetKeys.length === 0) {
  res.status(400).json({
    success: false,
    error: 'empty_split_tunnel',
    message: 'Split tunnel requires at least one selected route preset.',
  });
  return;
}

// Full tunnel override: ignore presets even if they were sent in the request
const effectivePresetKeys = (hasExplicitRouteMode && routeModeRaw === 'full')
  ? []
  : presetKeys;
// ─────────────────────────────────────────────────────────────────────────────
```

Then replace the call on line ~1196 from:
```js
const { configs, warning } = await generateMultipleWarpConfigs(count, mode, presetKeys, dnsKey, warpExtras, routeOpts);
```
to:
```js
const { configs, warning } = await generateMultipleWarpConfigs(count, mode, effectivePresetKeys, dnsKey, warpExtras, routeOpts);
```

- [ ] **Step 4: Add `routeMode` to the 200 response**

Find `res.status(200).json({` and add `routeMode` field after `mode`:

```js
routeMode: hasExplicitRouteMode
  ? routeModeRaw
  : (presetKeys.length ? 'split' : 'full'),
```

- [ ] **Step 5: Run tests to confirm they pass**

```
npm test -- --test-name-pattern="routeMode"
```

Expected: All 7 tests PASS.

- [ ] **Step 6: Run full test suite to confirm no regressions**

```
npm test
```

Expected: All existing tests PASS.

- [ ] **Step 7: Run lint**

```
npm run lint
```

Expected: 0 warnings, 0 errors.

- [ ] **Step 8: Commit**

```
git add api/warp.js __tests__/routing-mode.test.js
git commit -m "feat(api): добавить валидацию routeMode — full/split + empty_split_tunnel guard"
```

---

## Task 2: Frontend state — `ROUTE_MODES` + `cfgState.routeMode` + `buildWarpQueryString` + generate guard

**Files:**
- Modify: `public/static/script.js`

**Interfaces:**
- Consumes: nothing new
- Produces: `cfgState.routeMode`, `ROUTE_MODES.FULL`, `ROUTE_MODES.SPLIT`, updated `buildWarpQueryString` (sends `routeMode`, omits `presets` in full mode), `getResultStateSnapshot` includes `routeMode`

- [ ] **Step 1: Add `ROUTE_MODES` constant**

In `public/static/script.js`, find the line `const MAX_CIDR_LIMIT = 1000;` (around line 548) and add after it:

```js
/** Routing mode enum. Always use these constants — never bare string literals. */
const ROUTE_MODES = Object.freeze({ FULL: 'full', SPLIT: 'split' });
```

- [ ] **Step 2: Add `routeMode` field to `cfgState`**

In `cfgState` object (around line 589), add after `mobileMode`:

```js
/** Explicit routing mode. 'full' = all traffic through tunnel; 'split' = only selected presets. */
routeMode: ROUTE_MODES.FULL,
```

- [ ] **Step 3: Update `buildWarpQueryString` — send `routeMode`, gate presets on split mode**

Find `buildWarpQueryString` (around line 735). Replace the lines:
```js
const routeIds = getSelectedRouteIds();
if (routeIds.length) params.set('presets', routeIds.join(','));
```
with:
```js
params.set('routeMode', cfgState.routeMode);
// Only send presets in split mode — in full tunnel presets must not reach the server
if (cfgState.routeMode === ROUTE_MODES.SPLIT) {
  const routeIds = getSelectedRouteIds();
  if (routeIds.length) params.set('presets', routeIds.join(','));
}
```

- [ ] **Step 4: Add frontend guard in the generate handler**

Find `const startedAt = telemetryNow();` in the generate handler (around line 1328). Add BEFORE `setAllGenerateButtonsDisabled(true)`:

```js
// Empty split tunnel guard
if (cfgState.routeMode === ROUTE_MODES.SPLIT && getSelectedRouteIds().length === 0) {
  status.textContent = t('routing_empty_split_error',
    'Для выборочной маршрутизации выберите хотя бы одно направление или переключитесь на полный туннель.');
  return;
}
```

- [ ] **Step 5: Add `routeMode` to `getResultStateSnapshot`**

Find `getResultStateSnapshot` (around line 528). Add `routeMode: cfgState.routeMode,` to the returned object:

```js
const getResultStateSnapshot = () => ({
  configCount: cfgState.configCount,
  warpEndpoint: cfgState.warpEndpoint,
  port: cfgState.port,
  routePresets: getSelectedRouteIds(),
  mobileMode: cfgState.mobileMode,
  routerMode: cfgState.routerMode,
  routeMode: cfgState.routeMode,   // ← add this line
  // ... rest unchanged
});
```

- [ ] **Step 6: Run lint**

```
npm run lint
```

Expected: 0 warnings, 0 errors.

- [ ] **Step 7: Commit**

```
git add public/static/script.js
git commit -m "feat(frontend): добавить ROUTE_MODES, cfgState.routeMode, обновить buildWarpQueryString и generate guard"
```

---

## Task 3: HTML structure — route-mode toggle + explanation block

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Produces: `#routeModeFull`, `#routeModeSplit` buttons; `#routeModeDescription` paragraph; `#presetsIgnoredNotice` paragraph; `#allowedIpsExplanation` div

- [ ] **Step 1: Add route-mode-block and allowedIpsExplanation to #panel-routes**

In `public/index.html`, find `<!-- ── Tab 1: Маршруты ── -->` section (around line 807). Insert **before** the existing `<div class="cfg-tiles-actions">`:

```html
<!-- Route Mode Toggle (2.6.0) -->
<div class="route-mode-block">
  <div class="route-mode-toggle" role="group" aria-labelledby="routeModeLabel">
    <span id="routeModeLabel" class="route-mode-toggle__label" data-i18n="routing_mode_title">Маршрутизация</span>
    <div class="route-mode-toggle__buttons">
      <button type="button" class="route-mode-btn route-mode-btn--active"
              id="routeModeFull" data-i18n="routing_mode_full">Полный туннель</button>
      <button type="button" class="route-mode-btn"
              id="routeModeSplit" data-i18n="routing_mode_split">Выборочная</button>
    </div>
  </div>
  <p id="routeModeDescription" class="route-mode-description" aria-live="polite"></p>
  <p id="presetsIgnoredNotice" class="route-mode-notice route-mode-notice--info" hidden
     data-i18n="routing_presets_ignored_in_full">
    Вы выбрали полный туннель. Presets не будут ограничивать маршруты в этом режиме.
  </p>
</div>
<!-- AllowedIPs explanation (2.6.0) -->
<div id="allowedIpsExplanation" class="allowed-ips-explanation" aria-live="polite"></div>
```

- [ ] **Step 2: Verify HTML is valid — open app and confirm no JS errors on load**

Run: `npm start` (starts Vercel dev at http://localhost:3000)

Open http://localhost:3000 → open DevTools console → confirm no errors related to the new element IDs.

The buttons won't do anything yet (JS wiring comes in Task 5) — that is expected.

- [ ] **Step 3: Commit**

```
git add public/index.html
git commit -m "feat(html): добавить route-mode-block и allowedIpsExplanation в таб Маршруты"
```

---

## Task 4: CSS — segmented control + explanation + dimming

**Files:**
- Modify: `public/static/styles.css`

**Interfaces:**
- Produces: CSS classes `.route-mode-block`, `.route-mode-toggle`, `.route-mode-toggle__label`, `.route-mode-toggle__buttons`, `.route-mode-btn`, `.route-mode-btn--active`, `.route-mode-description`, `.route-mode-notice--info`, `.allowed-ips-explanation`, `.allowed-ips-explanation__line`, `.routes-panel--full-tunnel` (dimming rule)

- [ ] **Step 1: Add CSS rules at end of `public/static/styles.css`**

Append to the end of the file:

```css
/* ── Route Mode Toggle (2.6.0) ─────────────────────────────────────────────── */
.route-mode-block {
  margin-bottom: 12px;
}

.route-mode-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.route-mode-toggle__label {
  font-size: 0.85rem;
  color: var(--color-text-secondary, #888);
  white-space: nowrap;
  user-select: none;
}

.route-mode-toggle__buttons {
  display: flex;
  border: 1px solid var(--color-border, #444);
  border-radius: 4px;
  overflow: hidden;
}

.route-mode-btn {
  padding: 4px 12px;
  font-size: 0.85rem;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--color-text, #ccc);
  transition: background 0.15s, color 0.15s;
}

.route-mode-btn:hover:not(.route-mode-btn--active) {
  background: var(--color-hover, rgba(255,255,255,0.07));
}

.route-mode-btn + .route-mode-btn {
  border-left: 1px solid var(--color-border, #444);
}

.route-mode-btn--active {
  background: var(--color-accent, #5a9fd4);
  color: #fff;
}

.route-mode-description {
  font-size: 0.8rem;
  color: var(--color-text-secondary, #888);
  margin: 0 0 4px;
  min-height: 1.2em;
}

.route-mode-notice--info {
  font-size: 0.78rem;
  color: var(--color-warning, #c9a227);
  margin: 0 0 8px;
  padding: 4px 8px;
  background: var(--color-warning-bg, rgba(201,162,39,0.1));
  border-radius: 4px;
  border-left: 2px solid var(--color-warning, #c9a227);
}

/* ── AllowedIPs Explanation (2.6.0) ──────────────────────────────────────────── */
.allowed-ips-explanation {
  margin-bottom: 10px;
}

.allowed-ips-explanation__line {
  font-size: 0.78rem;
  color: var(--color-text-secondary, #888);
  margin: 2px 0;
  line-height: 1.4;
}

/* ── Full Tunnel dimming (2.6.0) ──────────────────────────────────────────────── */
/* Preset tiles become non-interactive in full tunnel mode.
   Checkboxes are NOT disabled so their state survives mode switch. */
.routes-panel--full-tunnel .cfg-tiles--routes,
.routes-panel--full-tunnel .cfg-tiles-actions,
.routes-panel--full-tunnel .cidr-counter-mini,
.routes-panel--full-tunnel #presetStats {
  opacity: 0.4;
  pointer-events: none;
  user-select: none;
}
```

- [ ] **Step 2: Run lint**

```
npm run lint
```

Expected: 0 warnings, 0 errors. (ESLint doesn't lint CSS, but confirms no other issues.)

- [ ] **Step 3: Commit**

```
git add public/static/styles.css
git commit -m "feat(css): добавить стили route-mode toggle, explanation block, full-tunnel dimming"
```

---

## Task 5: JS UI logic — `updateRouteModeUI`, `updateAllowedIpsExplanation`, `updateCidrCounter` guard, event wiring

**Files:**
- Modify: `public/static/script.js`

**Interfaces:**
- Consumes: `ROUTE_MODES` (Task 2), `cfgState.routeMode` (Task 2), `#routeModeFull`, `#routeModeSplit`, `#routeModeDescription`, `#presetsIgnoredNotice`, `#allowedIpsExplanation`, `#panel-routes` (Task 3), CSS classes (Task 4)
- Produces: `updateRouteModeUI(mode)`, `updateAllowedIpsExplanation()`, updated `updateCidrCounter`, event listeners, initialization call

- [ ] **Step 1: Add `updateAllowedIpsExplanation` function**

Find `const updateCidrCounter = ` (around line 759) and insert BEFORE it:

```js
/** Renders contextual AllowedIPs explanation based on current cfgState. */
const updateAllowedIpsExplanation = () => {
  const el = document.getElementById('allowedIpsExplanation');
  if (!el) return;

  const lines = [];

  if (cfgState.routeMode === ROUTE_MODES.FULL) {
    lines.push(t('routing_allowedips_full',
      'В AllowedIPs будет добавлен полный маршрут. Это направит весь поддерживаемый трафик через туннель.'));
  } else {
    lines.push(t('routing_allowedips_split',
      'В AllowedIPs попадут только сети выбранных направлений. Если нужный сайт не входит в выбранные presets, он может идти мимо туннеля.'));
    lines.push(t('routing_allowedips_limit',
      'Большие списки AllowedIPs могут нестабильно импортироваться или работать на телефонах и роутерах. Поэтому генератор предупреждает на 80% лимита и блокирует выбор при 1000 IPv4 CIDR, если не включён режим «Без лимита».'));
  }

  if (cfgState.ignoreLimit) {
    lines.push(t('routing_allowedips_nolimit',
      'Режим «Без лимита» снимает защитное ограничение, но не гарантирует, что клиент или роутер корректно обработает большой список маршрутов.'));
  }

  if (cfgState.mobileMode) {
    lines.push(t('routing_allowedips_mobile_ipv6',
      'Mobile-профиль принудительно отключает IPv6, чтобы снизить риск проблем на мобильных сетях и клиентах.'));
  }

  el.innerHTML = lines
    .map((line) => `<p class="allowed-ips-explanation__line">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('');
};
```

- [ ] **Step 2: Add `updateRouteModeUI` function**

Insert after `updateAllowedIpsExplanation` (still before `updateCidrCounter`):

```js
/** Sets cfgState.routeMode and updates all UI state for the routes tab. */
const updateRouteModeUI = (mode) => {
  cfgState.routeMode = mode;

  document.getElementById('routeModeFull')
    ?.classList.toggle('route-mode-btn--active', mode === ROUTE_MODES.FULL);
  document.getElementById('routeModeSplit')
    ?.classList.toggle('route-mode-btn--active', mode === ROUTE_MODES.SPLIT);

  const desc = document.getElementById('routeModeDescription');
  if (desc) {
    desc.textContent = mode === ROUTE_MODES.FULL
      ? t('routing_mode_full_desc',
          'Весь поддерживаемый трафик будет направлен через WARP. Это рекомендуемый вариант, если не нужно выбирать отдельные сервисы.')
      : t('routing_mode_split_desc',
          'Через WARP пойдут только выбранные направления. Если нужный сайт не входит в выбранные presets, он может идти мимо туннеля.');
  }

  // Dim preset tiles in full tunnel mode (pointer-events: none via CSS class)
  document.getElementById('panel-routes')
    ?.classList.toggle('routes-panel--full-tunnel', mode === ROUTE_MODES.FULL);

  // Show "presets ignored" notice only when full + at least one preset is checked
  const ignoredNotice = document.getElementById('presetsIgnoredNotice');
  if (ignoredNotice) {
    ignoredNotice.hidden = !(mode === ROUTE_MODES.FULL && getSelectedRouteIds().length > 0);
  }

  // Update CIDR counter (full tunnel: "not applicable"; split: actual count)
  updateCidrCounter(mode === ROUTE_MODES.FULL ? 0 : cfgState.cidrCount4);

  updateAllowedIpsExplanation();
};
```

- [ ] **Step 3: Add full-tunnel guard to `updateCidrCounter`**

Find `const updateCidrCounter = (count4) => {` (around line 759) and add as the **first lines** of the function body:

```js
// In full tunnel mode the CIDR counter is not applicable
if (cfgState.routeMode === ROUTE_MODES.FULL) {
  if (el) el.textContent = t('routing_counter_not_applicable', 'IPv4 маршруты: не применяется');
  if (mini) mini.textContent = '';
  return;
}
```

Note: `el` and `mini` are already declared on the existing first lines of this function — move this guard to after their `const` declarations:

```js
const updateCidrCounter = (count4) => {
  const el = document.getElementById('cidrCounter');
  const mini = document.getElementById('cidrCounterMini');

  // Full tunnel: CIDR counter not applicable
  if (cfgState.routeMode === ROUTE_MODES.FULL) {
    if (el) el.textContent = t('routing_counter_not_applicable', 'IPv4 маршруты: не применяется');
    if (mini) mini.textContent = '';
    return;
  }

  // ... rest of existing function unchanged ...
```

- [ ] **Step 4: Wire event listeners in `initSettingsPanel`**

Find `initSettingsPanel` function. Locate where other toggle listeners are wired (e.g., `ipv6Toggle`, `ignoreLimitToggle`). Add:

```js
// Route mode toggle (2.6.0)
document.getElementById('routeModeFull')
  ?.addEventListener('click', () => updateRouteModeUI(ROUTE_MODES.FULL));
document.getElementById('routeModeSplit')
  ?.addEventListener('click', () => updateRouteModeUI(ROUTE_MODES.SPLIT));
```

- [ ] **Step 5: Add `updateAllowedIpsExplanation()` call to `ignoreLimitToggle` and `mobileModeToggle` handlers**

Find the `ignoreLimitToggle` change handler. After `updateCidrCounter(cfgState.cidrCount4);`, add:

```js
updateAllowedIpsExplanation();
```

Find the `mobileModeToggle` change handler. After the existing mobile cascade logic, add:

```js
updateAllowedIpsExplanation();
```

- [ ] **Step 6: Initialize route mode UI at end of `initSettingsPanel`**

Find the end of `initSettingsPanel` (look for where DNS tiles and other init calls are made). Add:

```js
// Initialize route mode UI (2.6.0)
updateRouteModeUI(cfgState.routeMode);
updateAllowedIpsExplanation();
```

- [ ] **Step 7: Update `presetsIgnoredNotice` visibility when preset tiles are toggled**

In `renderRouteTiles`, find where tile checkbox change handlers call `refreshPresetStats()`. After `refreshPresetStats()` in the tile click/change handler, add:

```js
// Keep "presets ignored" notice in sync when user toggles tiles
const ignoredNotice = document.getElementById('presetsIgnoredNotice');
if (ignoredNotice) {
  ignoredNotice.hidden = !(cfgState.routeMode === ROUTE_MODES.FULL && getSelectedRouteIds().length > 0);
}
```

- [ ] **Step 8: Run lint**

```
npm run lint
```

Expected: 0 warnings, 0 errors.

- [ ] **Step 9: Manual smoke test**

Run `npm start` and open http://localhost:3000.

1. Open Settings → Маршруты tab. Verify: "Полный туннель" button is active, description text shows, tiles are dimmed, CIDR counter shows "не применяется".
2. Click "Выборочная". Verify: tiles become interactive, description changes, CIDR counter shows "0 / 1000".
3. Select a preset. Verify: CIDR counter updates after debounce.
4. Switch back to "Полный туннель". Verify: preset tiles dim again, notice "Presets не будут ограничивать маршруты" appears.
5. Close modal and click Generate (full tunnel, no presets). Verify: generation proceeds normally.
6. Open modal, switch to Выборочная, no presets selected, close modal, click Generate. Verify: error message shown, no request sent.

- [ ] **Step 10: Commit**

```
git add public/static/script.js
git commit -m "feat(ui): добавить updateRouteModeUI, updateAllowedIpsExplanation, full-tunnel guard в updateCidrCounter"
```

---

## Task 6: Localization — 14 keys in ru.json and en.json

**Files:**
- Modify: `public/locales/ru.json`
- Modify: `public/locales/en.json`

**Interfaces:**
- Produces: 14 new i18n keys available via `t('key', 'fallback')`

- [ ] **Step 1: Add keys to `public/locales/ru.json`**

Add before the closing `}` of the JSON object:

```json
  "routing_mode_title": "Маршрутизация",
  "routing_mode_full": "Полный туннель",
  "routing_mode_split": "Выборочная",
  "routing_mode_full_desc": "Весь поддерживаемый трафик будет направлен через WARP. Это рекомендуемый вариант, если не нужно выбирать отдельные сервисы.",
  "routing_mode_split_desc": "Через WARP пойдут только выбранные направления. Если нужный сайт не входит в выбранные presets, он может идти мимо туннеля.",
  "routing_empty_split_error": "Для выборочной маршрутизации выберите хотя бы одно направление или переключитесь на полный туннель.",
  "routing_presets_ignored_in_full": "Вы выбрали полный туннель. Presets не будут ограничивать маршруты в этом режиме.",
  "routing_allowedips_full": "В AllowedIPs будет добавлен полный маршрут. Это направит весь поддерживаемый трафик через туннель.",
  "routing_allowedips_split": "В AllowedIPs попадут только сети выбранных направлений. Если нужный сайт не входит в выбранные presets, он может идти мимо туннеля.",
  "routing_allowedips_limit": "Большие списки AllowedIPs могут нестабильно импортироваться или работать на телефонах и роутерах. Поэтому генератор предупреждает на 80% лимита и блокирует выбор при 1000 IPv4 CIDR, если не включён режим «Без лимита».",
  "routing_allowedips_nolimit": "Режим «Без лимита» снимает защитное ограничение, но не гарантирует, что клиент или роутер корректно обработает большой список маршрутов.",
  "routing_allowedips_mobile_ipv6": "Mobile-профиль принудительно отключает IPv6, чтобы снизить риск проблем на мобильных сетях и клиентах.",
  "routing_counter_not_applicable": "IPv4 маршруты: не применяется"
```

- [ ] **Step 2: Add keys to `public/locales/en.json`**

Add before the closing `}`:

```json
  "routing_mode_title": "Routing",
  "routing_mode_full": "Full tunnel",
  "routing_mode_split": "Split tunnel",
  "routing_mode_full_desc": "All supported traffic will be routed through WARP. Use this if you do not need to choose specific services.",
  "routing_mode_split_desc": "Only selected destinations will be routed through WARP. If a website is not covered by selected presets, it may bypass the tunnel.",
  "routing_empty_split_error": "Choose at least one destination for split tunnel or switch back to full tunnel.",
  "routing_presets_ignored_in_full": "Full tunnel is selected. Presets will not limit routes in this mode.",
  "routing_allowedips_full": "AllowedIPs will use the default full route. All supported traffic will go through the tunnel.",
  "routing_allowedips_split": "AllowedIPs will include only networks from selected destinations. If a website is not covered by selected presets, it may bypass the tunnel.",
  "routing_allowedips_limit": "Large AllowedIPs lists may import or work unstably on phones and routers. The generator warns at 80% of the limit and blocks selection at 1000 IPv4 CIDR unless \"No limit\" is enabled.",
  "routing_allowedips_nolimit": "\"No limit\" removes the safety cap, but it does not guarantee that the client or router will handle a large route list correctly.",
  "routing_allowedips_mobile_ipv6": "Mobile profile forces IPv6 off to reduce issues on mobile networks and clients.",
  "routing_counter_not_applicable": "IPv4 routes: not applicable"
```

- [ ] **Step 3: Verify JSON is valid**

```
node -e "require('./public/locales/ru.json'); require('./public/locales/en.json'); console.log('JSON valid')"
```

Expected: `JSON valid`

- [ ] **Step 4: Run lint + test**

```
npm run lint && npm test
```

Expected: 0 warnings, all tests PASS.

- [ ] **Step 5: Manual check — switch UI language to EN, verify keys render**

In the app, switch language to EN (if there's a language switcher) and verify "Routing", "Full tunnel", "Split tunnel" appear correctly with no `undefined` or missing keys.

- [ ] **Step 6: Commit**

```
git add public/locales/ru.json public/locales/en.json
git commit -m "feat(i18n): добавить 14 ключей локализации для routing mode (RU + EN)"
```

---

## Task 7: result-explanation.js — use `state.routeMode` directly

**Files:**
- Modify: `public/static/result-explanation.js`

**Interfaces:**
- Consumes: `state.routeMode` from `getResultStateSnapshot()` (Task 2)
- Produces: `buildResultSummary` returns `routeMode` from explicit state when available, falls back to presets-length inference

- [ ] **Step 1: Update `buildResultSummary` in `result-explanation.js`**

Find the line (around line 152):
```js
const routeMode = presets.length ? 'split' : 'full';
```

Replace with:
```js
// Use explicit routeMode from state (2.6.0) when available; fall back to inference for old snapshots
const routeMode = state.routeMode || (presets.length ? 'split' : 'full');
```

- [ ] **Step 2: Run the result-explanation tests**

```
npm test -- --test-name-pattern="result-explanation"
```

Expected: All existing tests PASS (the fallback maintains old behavior).

- [ ] **Step 3: Run full test suite**

```
npm test
```

Expected: All tests PASS.

- [ ] **Step 4: Run lint**

```
npm run lint
```

Expected: 0 warnings, 0 errors.

- [ ] **Step 5: Commit**

```
git add public/static/result-explanation.js
git commit -m "feat(result): buildResultSummary использует явный routeMode из state при наличии"
```

---

## Task 8: Documentation — CHANGELOG, README, manual checks

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README.ru.md`
- Create: `docs/manual-checks/routing-mode.md`

- [ ] **Step 1: Add 2.6.0 section to `CHANGELOG.md`**

Find the top of `CHANGELOG.md` (after the header, before the first existing version entry). Insert:

```markdown
## 2.6.0 — Routing Clarity

### Новое

- Добавлен явный выбор режима маршрутизации: полный туннель или выборочная маршрутизация. Переключатель находится в настройках на вкладке «Маршруты».
- Выборочная маршрутизация теперь требует хотя бы одно выбранное направление. Генератор больше не подменяет пустой split tunnel на полный туннель — ни на фронте, ни на сервере.
- Добавлены пояснения к AllowedIPs: что попадёт в маршруты, зачем нужен лимит 1000 CIDR, почему большие списки могут быть нестабильны на телефонах и роутерах. Пояснение обновляется при изменении режима, mobile-профиля и опции «Без лимита».

### Технические детали

- API `/api/warp` принимает новый опциональный параметр `routeMode` (`full` | `split`).
- Запросы без `routeMode` работают как раньше (backward-compatible).
- `routeMode=split` без пресетов возвращает 400 `empty_split_tunnel` до регистрации WARP-устройства.
- `routeMode=full` игнорирует пресеты даже если они переданы.
- Результат генерации включает `routeMode` в ответе API.

```

- [ ] **Step 2: Update `README.md` Features section**

Find the Features list in `README.md`. Add:

```markdown
- Explicit routing mode selection: full tunnel (all traffic) or split tunnel (selected presets only)
```

- [ ] **Step 3: Update `README.ru.md` Features section**

Find the Features list in `README.ru.md`. Add:

```markdown
- Явный выбор режима маршрутизации: полный туннель (весь трафик) или выборочная маршрутизация (только выбранные направления)
```

- [ ] **Step 4: Create `docs/manual-checks/routing-mode.md`**

```markdown
# Manual Check: Routing Mode (2.6.0)

## Setup
`npm start` → open http://localhost:3000 → Settings modal

## Checks

- [ ] 1. Open Settings → Маршруты. "Полный туннель" is active by default.
- [ ] 2. Description text is visible under the toggle. Tiles are dimmed. CIDR counter shows "не применяется".
- [ ] 3. Close modal. Click Generate. Config downloads — full tunnel (no presets required).
- [ ] 4. Open modal → switch to "Выборочная". Tiles become interactive. CIDR counter shows 0.
- [ ] 5. No presets selected → close modal → click Generate. Error message shown, no download, no network request sent.
- [ ] 6. Select one preset (e.g. Telegram). CIDR counter updates after ~500ms.
- [ ] 7. Close modal → Generate. Config downloads with split tunnel routing.
- [ ] 8. Open modal → select some presets → switch to "Полный туннель". Notice "Presets не будут ограничивать маршруты" appears. Tiles dim.
- [ ] 9. Switch back to "Выборочная". Previously selected presets are still checked.
- [ ] 10. Enable Mobile profile. AllowedIPs explanation shows IPv6 note.
- [ ] 11. Enable "Без лимита". AllowedIPs explanation shows no-limit warning.
- [ ] 12. Switch UI language to EN. Verify "Full tunnel", "Split tunnel", "Routing" render correctly. No `undefined` or missing key strings.
- [ ] 13. Generate config and open result summary card (ℹ️). "Режим маршрутов" shows "Весь трафик" (full) or "Выборочно" (split).
- [ ] 14. No `undefined`, `null`, `[object Object]` anywhere in UI.
```

- [ ] **Step 5: Run full test suite one last time**

```
npm test
```

Expected: All tests PASS.

- [ ] **Step 6: Run lint**

```
npm run lint
```

Expected: 0 warnings, 0 errors.

- [ ] **Step 7: Commit**

```
git add CHANGELOG.md README.md README.ru.md docs/manual-checks/routing-mode.md
git commit -m "docs: обновить CHANGELOG, README и добавить manual-checks для routing mode 2.6.0"
```

---

## Self-Review Checklist

**Spec coverage:**

| Requirement | Task |
|---|---|
| Full tunnel / Split tunnel toggle | Task 3, 4, 5 |
| Default = full tunnel | Task 2 (`cfgState.routeMode: ROUTE_MODES.FULL`) |
| Empty split tunnel guard — frontend | Task 2 (generate guard) |
| Empty split tunnel guard — backend | Task 1 |
| `routeMode=invalid` → 400 | Task 1 |
| AllowedIPs explanation block | Task 5 (`updateAllowedIpsExplanation`) |
| Explanation updates on mode change | Task 5 |
| Explanation updates on mobileMode change | Task 5 (Step 5) |
| Explanation updates on ignoreLimit change | Task 5 (Step 5) |
| CIDR counter "не применяется" in full mode | Task 5 (Step 3) |
| Preset tiles dimmed in full mode | Task 4 (CSS), Task 5 (Step 2) |
| "Presets ignored" notice | Task 3 (HTML), Task 5 (Steps 2, 7) |
| Checkboxes NOT disabled (state preserved) | Task 4 (CSS comment), Task 5 |
| Presets NOT sent to API in full mode | Task 2 (`buildWarpQueryString`) |
| `routeMode` in API response | Task 1 (Step 4) |
| Backward compat (no `routeMode` param) | Task 1 (validation only when param present) |
| `getResultStateSnapshot` includes `routeMode` | Task 2 (Step 5) |
| `buildResultSummary` uses explicit `routeMode` | Task 7 |
| 14 i18n keys, RU + EN | Task 6 |
| Tests: 7 backend cases | Task 1 |
| CHANGELOG, README, manual-checks | Task 8 |

**Placeholder scan:** No TBD, TODO, or "similar to Task N" references. All code blocks contain actual code.

**Type consistency:** `ROUTE_MODES.FULL` and `ROUTE_MODES.SPLIT` used throughout; no bare `'full'`/`'split'` strings in logic code. `effectivePresetKeys` consistently replaces `presetKeys` in the `generateMultipleWarpConfigs` call.
