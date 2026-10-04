# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Every response carries `X-App-Revision: <commit sha>` (from the image's `APP_REVISION`), so deployment checks can prove which release answers publicly.
- English version of the site at `/en` with its own title, description, social preview and structured data. Both versions are linked with `hreflang` (`x-default` → `/en`) and listed in `sitemap.xml`. The page is generated from `public/index.html` and `en.json` (`npm run seo:en`); a test fails when it is out of date.
- A 404 page in both languages (served with status 404 and `noindex`), `/.well-known/security.txt` (RFC 9116) and `/llms.txt` for AI search.
- Favicons in PNG (16, 32, 192 px) and an Apple touch icon are declared in `<head>`; social preview gains `og:image:type`, `og:locale:alternate` and `twitter:image:alt`.
- IndexNow: the key file is served from the site root and `npm run indexnow` submits the sitemap URLs to Bing, Yandex, Seznam, Naver and Yep. It can wait until production serves a given commit (`X-App-Revision`) and skip releases that change nothing under `public/`; the release process runs it after a deploy.
- A "Frequently asked questions" dialog on the shared modal shell, opened from the header ("FAQ"), the footer and the `/#faq` deep link (7 questions, Russian and English, native `<details>`): what AmneziaWG and WARP are, which AWG profile to pick, how to import the config, what to do when it does not connect, what happens to the keys, split routing. The text is in the HTML from the start, so search engines index it on both `/` and `/en`.
- `/favicon.ico` in the site root and a 120×120 PNG favicon on every page, as Yandex requires for search results.

### Changed
- The interface language now follows the address (`/` is Russian, `/en` is English) instead of the browser language. The RU/EN buttons open the other address and remember the choice; a remembered choice redirects there on the next visit. Search engine crawlers therefore see the language that matches the URL.
- Icons, the web app manifest icons and the social preview image carry `?v=<version>` cache keys, so browsers and social networks pick up the new images.
- Structured data: `UtilitiesApplication` category, `softwareVersion`, preview image, both languages; `release:check` keeps the version, the sitemap `lastmod`, manifest icon keys and the `security.txt` expiry current.
- `robots.txt`: drop `Crawl-delay` (ignored by Yandex and Google), add Yandex `Clean-param` for ad and analytics tags, document why `/static/`, `/locales/` and `/status.html` stay crawlable.
- Remaining hard-coded Russian strings in the settings (WARP endpoint, UDP port, number of configs), the logo `alt` and several `aria-label`s are now translated.
- nginx site snippet: `gzip_vary on` (compressed responses carry `Vary: Accept-Encoding`, so shared caches never serve gzip to a client that did not ask for it), `gzip_comp_level 5`, and `favicon.ico` is compressed too. Takes effect only when the snippet is reinstalled on the server.
- Interface redesign (dark design system replaces the Win95 look) on the main page, `status.html` and the 404 page:
  - Hero with the new illustration (checklist labels are live, translatable text), a "System status" card fed by the same live poller as the status modal (no separate `/api/healthcheck` polling), and a three-step flow: choose a profile card (AWG 2.0 is the default and is remembered), adjust parameters via chips that always show the real settings, and one "Generate" button instead of four.
  - Result panel with loading / success / warning / error states, a variant switcher for 2–3 configs, `.conf` / `vpn://` preview tabs and "More actions". Previews hide `PrivateKey` (and show only the start of `vpn://`); download and copy still give the full config.
  - All nine modals share one shell with a focus trap, Escape / backdrop close and focus return; the settings dialog keeps three tabs and opens on the tab of the clicked chip; on phones modals are bottom sheets. History rows show route mode, DNS, endpoint and device, and clearing needs a second click. New "Privacy" and "Disclaimer" dialogs.
  - Inter is self-hosted (OFL) with preload instead of Google Fonts; the hero image is WebP (156 KB, 67 KB on phones) with fixed dimensions.
  - The info dialog no longer claims `AllowedIPs = 0.0.0.0/0, ::/0` by default: AllowedIPs are IPv4-only unless IPv6 is enabled (invariant I6).
- Title and description target the main queries ("генератор конфигов AmneziaWG", AmneziaVPN, `vpn://`, WARP) and fit the snippet length in Google and Yandex (title ≤ 70, description ≤ 160 characters).
- The former GitHub Pages landing (`hereiamgosu.github.io/amnezia-config-gen/`) competed with awgconfig.com in search results as a self-canonical duplicate. It is now an instant redirect with a cross-domain `canonical` to https://awgconfig.com/; internal docs are excluded from the Pages build and the mirror is no longer linked from the README or `llms.txt`.
- The Content-Security-Policy no longer allows Google Fonts (Inter is self-hosted); the web app manifest uses the dark theme colour `#07090c`.
- Accessibility: white text on blue (badges, blue buttons, step numbers) uses `#2563eb` for WCAG AA contrast; the header logo is an 80 px WebP (4 KB) instead of the 192 px PNG.
- Neutral technical wording: the CPS5 hint says "strengthens traffic obfuscation" instead of "DPI evasion".

### Fixed
- A dialog opened from another dialog (config preview from History, Status from the FAQ) now opens on top of it, and closing it returns to the previous dialog; it used to open underneath.
- UX clean-up: the redundant "Advanced settings" link is gone (each step-2 chip opens its settings tab); "Status" (in the header and in the FAQ answer) and "Guide" in the header open dialogs instead of leaving the page or only scrolling; "Which profile to choose?" opens a dialog with that title and the profile comparison first; the result panel drops the duplicate "More on compatibility" link and "Generate again" item; for profiles without `vpn://` (AWG 3.0) the copy button stays visible and explains why; error and info toasts no longer show a success tick; desktop card titles are plain titles for mouse and keyboard (no unexpected links, no extra tab stops); one name "System status" for the card and the dialog.
- The inline SVG filter used a wrong XML namespace (`/1000/svg`).

## [2.7.4] - 2026-10-03

### Fixed
- `/api/status` no longer reports `degraded` when it simply has no endpoint health data. States are formalised as `ok` / `degraded` / `down` (measured) and `unknown` (no runtime data); the built-in endpoint list has no measurements, so the pool now reports `unknown`. The response adds `candidates` and `health_source`; existing fields are kept.
- The main page banner appears only for measured problems (`degraded`/`down`) and is localized instead of showing the English API message.
- The service status modal and `status.html` read live `/api/status` + `/api/healthcheck` (timeout, honest "temporarily unavailable" state, visible-tab polling, Retry-After handling) instead of a committed `status.json` / GitHub snapshot branch.
- The result summary no longer labels the endpoint source as "KV": a TCP-checked candidate from the built-in list is shown as such.
- Frontend asset cache keys move to `?v=2.7.4`, so browsers drop the 2.7.3 copies of changed scripts.
- `presets-fallback.json` is served with `must-revalidate` as intended; the general immutable `/static/(.*)` rule used to override it because the last matching header rule wins.

### Changed
- `/api/healthcheck` also probes TCP reachability of `iplist.opencck.org` and sends `Cache-Control: no-store`.
- Metrika telemetry `endpoint_source` reports `tcp_check` (was `kv`) for the same case.

### Removed
- Unused Vercel KV integration (the package was never installed); the endpoint registry keeps its `getTopEndpoints` contract and fallback behaviour.
- Committed `public/status.json`, the `healthcheck.yml` snapshot workflow and the duplicate `test-templates.yml` workflow.

### CI / Build
- CI builds the Docker image once and tests that exact image (`scripts/ci/smoke-image.sh`); workflow permissions default to none; actions are pinned to commit SHAs; Dependabot watches actions and the Docker base image.
- Docker base image pinned by digest (`node:22-alpine@sha256:0a7108bf…`).
- New guard: CI fails when an immutable browser asset under `public/static/` changes without a package version bump.
- `npm run release:check` verifies asset cache keys in `status.html` as well as `index.html`.

### Notes
- No protocol, AWG profile, CPS or endpoint-selection behaviour changes.
- Part of this work (live status UI, KV removal, CI hardening) already ran on the self-hosted production between releases under package version 2.7.3; 2.7.4 is the first release that versions it.

## [2.7.3] - 2026-10-03

### Added
- Machine-readable AWG 3.x capability evidence with pinned primary sources, status validation, and generated current protocol documentation.
- Additive API evidence metadata and a concise RU/EN result explanation based on the effective serialized profile.
- Structured CPS evidence metadata while preserving the existing `stable`/`experimental` API terms and verified-only Auto selection.
- Release consistency guard: `npm run release:check` validates package metadata, lockfile root versions, current release notes, source audit presence, frontend asset cache versions, and release ledger/process documents.
- CI now runs protocol evidence and release consistency checks, and validates `v*` tag names against `package.json`.
- Release ledger and release process documentation under `docs/releases/`.

### Changed
- Package metadata and frontend static asset cache keys now point to `2.7.3`.
- Current README text and the 2.7.3 source audit explain the local CPA/Cookies policy and the conservative RandomTrailers decision.

### Security / Protocol safety
- WARP keeps `S1..S4=0`, `H1..H4=1..4`, blocks `HeaderProtectionKey` and `RandomTrailers=on`; consistency tests compare these runtime rules with the evidence registry.

### Notes
- This patch does not add new protocol knobs, endpoint behaviour, or recovery flows. It documents and guards the protocol evidence/release consistency work for 2.7.3.

## [2.7.2] - 2026-09-19

### Fixed
- Auto CPS теперь выбирает только подтверждённые режимы Static, SIP и STUN; неизвестные значения и TLS больше не подменяются молча.
- QUIC CPS формирует защищённый QUIC v1 Initial размером 1200 байт без усечения, а DNS CPS использует согласованную response-shaped структуру.
- API и UI показывают запрошенный, фактически выбранный и стабильностный статус CPS без передачи содержимого `I1` в телеметрию.

### Added
- Реестр CPS-протоколов, RFC 9001/структурные тесты, source audit и матрица ручной проверки совместимости.

## [2.7.1] - 2026-09-16

### Fixed
- AWG 3.0/3.1 WARP policy was corrected after the source audit: `ContentPaddingAddition = 10-100` is enabled by default for AWG 3.x, AWG 3.1 uses `DisableCookies = on` by default, and both remain explicitly disableable.
- `RandomTrailers` and `HeaderProtectionKey` remain unavailable for WARP because they depend on peer-side support.
- AWG 3.x public range parsing is kept on the `.conf` parser contract of `0..65535`.

### Notes
- Historical changelog backfill based on `docs/releases/2.7.1.md`, `docs/releases/2.7.1-source-audit.md`, and commit `a24a67c` dated 2026-09-16.

## [2.7.0] - 2026-07-05

### Added
- Пояснение к режиму AWG 2.0 рядом с кнопкой генерации: AWG 2.0 относится к параметрам клиентской конфигурации, а Cloudflare WARP peer остаётся стандартным WireGuard peer (часть параметров для WARP фиксирована намеренно).
- Серверная матрица совместимости клиентов (`src/server/clientCompatibility.js`) с функцией `getCompatibilityForGeneration({ mode, exportType, mobile, router, link })`: разбивает клиентов на `recommended` / `experimental` / `notRecommended` и формирует secret-free warnings.
- Реестр export targets v0 (`src/server/exportTargets.js`) со статусами `stable` / `experimental` / `research` / `documentation` и helpers `getExportTarget`, `listExportTargets`, `getAvailableExportTargets`, `isStableExportTarget`.
- Опциональное additive-поле `compatibility` в ответе `/api/warp` (не меняет существующие поля, `.conf` и `vpn://`).
- Пост-генерационная карточка совместимости в UI: подходящие клиенты, экспериментальные варианты, форматы без прямой поддержки и предупреждения. Скрывается без ошибок, если API не вернул `compatibility`.
- Коллапсируемый onboarding-блок «Что это?» на главной странице.
- RU/EN локализация для всех новых текстов.
- Тесты: `client-compatibility.test.js`, `export-targets.test.js`, `compatibility-api.test.js` (contract + backward compatibility + отсутствие утечки секретов), `compatibility-ui.test.js` (markup / script / locales / no-overpromise).

### Notes
- Сетевое ядро генератора не изменено: `.conf`, `vpn://` payload, H1–H4, CPS-пейлоады и mobile mode остались прежними. Релиз добавляет только пояснительную UX-метадату и onboarding.
- sing-box / Clash / Mihomo / Throne представлены как experimental/research без реального exporter — они не выдаются как stable путь импорта.

## [2.6.2] - 2026-07-04

### Added
- External source license audit (`docs/research/external-source-license-audit.md`) for the projects referenced by the roadmap and Claude Code / Codex prompt pack: license, copy decision, idea reuse, attribution requirement, compatibility and risk level per repository.
- Conservative source-usage policy: if a license is missing, unclear (`NOASSERTION` / `not found`), or incompatible, do not copy code — reimplement independently and use only ideas/behaviour. Includes a `Do not copy list`, `Attribution requirements`, and an `engineering audit, not legal advice` disclaimer.
- "External source usage" section in `README.md` and `CONTRIBUTING.md` linking the audit and reaffirming that external IP feeds / endpoint sources must only enter the internal candidate pipeline, never the generated user config.

### Notes
- Documentation / governance only: no external code was imported and no external runtime dependency was added.

## [2.6.1] - 2026-07-04

### Added
- Regression-тесты для модели маршрутизации 2.6.0: `full` / `split`, обратная совместимость запросов без `routeMode`, явный `routeMode=split` с пресетами (`__tests__/routing-mode.test.js`).
- Frontend guard-тесты (`__tests__/routing-frontend-guards.test.js`): блокировка пустого split tunnel до запроса, CIDR counter, порог предупреждения 80 %, жёсткий лимит 1000 CIDR, режим «Без лимита», отключение IPv6 в mobile-профиле, отсутствие лишних секретов в local history.
- Проверки на отсутствие утечки `PrivateKey` / `PresharedKey` / WARP token / `vpn://` payload / полного `.conf` в API-ошибках, warnings, result summary и telemetry (`__tests__/secret-leakage.test.js` включён в стандартный `npm test`).

### Changed
- Ничего в пользовательском поведении: релиз закрепляет `2.6.0 — Routing Clarity` тестами и contract-проверками, без новых функций и без изменения формата `.conf` или `vpn://`.

### Security
- Зафиксирован инвариант WARP AWG 2.0: `H1–H4` остаются `1/2/3/4` и не рандомизируются (пир Cloudflare — стандартный WireGuard peer). См. `__tests__/invariant-i3-warp-h-fixed.test.js`.

## [2.6.0] - 2026-06-27

### Added
- Явный выбор режима маршрутизации: полный туннель или выборочная маршрутизация. Переключатель находится в настройках на вкладке «Маршруты».
- Выборочная маршрутизация теперь требует хотя бы одно выбранное направление. Генератор больше не подменяет пустой split tunnel на полный туннель — ни на фронте, ни на сервере.
- Пояснения к AllowedIPs: что попадёт в маршруты, зачем нужен лимит 1000 CIDR, почему большие списки могут быть нестабильны на телефонах и роутерах.
- DNS presets: Comss.one (`83.220.169.155, 212.109.195.93`) и malw.link (`80.253.249.40, 193.23.209.189` + IPv6). Closes [#2](https://github.com/HereIamGosu/amnezia-config-gen/issues/2).
- LICENSE file (AGPL-3.0-only, © 2026 HereIamGosu).
- Community-standards files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.editorconfig`.
- GitHub issue and pull-request templates under `.github/`.
- English `README.md` (now the canonical entry point) plus Russian `README.ru.md`.
- "Critical Invariants" block in README — single source of truth for AmneziaWG-specific rules.
- CI workflow (`.github/workflows/ci.yml`): lint, tests (`node:test`), `presets-fallback` drift check on Node 20.
- Invariant test suite `__tests__/invariant-*.test.js` (I1–I10) covering uppercase `I1`, WARP `S=0`/`H=1..4`/`MTU=1280`, AWG2 field order, IPv4 default, mobile-mode overrides, mobile→router composition, `cps5` payload shape, `vpn://` link round-trip.
- `npm test` and `npm run test:coverage` scripts; `npm run lint` now enforces `--max-warnings 0`.
- `package.json` metadata: `author`, `repository`, `bugs`, `homepage`, `keywords`, `engines.node ≥ 20`.

### Changed
- License: `ISC` → `AGPL-3.0-only`.
- Healthcheck workflow now writes snapshots to the orphan branch `healthcheck-snapshots` instead of committing back to `main` (eliminates ~70% of historical commit noise).

### Removed
- Deprecated `api/warpAmneziaCpsPayload.js` (superseded by `pickRandomCpsPayload()` in `api/warpCpsPayloads.js`).
- Private documentation moved to gitignored on-disk-only state: `CLAUDE.md`, `docs/**`. These were also purged from git history via `git filter-repo`.

### Security
- Repository git history rewritten with `git filter-repo` to remove private documentation paths. All pre-rewrite commit SHAs are invalid; existing clones must re-clone or `git reset --hard origin/main`. See [SECURITY.md](./SECURITY.md).

## [2.5.0] - 2026-06-09

### Added
- Post-generation result summary for AWG format, produced variants, endpoint and route sources, route mode and presets, device profiles, IPv6 state, and `vpn://` availability.
- Normalized `info`, `warning`, and `blocking` risk labels for legacy string, object, array, null, and undefined warning shapes.
- Concise RU/EN diagnostic next steps for connection, DNS/AllowedIPs, mobile-network, and import problems.

### Security
- Result explanations use response metadata and form state only; `.conf` contents, private keys, WARP tokens, full endpoints, and full CIDR lists are not copied into the summary model or logs.
- Endpoint health/status information is presented as risk reduction, not a guarantee that UDP works from the user's network.

## [2.4.1] - 2026-06-08

### Added
- Explicit regression coverage for invariants I1–I10, including IPv4-only default routes, mobile `AllowedIPs`, empty-`I1` CPS handling, and `vpn://` third-party profile round-trip.
- Fallback smoke tests for missing Vercel KV, partial endpoint failure, CIDR source fallback, `/api/status` registry source, and `/api/iplist` route source.
- Manual iOS `vpn://` verification checklist at `docs/manual-checks/vpn-link-ios.md`.

### Fixed
- Default full-tunnel routes are IPv4-only unless IPv6 is explicitly enabled.
- `/api/iplist` reports `cidrSource: "static"` when the response is built only from bundled static CIDRs.

## [2.1.0] - 2026-05

Pre-canonization snapshot. Notable features added in this line:

- `cps5` extra concealment packets (I2..I5) for AmneziaWG 2.0.
- `mobile=1` profile (Jc=3, Jmin=64, Jmax=128, MTU=1280, IPv4-only).
- `link=1` response field producing `vpn://...` AmneziaVPN one-tap import URI.
- Mobile vs router mode composition rule (router caps win on overlap).
- Fix: `vpn://` format compatible with AmneziaVPN (resolves Error 900).
- Fix: copy-vpn-link button wraps to its own row on mobile viewports.
