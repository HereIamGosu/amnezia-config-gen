// e2e/lib/fixtures.js
// Ответы-заглушки для API: тесты никогда не регистрируют настоящее устройство WARP и не ходят
// во внешние сервисы. Форма ответа /api/warp повторяет api/warp.js; совместимость, метаданные AWG
// и vpn:// собираются теми же серверными функциями, что и в настоящем ответе.
'use strict';

const { getCompatibilityForGeneration } = require('../../src/server/clientCompatibility');
const { buildAwgMetadata } = require('../../src/server/awg/profiles');
const { buildVpnLink } = require('../../src/server/vpnLinkBuilder');

/** Узнаваемый «секрет»: тесты проверяют, что на экране его нет. */
const FAKE_PRIVATE_KEY = 'E2EsecretPrivateKeyMustStayMaskedOnScreen0A=';
const FAKE_PEER_KEY = 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=';

/** Конфиг в форме AWG 2.0 для WARP (I1–I5 инварианты: S=0, H=1..4, MTU 1280, I1 заглавной). */
const buildConf = ({ variant = 1, port = 4500, endpoint = 'engage.cloudflareclient.com' } = {}) => [
  '[Interface]',
  `PrivateKey = ${FAKE_PRIVATE_KEY}`,
  `Address = 172.16.0.${variant + 1}/32`,
  'DNS = 1.1.1.1, 1.0.0.1',
  'MTU = 1280',
  'Jc = 4',
  'Jmin = 40',
  'Jmax = 70',
  'S1 = 0',
  'S2 = 0',
  'S3 = 0',
  'S4 = 0',
  'H1 = 1',
  'H2 = 2',
  'H3 = 3',
  'H4 = 4',
  `I1 = <b 0xc${variant}00000001088a1b2c3d4e5f6a7b00000044d0>`,
  '',
  '[Peer]',
  `PublicKey = ${FAKE_PEER_KEY}`,
  'AllowedIPs = 0.0.0.0/0',
  `Endpoint = ${endpoint}:${port}`,
  'PersistentKeepalive = 25',
  '',
].join('\n');

/**
 * Успешный ответ /api/warp.
 * @param {{ mode?: string, count?: number, withLink?: boolean }} [options]
 */
const warpSuccess = ({ mode = 'awg2', count = 1, withLink = mode !== 'awg3' } = {}) => {
  const configs = Array.from({ length: count }, (_, idx) => {
    const text = buildConf({ variant: idx + 1 });
    return {
      index: idx + 1,
      content: Buffer.from(text).toString('base64'),
      appliedExtras: { cps5: false, mobile: false, router: false },
      endpointSource: 'hostname',
      cpsRequested: 'auto',
      cpsResolved: 'quic',
      cpsStability: 'stable',
      vpnLink: withLink
        ? buildVpnLink(text, { hostName: 'engage.cloudflareclient.com', dns1: '1.1.1.1', dns2: '1.0.0.1', mode })
        : undefined,
    };
  });
  const warnings = [];
  if (mode === 'awg3') {
    warnings.push('vpn:// is unavailable for AWG 3.0 because its historical protocol_version is not confirmed; use the .conf export.');
  }
  const hasLink = Boolean(configs[0].vpnLink);
  const compatibility = getCompatibilityForGeneration({
    mode, exportType: hasLink ? 'vpnlink' : 'conf', mobile: false, router: false, link: hasLink,
  });
  const awg = buildAwgMetadata(mode, { configText: Buffer.from(configs[0].content, 'base64').toString('utf8'), routerMode: false, vpnLinkAvailable: hasLink });
  return {
    success: true,
    content: configs[0].content,
    vpnLink: configs[0].vpnLink,
    appliedExtras: configs[0].appliedExtras,
    cpsRequested: 'auto',
    cpsResolved: 'quic',
    cpsStability: 'stable',
    configs,
    count: configs.length,
    mode,
    routeMode: 'full',
    routesSource: 'full',
    routesTelemetrySource: 'full',
    ...(awg ? { awg } : {}),
    ...(warnings.length ? { warning: warnings[0] } : {}),
    ...(compatibility ? { compatibility } : {}),
  };
};

/** Ответ /api/warp с ошибкой, как его отдаёт обработчик при сбое регистрации WARP. */
const warpError = (message = 'Cloudflare API временно недоступен (e2e).') => ({ success: false, message });

/** /api/healthcheck: все пробы успешны, время — «сейчас» (иначе снимок статуса считается устаревшим). */
const healthcheckOk = () => ({
  services: {
    api: { ok: true, latencyMs: 42 },
    engage: { ok: true, latencyMs: 37 },
    cidr: { ok: true, latencyMs: 55 },
  },
  checkedAt: new Date().toISOString(),
});

/** /api/iplist?presets=… — счётчик CIDR без обращения к iplist.opencck.org. */
const iplistCount = (url) => {
  const presets = (new URL(url).searchParams.get('presets') || '').split(',').filter(Boolean);
  const count4 = presets.length * 24;
  return {
    success: true,
    presets,
    sitesQueried: presets.length,
    sites: [],
    count: count4,
    count4,
    count6: 0,
    cidrs: [],
    cidrSource: 'static',
  };
};

module.exports = { FAKE_PRIVATE_KEY, buildConf, warpSuccess, warpError, healthcheckOk, iplistCount };
