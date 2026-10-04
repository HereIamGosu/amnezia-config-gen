/**
 * Ссылка с настройками генератора: ?profile=awg3&routes=youtube,discord&dns=adguard&port=2408 …
 *
 * Чистые функции без DOM: разбор и проверка параметров адреса и сборка канонической ссылки,
 * в которой остаются только значения, отличные от умолчаний. Каждое значение сверяется с
 * допустимым набором; неизвестное или некорректное значение просто игнорируется.
 * Каталог маршрутов и DNS приходит из /api/iplist, поэтому их допустимые id передаются снаружи.
 * В браузере доступно как window.ShareLink, в Node — через require (тесты).
 */
(function initShareLink(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ShareLink = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const PROFILES = Object.freeze(['legacy', 'awg2', 'awg3', 'awg31']);
  const DEVICES = Object.freeze(['universal', 'mobile', 'router', 'mobile-router']);
  const CPS_PROTOCOLS = Object.freeze(['auto', 'quic', 'dns', 'stun', 'dtls', 'sip', 'static']);
  /** Совпадает с PORT_ALLOWLIST в api/warp.js и списком #warpPortSelect (проверяет тест). */
  const PORTS = Object.freeze([4500, 2408, 500, 1701, 880, 8854]);
  /** Варианты #warpEndpointSelect: hostname (автовыбор) или один из IP WARP. */
  const ENDPOINTS = Object.freeze(['hostname', '162.159.192.1', '162.159.195.1', '188.114.97.1', '188.114.99.1']);
  const COUNTS = Object.freeze([1, 2, 3]);

  const DEFAULTS = Object.freeze({
    profile: 'awg2',
    device: 'universal',
    cps: 'auto',
    cps5: false,
    port: 4500,
    endpoint: 'hostname',
    ipv6: false,
    count: 1,
  });

  /** Порядок параметров в канонической ссылке. */
  const PARAM_ORDER = Object.freeze(['profile', 'routes', 'dns', 'device', 'ipv6', 'cps', 'cps5', 'endpoint', 'port', 'count']);

  const MAX_ROUTES = 64;

  const isMobileDevice = (device) => device === 'mobile' || device === 'mobile-router';

  const deviceOf = (mobile, router) => {
    if (mobile && router) return 'mobile-router';
    if (mobile) return 'mobile';
    if (router) return 'router';
    return 'universal';
  };

  const flagsOfDevice = (device) => ({
    mobile: isMobileDevice(device),
    router: device === 'router' || device === 'mobile-router',
  });

  const toParams = (search) => {
    if (search && typeof search === 'object' && typeof search.get === 'function') return search;
    return new URLSearchParams(typeof search === 'string' ? search : '');
  };

  const firstValue = (params, name) => {
    const value = params.get(name);
    return typeof value === 'string' ? value.trim() : null;
  };

  const parseFlag = (value) => {
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    return undefined;
  };

  const parseIntStrict = (value) => (value !== null && /^\d{1,5}$/.test(value) ? Number(value) : NaN);

  /**
   * Разбирает параметры адреса. Возвращает только распознанные и допустимые поля.
   * @param {string | URLSearchParams} search — location.search (с «?» или без)
   * @param {{ routes?: string[], dns?: string[] }} [catalogue] — допустимые id из каталога пресетов
   * @returns {{ profile?: string, routes?: string[], dns?: string, device?: string, ipv6?: boolean,
   *   cps?: string, cps5?: boolean, endpoint?: string, port?: number, count?: number }}
   */
  const parseShareParams = (search, catalogue = {}) => {
    const params = toParams(search);
    const allowedRoutes = new Set(Array.isArray(catalogue.routes) ? catalogue.routes : []);
    const allowedDns = new Set(Array.isArray(catalogue.dns) ? catalogue.dns : []);
    const out = {};

    const profile = firstValue(params, 'profile');
    if (PROFILES.includes(profile)) out.profile = profile;

    const routesRaw = firstValue(params, 'routes');
    if (routesRaw) {
      const routes = [];
      for (const id of routesRaw.split(',').map((part) => part.trim())) {
        if (id && allowedRoutes.has(id) && !routes.includes(id)) routes.push(id);
        if (routes.length >= MAX_ROUTES) break;
      }
      if (routes.length > 0) out.routes = routes;
    }

    const dns = firstValue(params, 'dns');
    if (dns && allowedDns.has(dns)) out.dns = dns;

    const device = firstValue(params, 'device');
    if (DEVICES.includes(device)) out.device = device;

    const ipv6 = parseFlag(firstValue(params, 'ipv6'));
    // Мобильный профиль всегда без IPv6 (инвариант I7): ipv6=1 рядом с mobile игнорируется.
    if (ipv6 !== undefined && !isMobileDevice(out.device)) out.ipv6 = ipv6;

    const cps = firstValue(params, 'cps');
    if (CPS_PROTOCOLS.includes(cps)) out.cps = cps;

    const cps5 = parseFlag(firstValue(params, 'cps5'));
    if (cps5 !== undefined) out.cps5 = cps5;

    const endpoint = firstValue(params, 'endpoint');
    if (ENDPOINTS.includes(endpoint)) out.endpoint = endpoint;

    const port = parseIntStrict(firstValue(params, 'port'));
    if (PORTS.includes(port)) out.port = port;

    const count = parseIntStrict(firstValue(params, 'count'));
    if (COUNTS.includes(count)) out.count = count;

    return out;
  };

  /**
   * Собирает query-строку (без «?») только из значений, отличных от умолчаний.
   * @param {{ profile: string, routes?: string[], dns?: string, dnsDefault?: string, device: string,
   *   ipv6: boolean, cps: string, cps5: boolean, endpoint: string, port: number, count: number }} state
   */
  const buildShareQuery = (state) => {
    const values = {};
    if (PROFILES.includes(state.profile) && state.profile !== DEFAULTS.profile) values.profile = state.profile;
    const routes = Array.isArray(state.routes) ? [...new Set(state.routes.filter(Boolean))] : [];
    if (routes.length > 0) values.routes = routes.map(encodeURIComponent).join(',');
    if (state.dns && state.dns !== state.dnsDefault) values.dns = encodeURIComponent(state.dns);
    if (DEVICES.includes(state.device) && state.device !== DEFAULTS.device) values.device = state.device;
    if (state.ipv6 === true && !isMobileDevice(state.device)) values.ipv6 = '1';
    if (CPS_PROTOCOLS.includes(state.cps) && state.cps !== DEFAULTS.cps) values.cps = state.cps;
    if (state.cps5 === true) values.cps5 = '1';
    if (ENDPOINTS.includes(state.endpoint) && state.endpoint !== DEFAULTS.endpoint) values.endpoint = state.endpoint;
    if (PORTS.includes(state.port) && state.port !== DEFAULTS.port) values.port = String(state.port);
    if (COUNTS.includes(state.count) && state.count !== DEFAULTS.count) values.count = String(state.count);
    return PARAM_ORDER.filter((name) => values[name] !== undefined).map((name) => `${name}=${values[name]}`).join('&');
  };

  /** Полная ссылка: адрес страницы без старых параметров и якоря + канонический query. */
  const buildShareUrl = (pageUrl, state) => {
    const url = new URL(pageUrl);
    const query = buildShareQuery(state);
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  };

  return Object.freeze({
    PROFILES,
    DEVICES,
    CPS_PROTOCOLS,
    PORTS,
    ENDPOINTS,
    COUNTS,
    DEFAULTS,
    PARAM_NAMES: PARAM_ORDER,
    buildShareQuery,
    buildShareUrl,
    deviceOf,
    flagsOfDevice,
    isMobileDevice,
    parseShareParams,
  });
}));
