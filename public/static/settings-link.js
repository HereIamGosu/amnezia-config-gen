// public/static/settings-link.js
//
// Ссылка с настройками (?profile=…&routes=…): применение параметров адреса к cfgState после загрузки
// каталога и кнопка «Скопировать ссылку на настройки». Разбор и сборку ссылки делает share-link.js
// (window.ShareLink).
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → settings-link.js → history.js →
// script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t -- i18n.js */
/* global copyText, toast -- common.js */
/* global
   cfgState, ROUTE_MODES, getSelectedRouteIds, getSelectedDnsKey, forEachRouteTile, updateTileActiveClass,
   applyMobileModeCascade, endpointDefault, chooseEndpoint -- settings.js */
/* global getSelectedProfile -- script.js */
/* exported shareLink, applySharedSettings, copySettingsLink */

const shareLink = window.ShareLink || null;

/** Текущие настройки в виде, который понимает ShareLink.buildShareUrl. */
const getShareState = () => ({
  profile: getSelectedProfile(),
  routes: cfgState.routeMode === ROUTE_MODES.SPLIT ? getSelectedRouteIds() : [],
  dns: getSelectedDnsKey(),
  dnsDefault: cfgState.dnsDefault,
  device: shareLink ? shareLink.deviceOf(cfgState.mobileMode, cfgState.routerMode) : 'universal',
  ipv6: cfgState.includeIpv6,
  cps: cfgState.cpsProtocol,
  cps5: cfgState.extraCps,
  // Endpoint по умолчанию («авто»: Lab, когда он здоров) в ссылку не пишется — только явный выбор
  endpoint: endpointDefault.explicit ? cfgState.warpEndpoint : (shareLink ? shareLink.DEFAULTS.endpoint : 'lab'),
  port: cfgState.port,
  count: cfgState.configCount,
});

const setRadioValue = (name, value) => {
  const input = document.querySelector(`[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
  return Boolean(input);
};

/**
 * Применяет настройки из адреса страницы после загрузки каталога пресетов: каждое значение уже
 * проверено ShareLink.parseShareParams (неизвестные id, порты и т. п. отброшены). Маршруты в ссылке
 * означают выборочную маршрутизацию; мобильный профиль по-прежнему выключает IPv6 (I7).
 * Вызывающий код затем обновляет режим маршрутов, чипы и оценку CIDR.
 */
const applySharedSettings = () => {
  if (!shareLink || !window.location.search) return;
  const s = shareLink.parseShareParams(window.location.search, {
    routes: cfgState.presets.map((p) => p.id),
    dns: cfgState.dnsPresets.map((d) => d.id),
  });

  // Профиль из ссылки выставляет initProfileSelector() сразу при загрузке (не ждёт каталога),
  // чтобы карточка профиля не переключалась на глазах и не перебивала клик посетителя.

  if (s.routes) {
    const want = new Set(s.routes);
    forEachRouteTile((tile) => {
      const cb = tile.querySelector('input[type="checkbox"]');
      if (!cb) return;
      cb.checked = want.has(cb.value);
      updateTileActiveClass(tile);
    });
    cfgState.routeMode = ROUTE_MODES.SPLIT;
  }

  if (s.dns) {
    cfgState.selectedDns = s.dns;
    document.querySelectorAll('[name="dns-preset"]').forEach((radio) => {
      radio.checked = radio.value === s.dns;
      const tile = radio.closest('.cfg-tile');
      if (tile) updateTileActiveClass(tile);
    });
  }

  if (s.device) {
    const { mobile, router } = shareLink.flagsOfDevice(s.device);
    cfgState.mobileMode = mobile;
    cfgState.routerMode = router;
    const mobileToggle = document.getElementById('mobileModeToggle');
    if (mobileToggle) mobileToggle.checked = mobile;
    const routerToggle = document.getElementById('routerModeToggle');
    if (routerToggle) routerToggle.checked = router;
  }

  if (s.ipv6 !== undefined) {
    cfgState.includeIpv6 = s.ipv6;
    const ipv6Toggle = document.getElementById('ipv6Toggle');
    if (ipv6Toggle) ipv6Toggle.checked = s.ipv6;
  }
  applyMobileModeCascade();

  if (s.cps && setRadioValue('cpsProtocol', s.cps)) cfgState.cpsProtocol = s.cps;

  if (s.cps5 !== undefined) {
    cfgState.extraCps = s.cps5;
    const cps5Toggle = document.getElementById('cps5Toggle');
    if (cps5Toggle) cps5Toggle.checked = s.cps5;
  }

  if (s.endpoint) chooseEndpoint(s.endpoint);

  if (s.port) {
    cfgState.port = s.port;
    cfgState.warpPort = s.port;
    const select = document.getElementById('warpPortSelect');
    if (select) select.value = String(s.port);
  }

  if (s.count && setRadioValue('configCount', String(s.count))) cfgState.configCount = s.count;
};

/** «Скопировать ссылку на настройки»: только значения, отличные от умолчаний. */
const copySettingsLink = async () => {
  if (!shareLink) return;
  const url = shareLink.buildShareUrl(window.location.href, getShareState());
  const copied = await copyText(url);
  toast(copied
    ? t('settings_share_copied', 'Ссылка на настройки скопирована')
    : t('copy_failed', 'Не удалось скопировать.'), copied ? 'success' : 'info');
};
