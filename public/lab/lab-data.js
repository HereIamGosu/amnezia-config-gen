// public/lab/lab-data.js
//
// Endpoint Lab: единственный адаптер данных. Здесь — адрес публичного API, запрос, таймаут,
// Retry-After, проверка ответа (LabCore.normalize*) и фикстуры для локальной разработки.
// Компоненты страницы получают только результат { kind, view } и не знают, откуда пришли данные.
//
// Публичного HTTP API у Lab пока нет: LAB_API.overview = null, и адаптер сразу отвечает
// { kind: 'not-connected' }, не делая запросов. Подключение — заполнить LAB_API (см.
// docs/specs/endpoint-lab-frontend.md). Классический скрипт: window.LabData в браузере, module.exports в node.

'use strict';

(function initLabData(root) {
  const Core = typeof module === 'object' && module.exports ? require('./lab-core.js') : root.LabCore;

  // Адреса будущего публичного API (same-origin, CSP connect-src 'self'). null — не подключено.
  const LAB_API = Object.freeze({
    overview: null, // например '/api/lab'
    endpoint: null, // например (id, range) => `/api/lab?endpoint=${encodeURIComponent(id)}&range=${range}`
  });

  // Lab пересчитывает пул раз в минуту: чаще 30 с опрашивать незачем.
  const POLL_INTERVAL_MS = 30_000;
  const HIDDEN_REFRESH_AFTER_MS = 10_000;
  const REQUEST_TIMEOUT_MS = 10_000;
  const MAX_RESPONSE_CHARS = 2_000_000;
  const BACKOFF_MAX_MS = 5 * 60_000;
  const RETRY_AFTER_MIN_MS = 5_000;
  const RETRY_AFTER_MAX_MS = 10 * 60_000;

  /** Retry-After: секунды или HTTP-дата → мс в разумных пределах; null — заголовка нет. */
  const parseRetryAfter = (value, now) => {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    let ms = null;
    if (/^\d+$/.test(text)) ms = Number(text) * 1000;
    else if (Number.isFinite(Date.parse(text))) ms = Date.parse(text) - now;
    if (ms === null || !Number.isFinite(ms)) return null;
    return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
  };

  /** Задержка до следующего опроса: обычный интервал, просьба сервера или растущая пауза после ошибок. */
  const nextPollDelay = (result, failures) => {
    if (!result || result.kind === 'not-connected') return null;
    if (result.retryAfterMs) return Math.max(result.retryAfterMs, result.kind === 'ok' ? POLL_INTERVAL_MS : 0);
    if (result.kind === 'ok') return POLL_INTERVAL_MS;
    return Math.min(BACKOFF_MAX_MS, POLL_INTERVAL_MS * 2 ** Math.max(0, Math.min(failures - 1, 4)));
  };

  /** JSON по адресу с таймаутом и ограничением размера. Сетевые ошибки — результат, а не исключение. */
  const fetchJson = async (fetchImpl, url, now) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      });
      const retryAfterMs = parseRetryAfter(res.headers && res.headers.get ? res.headers.get('Retry-After') : null, now);
      if (!res.ok) return { kind: 'error', reason: 'http', status: res.status, retryAfterMs };
      const text = await res.text();
      if (text.length > MAX_RESPONSE_CHARS) return { kind: 'malformed', reason: 'too-large' };
      try {
        return { kind: 'json', data: JSON.parse(text), retryAfterMs };
      } catch {
        return { kind: 'malformed', reason: 'json' };
      }
    } catch (err) {
      return { kind: 'error', reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * Источник данных Lab.
   * @param {object} opts
   * @param {Function} [opts.fetchImpl]  fetch (в тестах — заглушка)
   * @param {object}   [opts.api]        адреса API (по умолчанию LAB_API)
   * @param {string}   [opts.fixture]    имя фикстуры (уже проверено LabCore.fixtureFromLocation)
   * @param {object}   [opts.fixtures]   window.LabFixtures
   * @param {Function} [opts.now]
   */
  const createLabSource = ({ fetchImpl, api = LAB_API, fixture = null, fixtures = null, now = Date.now } = {}) => {
    const useFixture = !!(fixture && fixtures);
    const connected = useFixture || !!api.overview;

    const fromRaw = (raw, normalize, extra) => {
      const result = normalize(raw, now());
      if (!result.ok) return { kind: 'malformed', reason: result.reason };
      return { kind: 'ok', view: result.view, issues: result.issues || [], ...extra };
    };

    const loadOverview = async () => {
      if (useFixture) {
        const raw = await fixtures.overview(fixture, now());
        if (raw && raw.__error) return { kind: 'error', reason: raw.__error, status: raw.status };
        return fromRaw(raw, Core.normalizeOverview, {});
      }
      if (!api.overview) return { kind: 'not-connected' };
      const res = await fetchJson(fetchImpl, api.overview, now());
      if (res.kind !== 'json') return res;
      const out = fromRaw(res.data, Core.normalizeOverview, {});
      if (out.kind === 'ok') {
        const fromBody = out.view.retryAfterSec ? out.view.retryAfterSec * 1000 : null;
        out.retryAfterMs = res.retryAfterMs || fromBody;
      }
      return out;
    };

    const loadEndpoint = async (id, range = 'all') => {
      const parsed = Core.parseEndpointId(id);
      if (!parsed) return { kind: 'malformed', reason: 'id' };
      const safeRange = Core.HISTORY_RANGES.includes(range) ? range : 'all';
      if (useFixture) {
        const raw = await fixtures.endpoint(fixture, parsed.id, safeRange, now());
        if (raw && raw.__error) return { kind: 'error', reason: raw.__error, status: raw.status };
        return fromRaw(raw, Core.normalizeEndpointDetails, {});
      }
      if (typeof api.endpoint !== 'function') return { kind: 'not-connected' };
      const res = await fetchJson(fetchImpl, api.endpoint(parsed.id, safeRange), now());
      if (res.kind !== 'json') return res;
      return fromRaw(res.data, Core.normalizeEndpointDetails, {});
    };

    return { connected, isFixture: useFixture, loadOverview, loadEndpoint };
  };

  /**
   * Опрос сводки: один запрос за раз, пауза в скрытой вкладке, обновление при возвращении.
   * onResult получает каждый результат; отображение возраста данных (тикер) — отдельный процесс.
   */
  const createPoller = ({ load, onResult, doc, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) => {
    let timer = null;
    let inFlight = false;
    let failures = 0;
    let lastAttemptAt = 0;
    let stopped = false;
    let pendingDelay = null;

    const schedule = (delay) => {
      if (timer) clearTimer(timer);
      timer = null;
      pendingDelay = delay;
      if (delay === null || stopped || (doc && doc.hidden)) return;
      timer = setTimer(run, delay);
    };

    const run = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      timer = null;
      lastAttemptAt = now();
      let result;
      try {
        result = await load();
      } catch {
        result = { kind: 'error', reason: 'network' };
      }
      inFlight = false;
      failures = result.kind === 'ok' || result.kind === 'not-connected' ? 0 : failures + 1;
      onResult(result);
      schedule(nextPollDelay(result, failures));
    };

    const onVisibility = () => {
      if (doc.hidden) {
        if (timer) clearTimer(timer);
        timer = null;
        return;
      }
      if (pendingDelay === null) return;
      if (now() - lastAttemptAt >= HIDDEN_REFRESH_AFTER_MS) run();
      else schedule(Math.max(1000, pendingDelay - (now() - lastAttemptAt)));
    };
    if (doc) doc.addEventListener('visibilitychange', onVisibility);

    return {
      start: () => run(),
      /** Ручное обновление («Обновить»): сразу, если запрос не идёт. */
      refresh: () => run(),
      stop: () => {
        stopped = true;
        if (timer) clearTimer(timer);
        if (doc) doc.removeEventListener('visibilitychange', onVisibility);
      },
    };
  };

  const api = {
    LAB_API,
    POLL_INTERVAL_MS,
    BACKOFF_MAX_MS,
    parseRetryAfter,
    nextPollDelay,
    createLabSource,
    createPoller,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LabData = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
