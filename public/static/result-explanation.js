(function initResultExplanation(globalScope) {
  'use strict';

  const VALID_LEVELS = new Set(['info', 'warning', 'blocking']);
  const VALID_SOURCES = new Set(['api', 'ui', 'validation', 'unknown']);

  const normalizeLevel = (level) => {
    const value = String(level || '').toLowerCase();
    return VALID_LEVELS.has(value) ? value : 'warning';
  };

  const normalizeSource = (source) => {
    const value = String(source || '').toLowerCase();
    return VALID_SOURCES.has(value) ? value : 'unknown';
  };

  const warningMessage = (value) => {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value).trim();
    }
    if (!value || typeof value !== 'object') return '';
    const message = value.message ?? value.text ?? value.warning ?? value.error;
    return typeof message === 'string' || typeof message === 'number'
      ? String(message).trim()
      : '';
  };

  const normalizeWarnings = (input, defaultSource = 'api') => {
    const values = Array.isArray(input) ? input : input == null ? [] : [input];
    return values.flatMap((value) => {
      const message = warningMessage(value);
      if (!message) return [];
      if (typeof value !== 'object' || value == null) {
        return [{
          level: 'warning',
          message,
          source: normalizeSource(defaultSource),
        }];
      }
      const normalized = {
        level: normalizeLevel(value.level),
        message,
        source: normalizeSource(value.source || defaultSource),
      };
      if (value.code != null && String(value.code).trim()) {
        normalized.code = String(value.code).trim();
      }
      return [normalized];
    });
  };

  const getActualCount = (response) => {
    if (Array.isArray(response.configs)) return response.configs.length;
    if (response.content) return 1;
    return Number.isInteger(response.count) && response.count > 0 ? response.count : 0;
  };

  const getEndpoint = (response, state) => {
    const firstConfig = Array.isArray(response.configs) ? response.configs[0] : null;
    const rawSource = firstConfig?.endpointSource || response.endpointSource;
    const manual = state.warpEndpoint && state.warpEndpoint !== 'hostname';

    if (manual) return { mode: 'manual', source: 'manual' };
    if (rawSource === 'tcp_check') return { mode: 'auto', source: 'kv' };
    if (rawSource === 'fallback') return { mode: 'auto', source: 'fallback' };
    if (rawSource === 'kv') return { mode: 'auto', source: 'kv' };
    if (rawSource === 'hostname' || state.warpEndpoint === 'hostname') {
      return { mode: 'hostname', source: 'hostname' };
    }
    return { mode: 'unknown', source: 'unknown' };
  };

  const normalizeRoutesSource = (source, hasPresets) => {
    if (!hasPresets) return 'notApplicable';
    const value = String(source || '').toLowerCase();
    if (value === 'opencck') return 'opencck';
    if (value === 'itdoginfo' || value === 'community') return 'community';
    if (value === 'antifilter') return 'antifilter';
    if (value === 'static' || value === 'fallback' || value === 'mixed') return 'staticFallback';
    return 'unknown';
  };

  const getProfile = (state) => {
    if (state.mobileMode && state.routerMode) return 'mobileRouter';
    if (state.mobileMode) return 'mobile';
    if (state.routerMode) return 'router';
    if (typeof state.mobileMode === 'boolean' && typeof state.routerMode === 'boolean') return 'standard';
    return 'unknown';
  };

  const getIpv6 = (state) => {
    if (state.mobileMode) return 'disabledByMobile';
    if (state.includeIpv6 === true) return 'enabled';
    if (state.includeIpv6 === false) return 'disabled';
    return 'unknown';
  };

  const buildResultSummary = (response = {}, state = {}) => {
    const actualCount = getActualCount(response);
    const requestedCount = Number.isInteger(state.configCount) ? state.configCount : null;
    const presets = Array.isArray(response.routesPresets)
      ? response.routesPresets.filter((value) => typeof value === 'string')
      : Array.isArray(state.routePresets)
        ? state.routePresets.filter((value) => typeof value === 'string')
        : [];
    const warnings = normalizeWarnings(response.warning, 'api');

    if (requestedCount && actualCount > 0 && actualCount < requestedCount) {
      warnings.push({
        level: 'warning',
        code: 'partial_generation',
        message: `Generated ${actualCount} of ${requestedCount} requested variants.`,
        source: 'ui',
      });
    }

    if (actualCount === 0) {
      warnings.push({
        level: 'blocking',
        code: 'no_configs',
        message: 'Generation returned no configurations.',
        source: 'validation',
      });
    }

    const endpoint = getEndpoint(response, state);
    if (endpoint.source === 'fallback') {
      warnings.push({
        level: 'warning',
        code: 'endpoint_fallback',
        message: 'A fallback endpoint source was used.',
        source: 'ui',
      });
    } else if (endpoint.source === 'unknown') {
      warnings.push({
        level: 'info',
        code: 'endpoint_unknown',
        message: 'Endpoint source was not reported.',
        source: 'ui',
      });
    }

    if (state.ignoreLimit === true) {
      warnings.push({
        level: 'warning',
        code: 'allowed_ips_limit_disabled',
        message: 'The AllowedIPs limit is disabled.',
        source: 'ui',
      });
    }

    const routeMode = presets.length ? 'split' : 'full';
    const routesSource = normalizeRoutesSource(
      response.routesTelemetrySource || response.routesSource,
      presets.length > 0,
    );
    if (presets.length && routesSource === 'staticFallback') {
      warnings.push({
        level: 'warning',
        code: 'routes_fallback',
        message: 'A fallback route source was used.',
        source: 'ui',
      });
    } else if (presets.length && routesSource === 'unknown') {
      warnings.push({
        level: 'info',
        code: 'routes_unknown',
        message: 'Route source was not reported.',
        source: 'ui',
      });
    }

    return {
      format: response.mode === 'awg2' ? 'awg2' : response.mode === 'legacy' ? 'legacy' : 'unknown',
      variants: actualCount,
      endpoint,
      port: Number.isInteger(state.port) ? state.port : null,
      routesSource,
      routeMode,
      presets,
      profile: getProfile(state),
      ipv6: getIpv6(state),
      vpnImport: response.vpnLink
        || (Array.isArray(response.configs) && response.configs.some((config) => config?.vpnLink))
        ? 'available'
        : state.vpnLinkRequested === false
          ? 'notRequested'
          : 'unknown',
      warnings,
    };
  };

  const api = { buildResultSummary, normalizeWarnings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.ResultExplanation = api;
})(typeof window !== 'undefined' ? window : globalThis);
