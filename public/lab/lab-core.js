// public/lab/lab-core.js
//
// Endpoint Lab: чистая логика без DOM — перечисления, проверка недоверенных данных публичного
// контракта (docs/specs/endpoint-lab-frontend.md), модель представления, форматирование времени и процентов,
// вывод общего состояния Lab, фильтры и сортировка списка, допуск фикстур только на localhost.
// Классический скрипт: в браузере отдаёт window.LabCore, в node (тесты) — module.exports.

/* global Intl -- встроенный API браузера и node */

'use strict';

(function initLabCore(root) {
  // ── Перечисления контракта ─────────────────────────────────────

  const SCHEMA_VERSION = 1;
  const LAB_STATUSES = ['ok', 'degraded', 'unavailable'];

  // Публичные состояния endpoint'а. Переходные состояния проверки бэкенда показываются как CHECKING,
  // ручная блокировка адреса — флаг оператора, в публичный контракт не попадает.
  const ENDPOINT_STATES = ['ACTIVE', 'VERIFIED', 'SUSPECT', 'QUARANTINE', 'DEAD', 'DISCOVERED', 'CHECKING'];
  const TRANSIENT_STATES = { PROBING: 'CHECKING', HANDSHAKE_OK: 'CHECKING', VERIFYING: 'CHECKING' };
  // Порядок в списке по умолчанию: рабочие сверху, выведенные из пула внизу.
  const STATE_RANK = { ACTIVE: 0, CHECKING: 1, VERIFIED: 2, SUSPECT: 3, DISCOVERED: 4, QUARANTINE: 5, DEAD: 6, EXPIRED: 1, UNKNOWN: 7 };

  // source_class бэкенда — происхождение адреса, не его здоровье. negative_control не публикуется.
  const SOURCES = ['consumer_official_seed', 'phase_a_verified', 'legacy_builtin', 'cloudflare_one_observation', 'community', 'experimental'];
  const SESSION_RESULTS = ['first', 'retry', 'failed'];
  const CHECK_RESULTS = ['ok', 'fail'];
  const EVENT_TYPES = ['restored', 'promoted', 'discovery', 'suspect', 'excluded', 'demoted', 'dead'];
  const HISTORY_RESULTS = ['first', 'retry', 'fail'];
  const HISTORY_RANGES = ['all', '24h', '7d', '30d'];
  const CHART_RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };

  // Верхние границы: ответ больше — обрезается, а не ломает страницу.
  const LIMITS = Object.freeze({
    endpoints: 500,
    activeHistory: 1500,
    events: 100,
    timeline: 96,
    buckets: 120,
    detailEvents: 100,
    text: 160,
    count: 100000,
    observations: 10000000,
    ttlSec: 7 * 24 * 3600,
  });

  // Расхождение часов сервера и браузера, которое ещё не делает метку времени «из будущего».
  const CLOCK_SKEW_MS = 5 * 60e3;
  // Снимок старше этого считается устаревшим даже при свежей последней проверке (Lab пишет его раз в минуту).
  const SNAPSHOT_STALE_MS = 5 * 60e3;

  const FIXTURE_NAMES = ['healthy', 'degraded', 'unavailable', 'stale', 'empty', 'mixed', 'partial', 'malformed', 'error', 'loading'];

  // ── Примитивы проверки ─────────────────────────────────────────

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const isFraction = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

  /** Метка времени ISO-8601 → мс; null для неразборчивой или заметно «будущей». */
  const parseTime = (value, now) => {
    if (typeof value !== 'string' || value.length > 40) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    if (ms > now + CLOCK_SKEW_MS) return null;
    return Math.min(ms, now);
  };

  /** Текст с сервера: строка без управляющих символов, обрезанная до разумной длины. */
  const cleanText = (value, max = LIMITS.text) => {
    if (typeof value !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

  /** IP для показа: строгий IPv4 или правдоподобный IPv6 (только допустимые символы и длина). */
  const normalizeIp = (value) => {
    if (typeof value !== 'string') return null;
    const ip = value.trim().toLowerCase();
    if (IPV4.test(ip)) return { ip, family: 4 };
    if (ip.length >= 2 && ip.length <= 45 && ip.includes(':') && /^[0-9a-f:.]+$/.test(ip) && !ip.includes(':::')) {
      return { ip, family: 6 };
    }
    return null;
  };

  const endpointId = (ip, family, port) => (family === 6 ? `[${ip}]:${port}` : `${ip}:${port}`);

  /** "1.2.3.4:2408" или "[2606:4700::1]:2408" → { ip, port } либо null. */
  const parseEndpointId = (value) => {
    if (typeof value !== 'string' || value.length > 60) return null;
    const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(value) || /^([0-9.]+):(\d{1,5})$/.exec(value);
    if (!m) return null;
    const addr = normalizeIp(m[1]);
    const port = Number(m[2]);
    if (!addr || !isInt(port, 1, 65535)) return null;
    return { ip: addr.ip, family: addr.family, port, id: endpointId(addr.ip, addr.family, port) };
  };

  const normalizeState = (value) => {
    if (typeof value !== 'string') return 'UNKNOWN';
    const s = value.trim().toUpperCase();
    if (TRANSIENT_STATES[s]) return TRANSIENT_STATES[s];
    return ENDPOINT_STATES.includes(s) ? s : 'UNKNOWN';
  };

  const pickEnum = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : null);

  // ── Нормализация разделов ──────────────────────────────────────

  const normalizeCounts = (raw) => {
    if (!isObject(raw)) return null;
    const keys = ['active', 'verified', 'suspect', 'quarantine', 'dead'];
    const out = {};
    for (const key of keys) {
      if (!isInt(raw[key], 0, LIMITS.count)) return null;
      out[key] = raw[key];
    }
    return out;
  };

  const normalizeFreshness = (raw, now) => {
    if (!isObject(raw)) return null;
    const ttl = raw.activeTtlSec;
    return {
      lastSuccessAt: parseTime(raw.lastSuccessAt, now),
      oldestActiveVerifiedAt: parseTime(raw.oldestActiveVerifiedAt, now),
      activeTtlSec: isInt(ttl, 1, LIMITS.ttlSec) ? ttl : null,
    };
  };

  const normalizeSessions = (raw) => {
    if (!isObject(raw)) return null;
    const { firstSession, retryRescued, failed } = raw;
    if (!isFraction(firstSession) || !isFraction(retryRescued) || !isFraction(failed)) return null;
    const sum = firstSession + retryRescued + failed;
    // Доли одного окна должны складываться в единицу (с запасом на округление бэкенда).
    if (Math.abs(sum - 1) > 0.02) return null;
    return {
      firstSession, retryRescued, failed, finalSuccess: Math.min(1, firstSession + retryRescued),
      // Основание долей: число проверок окна. Без него доли показываются, но «из скольких» неизвестно.
      samples: isInt(raw.samples, 1, LIMITS.observations) ? raw.samples : null,
      window: raw.window === '15m' ? '15m' : null,
    };
  };

  const normalizeActiveHistory = (raw, now) => {
    if (!Array.isArray(raw)) return null;
    const points = [];
    for (const item of raw.slice(-LIMITS.activeHistory)) {
      if (!isObject(item)) continue;
      const at = parseTime(item.at, now);
      if (at === null || !isInt(item.active, 0, LIMITS.count)) continue;
      points.push({ at, active: item.active });
    }
    points.sort((a, b) => a.at - b.at);
    return points;
  };

  const normalizeEvent = (item, now) => {
    if (!isObject(item)) return null;
    const type = pickEnum(item.type, EVENT_TYPES);
    const at = parseTime(item.at, now);
    if (!type || at === null) return null;
    const event = { type, at, endpoint: null, count: null };
    if (type === 'discovery') {
      if (!isInt(item.count, 0, LIMITS.count)) return null;
      event.count = item.count;
    } else {
      const ep = parseEndpointId(item.endpoint);
      if (!ep) return null;
      event.endpoint = ep.id;
    }
    return event;
  };

  const normalizeEvents = (raw, now, limit = LIMITS.events) => {
    if (!Array.isArray(raw)) return null;
    const events = raw.slice(0, limit * 2).map((item) => normalizeEvent(item, now)).filter(Boolean);
    events.sort((a, b) => b.at - a.at);
    return events.slice(0, limit);
  };

  const normalizeEndpoint = (item, now) => {
    if (!isObject(item)) return null;
    const addr = normalizeIp(item.ip);
    if (!addr || !isInt(item.port, 1, 65535)) return null;
    const state = normalizeState(item.state);
    const expiresAt = typeof item.expiresAt === 'string' && Number.isFinite(Date.parse(item.expiresAt)) ? Date.parse(item.expiresAt) : null;
    return {
      id: endpointId(addr.ip, addr.family, item.port),
      ip: addr.ip,
      family: addr.family,
      port: item.port,
      state,
      source: pickEnum(item.source, SOURCES) || (typeof item.source === 'string' ? 'other' : null),
      lastVerifiedAt: parseTime(item.lastVerifiedAt, now),
      expiresAt,
      session: pickEnum(item.session, SESSION_RESULTS),
      https: pickEnum(item.https, CHECK_RESULTS),
      reliability: isFraction(item.reliability) ? item.reliability : null,
    };
  };

  const normalizeEndpoints = (raw, now) => {
    if (!Array.isArray(raw)) return null;
    const seen = new Set();
    const list = [];
    let dropped = 0;
    for (const item of raw.slice(0, LIMITS.endpoints)) {
      const ep = normalizeEndpoint(item, now);
      if (!ep || seen.has(ep.id)) {
        dropped += 1;
        continue;
      }
      seen.add(ep.id);
      list.push(ep);
    }
    return { list, dropped, truncated: raw.length > LIMITS.endpoints };
  };

  /**
   * Сводка Lab из недоверенного JSON. Обязательны только schemaVersion, status и generatedAt;
   * испорченный раздел становится null (частичные данные), испорченные элементы списков отбрасываются.
   * @returns {{ ok: true, view: object, issues: string[] } | { ok: false, reason: string }}
   */
  const normalizeOverview = (raw, now) => {
    if (!isObject(raw)) return { ok: false, reason: 'not-object' };
    if (raw.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: 'schema' };
    const status = typeof raw.status === 'string' ? pickEnum(raw.status.toLowerCase(), LAB_STATUSES) : null;
    if (!status) return { ok: false, reason: 'status' };
    const generatedAt = parseTime(raw.generatedAt, now);
    if (generatedAt === null) return { ok: false, reason: 'generatedAt' };

    const issues = [];
    const section = (name, value) => {
      // null в контракте — «данных нет» (нет наблюдений, счётчики скрыты), а не сбой проверки.
      if (raw[name] !== undefined && raw[name] !== null && value === null) issues.push(name);
      if (raw[name] === undefined) issues.push(`${name}:missing`);
      return value;
    };
    const endpoints = section('endpoints', normalizeEndpoints(raw.endpoints, now));
    if (endpoints && endpoints.dropped) issues.push(`endpoints:dropped:${endpoints.dropped}`);
    return {
      ok: true,
      issues,
      view: {
        status,
        generatedAt,
        counts: section('counts', normalizeCounts(raw.counts)),
        freshness: section('freshness', normalizeFreshness(raw.freshness, now)),
        sessions: section('sessions', normalizeSessions(raw.sessions)),
        activeHistory: section('activeHistory', normalizeActiveHistory(raw.activeHistory, now)),
        events: section('events', normalizeEvents(raw.events, now)),
        endpoints: endpoints ? endpoints.list : null,
        retryAfterSec: isInt(raw.retryAfterSec, 1, 3600) ? raw.retryAfterSec : null,
        // active-only: режим совместимости API — список содержит только ACTIVE (нет истории и событий).
        coverage: raw.coverage === 'active-only' ? 'active-only' : 'full',
      },
    };
  };

  const normalizeCheck = (raw, now) => {
    if (!isObject(raw)) return null;
    const result = pickEnum(raw.result, CHECK_RESULTS);
    if (!result) return null;
    return { result, at: parseTime(raw.at, now) };
  };

  const normalizeHistory = (raw, now) => {
    if (!isObject(raw)) return null;
    const buckets = [];
    if (Array.isArray(raw.buckets)) {
      for (const b of raw.buckets.slice(-LIMITS.buckets)) {
        if (!isObject(b)) continue;
        const at = parseTime(b.at, now);
        if (at === null || !isInt(b.first, 0, LIMITS.count) || !isInt(b.retry, 0, LIMITS.count) || !isInt(b.fail, 0, LIMITS.count)) continue;
        buckets.push({ at, first: b.first, retry: b.retry, fail: b.fail });
      }
      buckets.sort((a, b) => a.at - b.at);
    }
    const events = [];
    if (Array.isArray(raw.events)) {
      for (const e of raw.events.slice(0, LIMITS.detailEvents * 2)) {
        if (!isObject(e)) continue;
        const at = parseTime(e.at, now);
        const result = pickEnum(e.result, HISTORY_RESULTS);
        if (at === null || !result) continue;
        events.push({ at, result, error: cleanText(e.error, 80) });
      }
      events.sort((a, b) => b.at - a.at);
    }
    return {
      range: pickEnum(raw.range, HISTORY_RANGES) || 'all',
      buckets,
      events: events.slice(0, LIMITS.detailEvents),
    };
  };

  /** Подробности одного endpoint'а; history — отдельный необязательный раздел. */
  const normalizeEndpointDetails = (raw, now) => {
    if (!isObject(raw) || raw.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: 'schema' };
    const endpoint = normalizeEndpoint(raw.endpoint, now);
    if (!endpoint) return { ok: false, reason: 'endpoint' };
    const checks = isObject(raw.checks) ? {
      handshake: normalizeCheck(raw.checks.handshake, now),
      tunnel: normalizeCheck(raw.checks.tunnel, now),
      https: normalizeCheck(raw.checks.https, now),
    } : null;
    const st = raw.stability;
    const stability = isObject(st) ? {
      h1: isFraction(st.h1) ? st.h1 : null,
      h24: isFraction(st.h24) ? st.h24 : null,
      observations: isInt(st.observations, 0, LIMITS.observations) ? st.observations : null,
    } : null;
    const timeline = Array.isArray(raw.timeline) ? raw.timeline.slice(-LIMITS.timeline).map((p) => {
      if (!isObject(p)) return null;
      const at = parseTime(p.at, now);
      return at === null ? null : { at, state: normalizeState(p.state) };
    }).filter(Boolean).sort((a, b) => a.at - b.at) : null;
    let lastError = null;
    if (isObject(raw.lastError)) {
      const code = typeof raw.lastError.code === 'string' && /^[a-z0-9_]{1,40}$/.test(raw.lastError.code) ? raw.lastError.code : null;
      const message = cleanText(raw.lastError.message);
      if (code || message) lastError = { code, message, at: parseTime(raw.lastError.at, now) };
    }
    return {
      ok: true,
      view: {
        endpoint,
        checks,
        stability,
        timeline,
        lastError,
        // Нет поля — неизвестно (режим совместимости); null — ошибок не было.
        lastErrorKnown: raw.lastError !== undefined,
        history: raw.history === undefined ? null : normalizeHistory(raw.history, now),
      },
    };
  };

  // ── Состояние Lab ──────────────────────────────────────────────

  const isExpired = (ep, now) => ep.state === 'ACTIVE' && ep.expiresAt !== null && ep.expiresAt <= now;

  /** Состояние для показа: ACTIVE с истёкшим сроком — EXPIRED (уже не считается свежим). */
  const displayState = (ep, now) => (isExpired(ep, now) ? 'EXPIRED' : ep.state);

  const isStale = (view, now) => {
    if (now - view.generatedAt > SNAPSHOT_STALE_MS) return true;
    const f = view.freshness;
    if (f && f.lastSuccessAt !== null && f.activeTtlSec !== null) return now - f.lastSuccessAt > f.activeTtlSec * 1000;
    return false;
  };

  /** Свежие ACTIVE: из списка, если он есть (сроки проверяются по часам браузера), иначе из счётчиков. */
  const freshActiveCount = (view, now) => {
    if (Array.isArray(view.endpoints) && view.endpoints.length) {
      return view.endpoints.filter((ep) => ep.state === 'ACTIVE' && !isExpired(ep, now)).length;
    }
    return view.counts ? view.counts.active : null;
  };

  /**
   * Общее состояние страницы. Приоритет: недоступен > устарел > пустой пул > деградация > работает.
   * «Lab недоступен» и «один endpoint DEAD» не смешиваются: второе — состояние строки списка.
   */
  const deriveLabState = (view, now) => {
    if (!view) return 'nodata';
    if (view.status === 'unavailable') return 'unavailable';
    if (isStale(view, now)) return 'stale';
    const active = freshActiveCount(view, now);
    if (active === 0) return 'empty';
    if (view.status === 'degraded') return 'degraded';
    return 'ok';
  };

  // ── Форматирование ─────────────────────────────────────────────

  /** Подставляет {name} из vars; неизвестные плейсхолдеры остаются как есть. */
  const interpolate = (template, vars) => String(template).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));

  const pluralCategory = (lang, n) => {
    try {
      return new Intl.PluralRules(lang === 'en' ? 'en' : 'ru').select(n);
    } catch {
      return n === 1 ? 'one' : 'other';
    }
  };

  /** Форма слова по числу: forms = { one, few, many, other }. */
  const plural = (lang, n, forms) => forms[pluralCategory(lang, n)] || forms.other || forms.many || '';

  const numberFormat = (lang, digits) => new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

  /** Доля 0..1 → «98%» / «99,4%»; null → «—». */
  const formatPercent = (fraction, lang, digits = 0) => {
    if (!isFraction(fraction)) return '—';
    const value = fraction * 100;
    // 99,96% не округляется до «100%», пока были неудачи: ровно 100% только при доле 1.
    const factor = 10 ** digits;
    const rounded = fraction < 1 ? Math.min(Math.round(value * factor) / factor, 100 - 1 / factor) : 100;
    return `${numberFormat(lang, digits).format(rounded)}%`;
  };

  const formatCount = (value, lang) => (Number.isInteger(value) ? numberFormat(lang, 0).format(value) : '—');

  /**
   * Возраст «… назад». t(key) — словарь страницы (lab_ago_*), чтобы язык менялся без перезагрузки.
   */
  const formatAgo = (ms, t) => {
    if (!Number.isFinite(ms)) return '—';
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 5) return t('lab_ago_now');
    if (s < 60) return interpolate(t('lab_ago_sec'), { n: s });
    const m = Math.floor(s / 60);
    if (m < 60) return interpolate(t('lab_ago_min'), { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? interpolate(t('lab_ago_hour_min'), { h, m: m % 60 }) : interpolate(t('lab_ago_hour'), { h });
    return interpolate(t('lab_ago_day'), { n: Math.floor(h / 24) });
  };

  /** Остаток срока «6 мин 42 сек»; ≤ 0 → «истёк». */
  const formatLeft = (ms, t) => {
    if (!Number.isFinite(ms)) return '—';
    if (ms <= 0) return t('lab_left_expired');
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return interpolate(t('lab_left_hour_min'), { h, m: m % 60 });
    if (m > 0) return interpolate(t('lab_left_min_sec'), { m, s: s % 60 });
    return interpolate(t('lab_left_sec'), { s });
  };

  /** Длительность окна актуальности: «7 мин», «24 ч». */
  const formatSpan = (sec, t) => {
    if (!Number.isInteger(sec) || sec <= 0) return '—';
    if (sec % 3600 === 0) return interpolate(t('lab_span_hour'), { n: sec / 3600 });
    if (sec >= 60 && sec % 60 === 0) return interpolate(t('lab_span_min'), { n: sec / 60 });
    if (sec >= 60) return interpolate(t('lab_span_min'), { n: Math.round(sec / 60) });
    return interpolate(t('lab_span_sec'), { n: sec });
  };

  const pad2 = (n) => String(n).padStart(2, '0');

  /** Время «18:24» по часам посетителя. */
  const formatClock = (ms) => {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  /** «Сегодня, 18:24» / «Вчера, 21:17» / «03.10, 09:05». */
  const formatDayTime = (ms, now, t) => {
    const d = new Date(ms);
    const today = new Date(now);
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const clock = formatClock(ms);
    if (ms >= startOfToday) return interpolate(t('lab_day_today'), { time: clock });
    if (ms >= startOfToday - 86400e3) return interpolate(t('lab_day_yesterday'), { time: clock });
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}, ${clock}`;
  };

  // ── Список endpoint'ов: фильтры и сортировка ──────────────────

  const filterEndpoints = (list, filters, now) => {
    const q = String(filters.query || '').trim().toLowerCase();
    return list.filter((ep) => {
      if (q && !ep.id.toLowerCase().includes(q)) return false;
      if (filters.state && filters.state !== 'all') {
        const shown = displayState(ep, now);
        if (shown !== filters.state && !(filters.state === 'ACTIVE' && shown === 'EXPIRED')) return false;
      }
      if (filters.port && filters.port !== 'all' && String(ep.port) !== String(filters.port)) return false;
      if (filters.source && filters.source !== 'all' && ep.source !== filters.source) return false;
      return true;
    });
  };

  const compareIp = (a, b) => {
    if (a.family !== b.family) return a.family - b.family;
    if (a.family === 4) {
      const pa = a.ip.split('.').map(Number);
      const pb = b.ip.split('.').map(Number);
      for (let i = 0; i < 4; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return a.port - b.port;
    }
    return a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : a.port - b.port;
  };

  /** Начальный порядок: по состоянию, затем по надёжности. Дальше он закрепляется за строками. */
  const defaultCompare = (a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state])
    || ((b.reliability ?? -1) - (a.reliability ?? -1)) || compareIp(a, b);

  /**
   * Порядок без выбранной сортировки — закреплённый: строки не прыгают при обновлении данных,
   * новые встают в конец. order — Map id → позиция, обновляется на месте.
   */
  const stableOrder = (list, order) => {
    const fresh = list.filter((ep) => !order.has(ep.id)).sort(defaultCompare);
    let next = order.size ? Math.max(...order.values()) + 1 : 0;
    for (const ep of fresh) {
      order.set(ep.id, next);
      next += 1;
    }
    return [...list].sort((a, b) => order.get(a.id) - order.get(b.id));
  };

  const SORT_KEYS = {
    endpoint: compareIp,
    checked: (a, b) => (a.lastVerifiedAt ?? -Infinity) - (b.lastVerifiedAt ?? -Infinity),
    reliability: (a, b) => (a.reliability ?? -1) - (b.reliability ?? -1),
    state: (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state],
  };

  const sortEndpoints = (list, sort, order) => {
    if (!sort || !SORT_KEYS[sort.key]) return stableOrder(list, order);
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => (SORT_KEYS[sort.key](a, b) * dir) || compareIp(a, b));
  };

  // ── Фикстуры: только локальная разработка ──────────────────────

  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

  const isLocalHost = (hostname) => {
    const host = String(hostname || '').toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
  };

  /** Имя фикстуры из ?fixture=… — только на localhost и только из известного списка. */
  const fixtureFromLocation = (search, hostname) => {
    if (!isLocalHost(hostname)) return null;
    let name = null;
    try {
      name = new URLSearchParams(search).get('fixture');
    } catch {
      return null;
    }
    return FIXTURE_NAMES.includes(name) ? name : null;
  };

  const api = {
    SCHEMA_VERSION,
    LAB_STATUSES,
    ENDPOINT_STATES,
    SOURCES,
    EVENT_TYPES,
    HISTORY_RANGES,
    CHART_RANGES,
    LIMITS,
    FIXTURE_NAMES,
    SNAPSHOT_STALE_MS,
    parseTime,
    cleanText,
    normalizeIp,
    parseEndpointId,
    normalizeState,
    normalizeOverview,
    normalizeEndpointDetails,
    isExpired,
    displayState,
    isStale,
    freshActiveCount,
    deriveLabState,
    interpolate,
    plural,
    formatPercent,
    formatCount,
    formatAgo,
    formatLeft,
    formatSpan,
    formatClock,
    formatDayTime,
    filterEndpoints,
    sortEndpoints,
    isLocalHost,
    fixtureFromLocation,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LabCore = Object.freeze(api);
})(typeof window !== 'undefined' ? window : globalThis);
