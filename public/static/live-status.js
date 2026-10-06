(function initLiveStatus(globalScope) {
  'use strict';

  // Live service status shared by the status modal (index.html) and status.html.
  // Data always comes from /api/status + /api/healthcheck at request time; nothing is
  // cached client-side beyond the last render, and a failed refresh never leaves old
  // data on screen.

  const DEFAULTS = Object.freeze({
    timeoutMs: 8000, // /api/healthcheck probes time out at 5 s server-side
    pollMs: 60_000, // /api/healthcheck caches probes for 30 s, polling faster is useless
    minGapMs: 15_000, // floor between requests, e.g. on rapid tab switching
    staleAfterMs: 120_000, // a render older than this is cleared before refreshing
    maxDataAgeMs: 300_000, // server-side age of the probe result (server clock only)
  });

  const STATUS_URL = '/api/status';
  const HEALTH_URL = '/api/healthcheck';

  class LiveStatusError extends Error {
    constructor(kind, message, retryAfterMs = null) {
      super(message);
      this.name = 'LiveStatusError';
      this.kind = kind; // timeout | rate_limited | http | network | invalid | stale
      this.retryAfterMs = retryAfterMs;
    }
  }

  const parseRetryAfter = (value) => {
    const seconds = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  };

  const fetchJson = async (fetchImpl, url, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 429) {
        throw new LiveStatusError('rate_limited', `${url}: HTTP 429`, parseRetryAfter(res.headers?.get?.('Retry-After')));
      }
      if (!res.ok) throw new LiveStatusError('http', `${url}: HTTP ${res.status}`);
      try {
        return await res.json();
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        throw new LiveStatusError('invalid', `${url}: invalid JSON`);
      }
    } catch (err) {
      if (err instanceof LiveStatusError) throw err;
      if (err && err.name === 'AbortError') throw new LiveStatusError('timeout', `${url}: timeout after ${timeoutMs} ms`);
      throw new LiveStatusError('network', `${url}: network error`);
    } finally {
      clearTimeout(timer);
    }
  };

  const parseTime = (value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN);

  const probeState = (probe) => {
    if (!probe || typeof probe.ok !== 'boolean') return null;
    return {
      status: probe.ok ? 'ok' : 'error',
      latencyMs: probe.ok && Number.isFinite(probe.latencyMs) ? probe.latencyMs : null,
    };
  };

  // /api/status states (src/server/endpointStatus.js); unknown = no health data, not a failure.
  const POOL_STATUS = { ok: 'ok', degraded: 'degraded', down: 'error', unknown: 'unknown' };

  /**
   * Validates both API payloads and turns them into a render-ready snapshot.
   * Throws LiveStatusError('invalid' | 'stale') instead of returning partial data.
   */
  const buildSnapshot = (statusData, healthData, { maxDataAgeMs = DEFAULTS.maxDataAgeMs } = {}) => {
    const services = healthData && typeof healthData === 'object' ? healthData.services : null;
    const api = probeState(services?.api);
    const engage = probeState(services?.engage);
    const checkedAt = parseTime(healthData?.checkedAt);
    const updatedAt = parseTime(statusData?.updated_at);
    const poolStatus = POOL_STATUS[statusData?.status];

    if (!api || !engage || !poolStatus || Number.isNaN(checkedAt) || Number.isNaN(updatedAt)) {
      throw new LiveStatusError('invalid', 'unexpected status payload');
    }

    // Both timestamps come from the server clock, so a wrong client clock cannot make
    // fresh data look stale (or the other way round). The two requests run in parallel,
    // so the probe may finish slightly after /api/status answered.
    const ageMs = updatedAt - checkedAt;
    if (ageMs > maxDataAgeMs || ageMs < -60_000) {
      throw new LiveStatusError('stale', `probe result is ${Math.round(ageMs / 1000)} s old`);
    }

    const counts = statusData.candidates && typeof statusData.candidates === 'object' ? statusData.candidates : {};
    const list = [
      { key: 'warp_api', ...api },
      { key: 'warp_engage', ...engage },
    ];
    const cidr = probeState(services.cidr);
    if (cidr) list.push({ key: 'cidr_source', ...cidr });
    list.push({
      key: 'endpoint_pool',
      status: poolStatus,
      activeEndpoints: Number.isFinite(statusData.active_endpoints) ? statusData.active_endpoints : null,
      candidatePorts: Object.keys(counts).filter((port) => Number(counts[port]) > 0),
      fallback: statusData.cache_source === 'fallback',
      measured: statusData.health_source === 'runtime',
    });

    // Whether this deployment publishes Endpoint Lab files: only then does the page request /api/lab.
    const labAvailable = statusData.lab && typeof statusData.lab.available === 'boolean' ? statusData.lab.available : null;

    return { checkedAt: new Date(checkedAt).toISOString(), services: list, lab: { available: labAvailable } };
  };

  const loadSnapshot = async ({ fetchImpl = globalScope.fetch.bind(globalScope), timeoutMs = DEFAULTS.timeoutMs, maxDataAgeMs } = {}) => {
    const [statusData, healthData] = await Promise.all([
      fetchJson(fetchImpl, STATUS_URL, timeoutMs),
      fetchJson(fetchImpl, HEALTH_URL, timeoutMs),
    ]);
    return buildSnapshot(statusData, healthData, { maxDataAgeMs });
  };

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  })[ch]);

  const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? ''));

  // Names and states match the "System status" card in the hero, so the dialog reads as its detailed view.
  const DEFAULT_LABELS = Object.freeze({
    names: {
      generator: 'Генератор API',
      warp_api: 'Регистрация WARP',
      warp_engage: 'WARP endpoint',
      cidr_source: 'Источник CIDR',
      endpoint_pool: 'Встроенный список IP WARP',
      lab: 'Endpoint Lab',
    },
    hosts: {
      warp_api: 'api.cloudflareclient.com',
      warp_engage: 'engage.cloudflareclient.com',
      cidr_source: 'iplist.opencck.org',
    },
    generatorDetail: 'сервер генератора отвечает',
    stateText: { ok: 'Работает', degraded: 'Нестабильно', error: 'Недоступен', unknown: 'Нет данных' },
    latency: '{ms} мс',
    unreachable: 'нет соединения',
    poolDetail: 'адресов: {count} · порты: {ports}',
    poolUnmeasured: 'не измеряется',
    labOpen: 'Открыть Lab',
    none: '—',
  });

  // Inline paths instead of the page sprite: /status.html has none.
  const STATE_PATHS = {
    ok: '<path d="M20 6 9 17l-5-5"/>',
    degraded: '<path d="M12 7v6"/><path d="M12 17h.01"/>',
    error: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    unknown: '<path d="M8 12h8"/>',
  };

  const toneOf = (status) => (Object.prototype.hasOwnProperty.call(STATE_PATHS, status) ? status : 'unknown');

  const stateIconHtml = (tone) => `<span class="state-icon state-icon--${tone}" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24">${STATE_PATHS[tone]}</svg></span>`;

  const rowHtml = ({ key, tone, name, meta, stateText }) => `
      <li class="status-detail" data-service="${escapeHtml(key)}">
        ${stateIconHtml(tone)}
        <span class="status-detail__info">
          <span class="status-detail__name">${escapeHtml(name)}</span>
          <span class="status-detail__meta">${escapeHtml(meta)}</span>
        </span>
        <span class="status-row__state status-row__state--${tone}">${escapeHtml(stateText)}</span>
      </li>`;

  const serviceRow = (svc, labels) => {
    const tone = toneOf(svc.status);
    const name = labels.names[svc.key] || svc.key;
    if (svc.key === 'endpoint_pool') {
      const meta = fill(labels.poolDetail, {
        count: svc.activeEndpoints ?? labels.none,
        ports: svc.candidatePorts.length ? svc.candidatePorts.join(', ') : labels.none,
      });
      // Without runtime health data the list is reference information, not a failure.
      return svc.measured
        ? { key: svc.key, tone, name, meta, stateText: labels.stateText[tone] }
        : { key: svc.key, tone: 'unknown', name, meta, stateText: labels.poolUnmeasured };
    }
    const reach = svc.status === 'ok'
      ? (svc.latencyMs != null ? fill(labels.latency, { ms: svc.latencyMs }) : labels.stateText.ok)
      : labels.unreachable;
    return { key: svc.key, tone, name, meta: `${labels.hosts[svc.key] || ''} · ${reach}`, stateText: labels.stateText[tone] };
  };

  /**
   * Renders the snapshot as the dialog's service list. Every interpolated value is escaped.
   * options.labHref adds an Endpoint Lab row with empty #statusModalLab* slots that the page fills
   * from its own /api/lab poller (status.js); without it (/status.html) there is no Lab row.
   */
  const renderCardsHtml = (snapshot, labels = DEFAULT_LABELS, { labHref = null } = {}) => {
    const services = snapshot.services.filter((svc) => svc.key !== 'endpoint_pool');
    const pool = snapshot.services.find((svc) => svc.key === 'endpoint_pool');
    const rows = [
      // A snapshot exists only if the generator's own API answered.
      rowHtml({ key: 'generator', tone: 'ok', name: labels.names.generator, meta: labels.generatorDetail, stateText: labels.stateText.ok }),
      ...services.map((svc) => rowHtml(serviceRow(svc, labels))),
    ];
    if (labHref) {
      rows.push(`
      <li class="status-detail" data-service="lab">
        <span class="state-icon state-icon--loading" id="statusModalLabIcon" aria-hidden="true"></span>
        <span class="status-detail__info">
          <span class="status-detail__name">${escapeHtml(labels.names.lab)}</span>
          <span class="status-detail__meta"><span id="statusModalLabMeta"></span><a class="status-detail__link" href="${escapeHtml(labHref)}">${escapeHtml(labels.labOpen)}</a></span>
        </span>
        <span class="status-row__state" id="statusModalLabState"></span>
      </li>`);
    }
    if (pool) rows.push(rowHtml(serviceRow(pool, labels)));
    return `<ul class="status-detail-list">${rows.join('')}</ul>`;
  };

  /**
   * Polls loadSnapshot only while active and the document is visible.
   * - hidden tab or stopped: timers cleared, no requests, nothing rendered;
   * - becoming visible: refresh (respecting minGapMs), clearing data older than staleAfterMs;
   * - a periodic check (and focus/pageshow, which fire after a wake that sends no
   *   visibilitychange) clears stale data, runs a request that became due while timers were
   *   paused by sleep, and keeps the shown retry time current;
   * - HTTP 429: no request until Retry-After has passed (at least pollMs);
   * - a request still running at stop() is not discarded: its result (and any Retry-After)
   *   is kept and shown on the next start() if it is still fresh enough;
   * - the view is never "loading" unless a request is in flight or about to be sent.
   * performance.now() and timers do not advance while macOS/iOS sleeps, so ages and due
   * times are tracked on both clocks: data is stale, and a wait is over, as soon as either
   * clock says so. Real time passing during sleep counts for the server's rate limit too.
   */
  const createPoller = ({
    load,
    onLoading,
    onData,
    onError,
    pollMs = DEFAULTS.pollMs,
    minGapMs = DEFAULTS.minGapMs,
    staleAfterMs = DEFAULTS.staleAfterMs,
    expiryCheckMs = 5_000,
    doc = globalScope.document,
    win = globalScope,
    monoNow = () => globalScope.performance.now(),
    wallNow = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  }) => {
    let active = false;
    let pollTimer = null;
    let expiryTimer = null;
    let inflight = false;
    let lastAttemptMono = -Infinity;
    let lastAttemptWall = -Infinity;
    let blockedUntilMono = -Infinity;
    let blockedUntilWall = -Infinity;
    let nextAttemptWall = null;
    let last = null; // latest result: { kind: 'data' | 'error', value, wallAt }
    let view = null; // what is on screen: 'loading' | 'data' | 'error'
    let shownData = null; // the data result on screen (an entry of the same shape as `last`)

    const canRun = () => active && !doc.hidden;
    const RETRY_AFTER_WAIT = new LiveStatusError('rate_limited', 'waiting for Retry-After');

    const showLoading = () => {
      shownData = null;
      if (view !== 'loading') { view = 'loading'; onLoading(); }
    };
    const showData = (result) => { view = 'data'; shownData = result; onData(result.value); };
    let shownError = null;
    let shownRetryAt = null;
    const showError = (err) => {
      if (view === 'error' && shownError === err && shownRetryAt === nextAttemptWall) return;
      view = 'error';
      shownData = null;
      shownError = err;
      shownRetryAt = nextAttemptWall;
      onError(err, { retryAt: nextAttemptWall });
    };

    const dataAge = () => (last && last.kind === 'data' ? wallNow() - last.wallAt : null);
    const isStale = (result) => {
      const age = wallNow() - result.wallAt;
      return age >= staleAfterMs || age < 0; // a clock moved backwards counts as stale
    };
    const sinceLastAttempt = () => {
      const wall = wallNow() - lastAttemptWall;
      return Math.max(monoNow() - lastAttemptMono, wall >= 0 ? wall : 0);
    };
    const blockedFor = () => Math.min(blockedUntilMono - monoNow(), blockedUntilWall - wallNow());

    const schedule = (delayMs) => {
      if (pollTimer != null) clearTimer(pollTimer);
      pollTimer = null;
      nextAttemptWall = null;
      if (!canRun()) return;
      const delay = Math.max(0, delayMs);
      nextAttemptWall = wallNow() + delay;
      pollTimer = setTimer(() => { pollTimer = null; tick(); }, delay);
    };

    const armExpiry = () => {
      if (expiryTimer != null) clearTimer(expiryTimer);
      expiryTimer = null;
      if (canRun()) expiryTimer = setTimer(() => { expiryTimer = null; checkExpiry(); }, expiryCheckMs);
    };

    const clearTimers = () => {
      if (pollTimer != null) clearTimer(pollTimer);
      if (expiryTimer != null) clearTimer(expiryTimer);
      pollTimer = null;
      expiryTimer = null;
      nextAttemptWall = null;
    };

    // Checks both the newest result and the result actually on screen: they differ when a
    // request finished (or failed) while the tab was hidden.
    const dropStaleData = () => {
      if (last && last.kind === 'data' && isStale(last)) last = null;
      if (view === 'data' && shownData && isStale(shownData)) showLoading();
    };

    // Brings the view in line with the state (call after dropStaleData() and tick()):
    // - request in flight: show the newest fresh data, otherwise "loading";
    // - newest result not on screen yet: show it (it may have finished while hidden);
    // - nothing to show and a Retry-After wait running: say so;
    // - nothing to show otherwise: a request is scheduled, so "loading" is truthful.
    const refreshView = () => {
      if (inflight) {
        if (last && last.kind === 'data' && last !== shownData) showData(last); // newer, still fresh
        else if (view !== 'data') showLoading();
      } else if (last && last.kind === 'error') {
        showError(last.value);
      } else if (last) {
        if (last !== shownData) showData(last);
      } else if (blockedFor() > 0) {
        showError(RETRY_AFTER_WAIT);
      } else {
        showLoading();
      }
    };

    const tick = async () => {
      if (!canRun() || inflight) return;
      if (blockedFor() > 0) { schedule(blockedFor()); return; }
      const gap = sinceLastAttempt();
      if (gap < minGapMs) { schedule(minGapMs - gap); return; }

      inflight = true;
      lastAttemptMono = monoNow();
      lastAttemptWall = wallNow();
      let delay = pollMs;
      try {
        const value = await load();
        last = { kind: 'data', value, wallAt: wallNow() };
      } catch (err) {
        if (err && err.kind === 'rate_limited') {
          delay = Math.max(err.retryAfterMs ?? pollMs, pollMs);
          blockedUntilMono = monoNow() + delay;
          blockedUntilWall = wallNow() + delay;
        }
        last = { kind: 'error', value: err, wallAt: wallNow() };
      }
      inflight = false;
      if (!canRun()) return; // kept in `last`; rendered on the next start()/resume()
      schedule(delay);
      if (last.kind === 'data') showData(last);
      else showError(last.value);
      armExpiry();
    };

    const resume = () => {
      if (!canRun()) return;
      dropStaleData();
      tick();
      refreshView();
      armExpiry();
    };

    // Periodic, and on focus/pageshow: catches up after sleep without extra polling.
    const checkExpiry = () => {
      if (!canRun()) return;
      dropStaleData();
      if (view === 'loading' || (nextAttemptWall != null && wallNow() >= nextAttemptWall)) tick();
      refreshView();
      armExpiry();
    };

    const onVisibilityChange = () => {
      if (!active) return;
      if (doc.hidden) clearTimers();
      else resume();
    };

    return {
      start() {
        if (active) return;
        active = true;
        doc.addEventListener('visibilitychange', onVisibilityChange);
        win.addEventListener('focus', checkExpiry);
        win.addEventListener('pageshow', checkExpiry);
        view = null;
        shownData = null;
        if (!canRun()) return; // a hidden tab renders on its first visibilitychange
        // Data from a request that finished moments ago is reused instead of firing a new one.
        const age = dataAge();
        if (age != null && !(age >= 0 && age < minGapMs)) last = null;
        tick();
        refreshView();
        armExpiry();
      },
      stop() {
        if (!active) return;
        active = false;
        doc.removeEventListener('visibilitychange', onVisibilityChange);
        win.removeEventListener('focus', checkExpiry);
        win.removeEventListener('pageshow', checkExpiry);
        clearTimers();
      },
      isActive: () => active,
    };
  };

  const api = {
    DEFAULTS,
    DEFAULT_LABELS,
    LiveStatusError,
    buildSnapshot,
    loadSnapshot,
    renderCardsHtml,
    createPoller,
    parseRetryAfter,
    fetchJson,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.LiveStatus = api;
})(typeof window !== 'undefined' ? window : globalThis);
