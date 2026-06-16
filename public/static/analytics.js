(function initProductTelemetry(root, factory) {
  const telemetry = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = telemetry;
  if (root) root.ProductTelemetry = telemetry;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  'use strict';

  const YANDEX_COUNTER_ID = 99328227;

  const EVENT_NAMES = new Set([
    'generation_started',
    'generation_succeeded',
    'generation_partially_succeeded',
    'generation_failed',
    'config_downloaded',
    'config_preview_opened',
    'vpn_link_copied',
    'history_item_previewed',
    'history_item_downloaded',
    'healthcheck_opened',
    'status_modal_opened',
  ]);

  const ENUMS = {
    mode: new Set(['legacy', 'awg2']),
    endpoint_mode: new Set(['hostname', 'ip', 'auto']),
    endpoint_source: new Set(['kv', 'fallback', 'hostname', 'manual', 'unknown']),
    routes_source: new Set(['opencck', 'itdoginfo', 'antifilter', 'static', 'fallback', 'unknown']),
    route_mode: new Set(['full', 'split', 'unknown']),
    cps_mode: new Set(['auto', 'quic', 'dns', 'stun', 'tls', 'sip', 'static', 'unknown']),
    error_code: new Set(['timeout', 'http', 'network', 'invalid_response', 'unknown']),
  };

  const INTEGER_KEYS = new Set([
    'count_requested',
    'count_produced',
    'warning_count',
    'duration_ms',
  ]);
  const BOOLEAN_KEYS = new Set(['has_warning', 'mobile_profile', 'router_profile']);

  const sanitizePayload = (payload = {}) => {
    const safe = {};
    for (const [key, allowed] of Object.entries(ENUMS)) {
      if (allowed.has(payload[key])) safe[key] = payload[key];
    }
    for (const key of INTEGER_KEYS) {
      const value = payload[key];
      if (Number.isFinite(value) && value >= 0) safe[key] = Math.round(value);
    }
    for (const key of BOOLEAN_KEYS) {
      if (typeof payload[key] === 'boolean') safe[key] = payload[key];
    }
    return safe;
  };

  const durationMs = (startedAt, finishedAt) => {
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return 0;
    return Math.max(0, Math.round(finishedAt - startedAt));
  };

  const classifyGenerationError = (error, httpStatus) => {
    if (error && error.name === 'AbortError') return 'timeout';
    if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) return 'http';
    if (error instanceof SyntaxError) return 'invalid_response';
    if (error && (error.name === 'TypeError' || error.code === 'ECONNRESET')) return 'network';
    return 'unknown';
  };

  const trackEvent = (eventName, payload = {}) => {
    if (!EVENT_NAMES.has(eventName)) return false;
    const safePayload = sanitizePayload(payload);
    try {
      if (root && typeof root.ym === 'function') {
        root.ym(YANDEX_COUNTER_ID, 'reachGoal', eventName, safePayload);
        return true;
      }
    } catch {
      // Product actions must not depend on analytics availability.
    }
    return false;
  };

  return {
    classifyGenerationError,
    durationMs,
    sanitizePayload,
    trackEvent,
  };
}));
