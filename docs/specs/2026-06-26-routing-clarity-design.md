# Design: Release 2.6.0 — Routing Clarity

**Date:** 2026-06-26  
**Type:** minor  
**Approach:** Inline segmented control + AllowedIPs explanation block (Approach 2)

---

## Overview

Make routing mode explicit. Currently the absence of selected route presets implicitly means full tunnel — users have no visible signal of this. This release adds an explicit Full tunnel / Split tunnel toggle in the Routes tab of the settings modal, with a dynamic explanation block below it.

**Three user-facing features:**
1. Full tunnel / Split tunnel toggle
2. Empty split tunnel guard (frontend + backend)
3. AllowedIPs explanation block

---

## Key Findings from Codebase Exploration

- `cfgState` in `script.js` has no `routeMode` field today — routing is fully implicit
- `resolveAllowedIpsFromPresets` returns `{ cidrs: null, routesSource: 'default' }` when `presetKeys.length === 0` — this IS the current full tunnel path
- `result-explanation.js` already computes `routeMode` as `presets.length ? 'split' : 'full'` and shows it in the result summary card
- `analytics.js` already has `route_mode: new Set(['full', 'split', 'unknown'])` in its allowed schema
- `public/locales/ru.json` and `en.json` use `t()` with snake_case keys
- Route presets live in **Tab 1 "Маршруты"** of the settings modal (`#panel-routes`)
- CPS section uses radio-tiles pattern — we use segmented control instead (more compact)
- Telemetry adapter exists: `window.ProductTelemetry || { trackEvent: () => false }`

---

## Section 1: State & Data Model

### New field in `cfgState` (`public/static/script.js`)

```js
/** Current routing mode. 'full' = all traffic; 'split' = only selected presets. */
routeMode: 'full',
```

Default `'full'` preserves the existing quick-path: open → Generate → full tunnel config.

### Constant (near `MAX_CIDR_LIMIT`)

```js
const ROUTE_MODES = Object.freeze({ FULL: 'full', SPLIT: 'split' });
```

No string literals elsewhere — always reference `ROUTE_MODES.FULL` / `ROUTE_MODES.SPLIT`.

### `buildWarpQueryString` changes

```js
// Always send routeMode
params.set('routeMode', cfgState.routeMode);

// Presets only sent in split mode
if (cfgState.routeMode === ROUTE_MODES.SPLIT) {
  const routeIds = getSelectedRouteIds();
  if (routeIds.length) params.set('presets', routeIds.join(','));
}
// Remove the old unconditional: if (routeIds.length) params.set('presets', ...)
```

This is the critical guard: in full tunnel mode, presets are never sent even if checkboxes are checked.

### Frontend guard before generation

Added in the generate handler, before `fetch`:

```js
if (cfgState.routeMode === ROUTE_MODES.SPLIT && getSelectedRouteIds().length === 0) {
  status.textContent = t('routing_empty_split_error', '...');
  setAllGenerateButtonsDisabled(false);
  button.classList.remove('button--loading');
  return;
}
```

### `getResultStateSnapshot` extension

```js
routeMode: cfgState.routeMode,
```

So `buildResultSummary` receives explicit routeMode from state, not inferred from presets length.

---

## Section 2: UI — HTML + JS

### HTML insertion point

In `public/index.html`, in `#panel-routes`, **before** `.cfg-tiles-actions`:

```html
<!-- Route Mode Toggle -->
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
</div>

<!-- AllowedIPs Explanation -->
<div id="allowedIpsExplanation" class="allowed-ips-explanation" aria-live="polite"></div>
```

### Visual dimming of presets in full tunnel mode

```js
document.getElementById('panel-routes')
  .classList.toggle('routes-panel--full-tunnel', mode === ROUTE_MODES.FULL);
```

CSS in `styles.css`:

```css
.route-mode-block {
  margin-bottom: 12px;
}

.route-mode-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.route-mode-toggle__label {
  font-size: 0.85rem;
  color: var(--color-text-secondary, #888);
  white-space: nowrap;
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
  margin: 0 0 8px;
  min-height: 1.2em;
}

.allowed-ips-explanation {
  margin-bottom: 10px;
}

.allowed-ips-explanation__line {
  font-size: 0.78rem;
  color: var(--color-text-secondary, #888);
  margin: 2px 0;
}

/* Dim presets when full tunnel is active */
.routes-panel--full-tunnel .cfg-tiles--routes,
.routes-panel--full-tunnel .cfg-tiles-actions,
.routes-panel--full-tunnel .cidr-counter-mini,
.routes-panel--full-tunnel #presetStats {
  opacity: 0.4;
  pointer-events: none;
}
```

**Note:** checkboxes are NOT set to `disabled` — their state is preserved when switching back to split mode.

### "Presets ignored" notice

When `routeMode === FULL` AND at least one preset is checked, show an extra notice above the dimmed tiles:

```js
// In updateRouteModeUI(), after toggling the panel class:
const ignoredNotice = document.getElementById('presetsIgnoredNotice');
if (ignoredNotice) {
  ignoredNotice.hidden = !(mode === ROUTE_MODES.FULL && getSelectedRouteIds().length > 0);
}
```

HTML (inside `.route-mode-block`, after `#routeModeDescription`):
```html
<p id="presetsIgnoredNotice" class="route-mode-notice route-mode-notice--info" hidden
   data-i18n="routing_presets_ignored_in_full">
  Вы выбрали полный туннель. Presets не будут ограничивать маршруты в этом режиме.
</p>
```

Also update this notice whenever a preset tile is toggled (call `updateRouteModeUI` state check or a lightweight inline check in `renderRouteTiles` tile click handler).

### `updateRouteModeUI(mode)` — new function in `script.js`

```js
const updateRouteModeUI = (mode) => {
  cfgState.routeMode = mode;

  document.getElementById('routeModeFull')
    ?.classList.toggle('route-mode-btn--active', mode === ROUTE_MODES.FULL);
  document.getElementById('routeModeSplit')
    ?.classList.toggle('route-mode-btn--active', mode === ROUTE_MODES.SPLIT);

  const desc = document.getElementById('routeModeDescription');
  if (desc) {
    desc.textContent = mode === ROUTE_MODES.FULL
      ? t('routing_mode_full_desc', 'Весь поддерживаемый трафик будет направлен через WARP...')
      : t('routing_mode_split_desc', 'Через WARP пойдут только выбранные направления...');
  }

  document.getElementById('panel-routes')
    ?.classList.toggle('routes-panel--full-tunnel', mode === ROUTE_MODES.FULL);

  updateCidrCounter(mode === ROUTE_MODES.FULL ? 0 : cfgState.cidrCount4);
  updateAllowedIpsExplanation();
};
```

Event listeners (in `initSettingsPanel`):
```js
document.getElementById('routeModeFull')
  ?.addEventListener('click', () => updateRouteModeUI(ROUTE_MODES.FULL));
document.getElementById('routeModeSplit')
  ?.addEventListener('click', () => updateRouteModeUI(ROUTE_MODES.SPLIT));
```

Initialization at end of `initSettingsPanel`:
```js
updateRouteModeUI(cfgState.routeMode); // sets initial UI state
updateAllowedIpsExplanation();
```

---

## Section 3: AllowedIPs Explanation Block

### `updateAllowedIpsExplanation()` — new function

```js
const updateAllowedIpsExplanation = () => {
  const el = document.getElementById('allowedIpsExplanation');
  if (!el) return;

  const lines = [];

  if (cfgState.routeMode === ROUTE_MODES.FULL) {
    lines.push(t('routing_allowedips_full', 'В AllowedIPs будет добавлен полный маршрут...'));
  } else {
    lines.push(t('routing_allowedips_split', 'В AllowedIPs попадут только сети выбранных направлений...'));
    lines.push(t('routing_allowedips_limit', 'Большие списки AllowedIPs могут нестабильно работать...'));
  }

  if (cfgState.ignoreLimit) {
    lines.push(t('routing_allowedips_nolimit', '«Без лимита» снимает защитное ограничение...'));
  }

  if (cfgState.mobileMode) {
    lines.push(t('routing_allowedips_mobile_ipv6', 'Mobile-профиль принудительно отключает IPv6...'));
  }

  el.innerHTML = lines
    .map(line => `<p class="allowed-ips-explanation__line">${escapeHtml(line)}</p>`)
    .join('');
};
```

**Note:** use `escapeHtml()` (already exists in `script.js`) to avoid XSS from translated strings.

### Call sites — add `updateAllowedIpsExplanation()` after:
- `updateRouteModeUI()` — already included above
- `ignoreLimitToggle` change handler
- `mobileModeToggle` change handler
- end of `initSettingsPanel()`

### `updateCidrCounter` — full tunnel guard

```js
const updateCidrCounter = (count4) => {
  const el = document.getElementById('cidrCounter');
  const mini = document.getElementById('cidrCounterMini');

  // Full tunnel: counter not applicable
  if (cfgState.routeMode === ROUTE_MODES.FULL) {
    if (el) el.textContent = t('routing_counter_not_applicable', 'IPv4 маршруты: не применяется');
    if (mini) mini.textContent = '';
    return;
  }

  // ... rest of existing logic unchanged ...
};
```

---

## Section 4: Backend (`api/warp.js`)

### Parse `routeMode` (after existing param parsing, before `generateMultipleWarpConfigs`)

```js
const routeModeRaw = String(
  body.routeMode ?? pickQuery(req, 'routeMode') ?? ''
).trim().toLowerCase();

const VALID_ROUTE_MODES = ['full', 'split'];

// Validate if explicitly provided
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

// Empty split tunnel guard — BEFORE WARP registration
if (routeModeRaw === 'split' && presetKeys.length === 0) {
  res.status(400).json({
    success: false,
    error: 'empty_split_tunnel',
    message: 'Split tunnel requires at least one selected route preset.',
  });
  return;
}

// Full tunnel override: ignore presets even if sent
const effectivePresetKeys = (hasExplicitRouteMode && routeModeRaw === 'full')
  ? []
  : presetKeys;
```

Replace `presetKeys` with `effectivePresetKeys` in the call to `generateMultipleWarpConfigs`. Original `presetKeys` used only for telemetry logging.

### Response — add `routeMode` field

```js
res.status(200).json({
  // ... existing fields ...
  routeMode: hasExplicitRouteMode
    ? routeModeRaw
    : (presetKeys.length ? 'split' : 'full'),
});
```

### Backward compatibility

If `routeMode` not provided (`routeModeRaw === ''`):
- empty presets → `resolveAllowedIpsFromPresets([])` → `cidrs: null` → full tunnel (unchanged)
- with presets → split routing (unchanged)

No existing behavior is changed for requests without `routeMode`.

---

## Section 5: Localization

New keys in `public/locales/ru.json` and `en.json`:

| Key | RU | EN |
|---|---|---|
| `routing_mode_title` | Маршрутизация | Routing |
| `routing_mode_full` | Полный туннель | Full tunnel |
| `routing_mode_split` | Выборочная | Split tunnel |
| `routing_mode_full_desc` | Весь поддерживаемый трафик будет направлен через WARP. Это рекомендуемый вариант, если не нужно выбирать отдельные сервисы. | All supported traffic will be routed through WARP. Use this if you do not need to choose specific services. |
| `routing_mode_split_desc` | Через WARP пойдут только выбранные направления. Если нужный сайт не входит в выбранные presets, он может идти мимо туннеля. | Only selected destinations will be routed through WARP. If a website is not covered by selected presets, it may bypass the tunnel. |
| `routing_empty_split_error` | Для выборочной маршрутизации выберите хотя бы одно направление или переключитесь на полный туннель. | Choose at least one destination for split tunnel or switch back to full tunnel. |
| `routing_presets_ignored_in_full` | Вы выбрали полный туннель. Presets не будут ограничивать маршруты в этом режиме. | Full tunnel is selected. Presets will not limit routes in this mode. |
| `routing_allowedips_full` | В AllowedIPs будет добавлен полный маршрут. Это направит весь поддерживаемый трафик через туннель. | AllowedIPs will use the default full route. All supported traffic will go through the tunnel. |
| `routing_allowedips_split` | В AllowedIPs попадут только сети выбранных направлений. Если нужный сайт не входит в выбранные presets, он может идти мимо туннеля. | AllowedIPs will include only networks from selected destinations. If a website is not covered by selected presets, it may bypass the tunnel. |
| `routing_allowedips_limit` | Большие списки AllowedIPs могут нестабильно импортироваться или работать на телефонах и роутерах. Поэтому генератор предупреждает на 80% лимита и блокирует выбор при 1000 IPv4 CIDR, если не включён режим «Без лимита». | Large AllowedIPs lists may import or work unstably on phones and routers. The generator warns at 80% of the limit and blocks selection at 1000 IPv4 CIDR unless "No limit" is enabled. |
| `routing_allowedips_nolimit` | Режим «Без лимита» снимает защитное ограничение, но не гарантирует, что клиент или роутер корректно обработает большой список маршрутов. | "No limit" removes the safety cap, but it does not guarantee that the client or router will handle a large route list correctly. |
| `routing_allowedips_mobile_ipv6` | Mobile-профиль принудительно отключает IPv6, чтобы снизить риск проблем на мобильных сетях и клиентах. | Mobile profile forces IPv6 off to reduce issues on mobile networks and clients. |
| `routing_counter_not_applicable` | IPv4 маршруты: не применяется | IPv4 routes: not applicable |

---

## Section 6: Tests

### New file: `__tests__/routing-mode.test.js`

Backend unit tests (using existing test infrastructure):

1. `routeMode=full` + empty presets → 200 OK
2. `routeMode=full` + presets sent → `effectivePresetKeys` is empty (presets ignored)
3. `routeMode=split` + empty presets → 400 `empty_split_tunnel`
4. `routeMode=split` + presets → presets passed through to generation
5. `routeMode=invalid` → 400 `invalid_route_mode`
6. No `routeMode` + empty presets → old behavior (full tunnel, no error)
7. No `routeMode` + presets → old split behavior

**Existing tests to verify (no changes needed, regression check):**
- `warp-contract.test.js` — base contract still holds
- `invariant-i7-mobile-mode.test.js` — mobile profile still forces IPv4
- `invariant-i8-mobile-router-compose.test.js` — composition order unchanged

---

## Section 7: Documentation

- **`CHANGELOG.md`** — add `## 2.6.0 — Routing Clarity` section
- **`README.md`** — add one line to Features: explicit routing mode selection
- **`README.ru.md`** — same in Russian
- **`docs/manual-checks/routing-mode.md`** — manual check checklist (13 checks per spec)

---

## Files Changed Summary

| File | Change |
|---|---|
| `public/index.html` | +~15 lines: route-mode-block + allowedIpsExplanation divs in #panel-routes |
| `public/static/script.js` | +`ROUTE_MODES`, `routeMode` in cfgState, `updateRouteModeUI()`, `updateAllowedIpsExplanation()`, guard in generate handler, changes to `buildWarpQueryString`, `updateCidrCounter`, `getResultStateSnapshot`, call sites |
| `public/static/styles.css` | +~50 lines: `.route-mode-block`, `.route-mode-toggle`, `.route-mode-btn`, `.route-mode-btn--active`, `.route-mode-description`, `.allowed-ips-explanation`, `.routes-panel--full-tunnel` dimming |
| `public/locales/ru.json` | +14 keys |
| `public/locales/en.json` | +14 keys |
| `api/warp.js` | +routeMode parsing, validation, `effectivePresetKeys`, `routeMode` in response |
| `__tests__/routing-mode.test.js` | New file, 7 test cases |
| `CHANGELOG.md` | +2.6.0 section |
| `README.md` | +1 line |
| `README.ru.md` | +1 line |
| `docs/manual-checks/routing-mode.md` | New file |

---

## Routing Model

| Request | Behavior |
|---|---|
| No `routeMode`, no presets | Legacy: full tunnel (cidrs: null → 0.0.0.0/0) |
| No `routeMode`, presets sent | Legacy: split routing |
| `routeMode=full`, any presets | Force full tunnel; `effectivePresetKeys = []` |
| `routeMode=split`, presets | Split routing with selected presets |
| `routeMode=split`, no presets | 400 `empty_split_tunnel` |
| `routeMode=<other>` | 400 `invalid_route_mode` |

---

## Out of Scope / Follow-up

- Custom CIDR input
- Telemetry events for `route_mode_selected`, `split_tunnel_blocked_empty` — follow-up patch since telemetry adapter exists but safe events not wired for this release
- `result-explanation.js` can use `data.routeMode` directly from API response — minor cleanup, not required
- Router profile — no changes needed, not affected by routing mode
