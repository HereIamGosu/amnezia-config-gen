// e2e/lib/harness.js
// Обвязка для e2e-тестов на node:test: вкладка в отдельном контексте браузера (чистые localStorage и
// cookies), заглушки API через Fetch.requestPaused, сбор ошибок консоли, нарушений CSP, внешних
// запросов и сдвигов макета. Браузер и сервер поднимает e2e/run.js и передаёт их через окружение.
'use strict';

const assert = require('node:assert/strict');
const { before, after, describe } = require('node:test');
const { connect } = require('./cdp');
const fixtures = require('./fixtures');

const BASE_URL = process.env.E2E_BASE_URL || '';
const BROWSER_WS = process.env.E2E_BROWSER_WS || '';
const SKIP_REASON = BASE_URL && BROWSER_WS ? false : 'run through `npm run test:e2e` (starts server.js and headless Chrome)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Выполняется в каждой странице до её скриптов. CDP-вставка не подчиняется CSP страницы.
const INSTRUMENTATION = `(() => {
  const state = { csp: [], shifts: [], clipboard: [] };
  Object.defineProperty(window, '__e2e', { value: state });
  document.addEventListener('securitypolicyviolation', (e) => {
    state.csp.push(e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline') + ' at ' + (e.sourceFile || '') + ':' + e.lineNumber);
  });
  const describeNode = (node) => {
    if (!node || node.nodeType !== 1) return node ? node.nodeName : 'unknown';
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') +
      (node.classList.length ? '.' + Array.from(node.classList).slice(0, 2).join('.') : '');
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.shifts.push({
          value: entry.value,
          hadRecentInput: entry.hadRecentInput,
          time: entry.startTime,
          sources: (entry.sources || []).map((s) => describeNode(s.node)),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { /* layout-shift не поддерживается */ }
  // Буфер обмена: тесты читают, что скопировала страница, без разрешений браузера.
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText = (text) => { state.clipboard.push(String(text)); return Promise.resolve(); };
    }
  } catch (e) { /* без clipboard страница использует execCommand */ }
})();`;

const isMetrika = (url) => /^https:\/\/mc\.yandex\.(ru|com|by|kz|uz|com\.tr)\//.test(url);

let connection = null;

/**
 * Регистрирует набор e2e-тестов: без браузера (прямой запуск файла) — пропуск с понятной причиной.
 * Колбэк получает openPage(options) для открытия новой вкладки.
 */
const e2eSuite = (name, fn) => describe(name, { skip: SKIP_REASON }, () => {
  const pages = [];
  before(async () => {
    if (!connection) connection = await connect(BROWSER_WS);
  });
  after(async () => {
    await Promise.all(pages.map((page) => page.close().catch(() => {})));
    if (connection) {
      connection.close();
      connection = null;
    }
  });
  fn(async (options) => {
    const page = await createPage(connection, options);
    pages.push(page);
    return page;
  });
});

/**
 * @param {object} conn — соединение CDP с браузером
 * @param {{ width?: number, height?: number, mobile?: boolean }} [options]
 */
const createPage = async (conn, { width = 1280, height = 900, mobile = false } = {}) => {
  const { browserContextId } = await conn.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => conn.send(method, params, sessionId);

  const errors = [];
  const csp = [];
  const external = [];
  const navigations = [];
  const allowed = [];
  const routes = [];
  const apiCalls = [];
  const inflight = new Set();
  let lastNetworkActivity = Date.now();
  let loadResolvers = [];
  let mainFrameId = null;

  const record = (text) => {
    if (allowed.some((re) => re.test(text))) return;
    errors.push(text);
  };

  const fulfill = async (requestId, { status = 200, json, body = '', contentType, headers = {}, delayMs = 0 }) => {
    if (delayMs) await sleep(delayMs);
    const payload = json !== undefined ? JSON.stringify(json) : body;
    const type = contentType || (json !== undefined ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    const responseHeaders = [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }]
      .concat(Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })));
    await send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders,
      body: Buffer.from(payload, 'utf8').toString('base64'),
    });
  };

  // Маршруты по умолчанию: всё, что ушло бы наружу (WARP, пробы healthcheck, iplist.opencck.org).
  const defaultRoutes = [
    { match: (u) => u.pathname === '/api/healthcheck', handle: () => ({ json: fixtures.healthcheckOk() }) },
    { match: (u) => u.pathname === '/api/iplist' && u.searchParams.has('presets'), handle: (u) => ({ json: fixtures.iplistCount(u.href) }) },
    // Тест, который генерирует конфиг, обязан задать свою заглушку; иначе — явная ошибка в отчёте.
    { match: (u) => u.pathname === '/api/warp', handle: () => {
      errors.push('unexpected /api/warp call without a stub in the test');
      return { status: 503, json: fixtures.warpError('e2e: /api/warp is not stubbed') };
    } },
  ];

  const onEvent = async (msg) => {
    if (msg.sessionId !== sessionId) return;
    const { method, params } = msg;
    try {
      switch (method) {
        case 'Fetch.requestPaused': {
          const { requestId, request } = params;
          const url = request.url;
          if (url.startsWith(BASE_URL)) {
            const parsed = new URL(url);
            if (parsed.pathname.startsWith('/api/')) apiCalls.push({ method: request.method, url });
            const route = routes.find((r) => r.match(parsed, request)) || defaultRoutes.find((r) => r.match(parsed, request));
            if (route) {
              await fulfill(requestId, await route.handle(parsed, request));
            } else {
              await send('Fetch.continueRequest', { requestId });
            }
          } else if (isMetrika(url)) {
            // Метрика: настоящий tag.js не грузим и хиты не отправляем — пустой ответ.
            await fulfill(requestId, { body: '', contentType: /\.js(\?|$)/.test(url) ? 'application/javascript' : 'image/gif' });
          } else {
            external.push(url);
            await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
          }
          break;
        }
        case 'Network.requestWillBeSent':
          inflight.add(params.requestId);
          lastNetworkActivity = Date.now();
          break;
        case 'Network.loadingFinished':
        case 'Network.loadingFailed':
          inflight.delete(params.requestId);
          lastNetworkActivity = Date.now();
          break;
        case 'Runtime.consoleAPICalled':
          if (params.type === 'error' || params.type === 'assert') {
            record(`console.${params.type}: ${params.args.map((a) => (a.value !== undefined ? a.value : a.description)).join(' ')}`);
          }
          break;
        case 'Runtime.exceptionThrown': {
          const d = params.exceptionDetails;
          record(`exception: ${(d.exception && d.exception.description) || d.text} (${d.url || ''}:${d.lineNumber})`);
          break;
        }
        case 'Log.entryAdded': {
          const { entry } = params;
          const text = `log.${entry.source}: ${entry.text} ${entry.url || ''}`.trim();
          if (/Content Security Policy/i.test(entry.text)) csp.push(text);
          else if (entry.level === 'error') record(text);
          break;
        }
        case 'Page.frameNavigated':
          if (!params.frame.parentId) {
            mainFrameId = params.frame.id;
            navigations.push(params.frame.url);
          }
          break;
        case 'Page.navigatedWithinDocument':
          break;
        case 'Page.loadEventFired':
          loadResolvers.forEach((resolve) => resolve());
          loadResolvers = [];
          break;
        default:
          break;
      }
    } catch (err) {
      // Вкладку закрыли посреди обработки — не ошибка теста.
      if (!/connection closed|No target|Session/i.test(String(err && err.message))) errors.push(`harness: ${err.message}`);
    }
  };
  conn.on(onEvent);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await conn.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId });

  const evaluate = async (fn, ...args) => {
    const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`evaluate failed: ${(d.exception && d.exception.description) || d.text}`);
    }
    return res.result.value;
  };

  /** Ждёт, пока fn() в странице вернёт truthy; возвращает это значение. */
  const waitFor = async (fn, { args = [], timeout = 8000, message = '' } = {}) => {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        last = await evaluate(fn, ...args);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      if (Date.now() > deadline) {
        throw new Error(`waitFor timed out after ${timeout} ms: ${message || String(fn).slice(0, 160)} (last: ${JSON.stringify(last)})`);
      }
      await sleep(50);
    }
  };

  const waitForNetworkIdle = async ({ idleMs = 300, timeout = 10_000 } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (inflight.size === 0 && Date.now() - lastNetworkActivity >= idleMs) return;
      await sleep(50);
    }
    throw new Error(`network did not become idle in ${timeout} ms (${inflight.size} requests in flight)`);
  };

  /**
   * Открывает адрес сайта и ждёт готовности приложения: загружены словарь, каталог маршрутов,
   * сеть затихла. app: false — только событие load (страница статуса, 404).
   */
  const goto = async (path, { app = true } = {}) => {
    const loaded = new Promise((resolve) => loadResolvers.push(resolve));
    const res = await send('Page.navigate', { url: new URL(path, BASE_URL).href });
    if (res.errorText) throw new Error(`navigation to ${path} failed: ${res.errorText}`);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`load event timeout for ${path}`)), 15_000);
    });
    try {
      await Promise.race([loaded, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (app) {
      await waitFor(() => document.querySelectorAll('#routeTilesSocial input').length > 0
        && document.getElementById('chipDns').hasAttribute('title'), { timeout: 10_000, message: 'app ready (catalogue + chips)' });
    }
    await waitForNetworkIdle();
  };

  /** Центр видимого элемента после прокрутки к нему; проверяет, что клик не перекрыт другим слоем. */
  const pointOf = (selector) => evaluate((sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null;
    if (!el) return { error: `no element ${sel}` };
    // Как пользователь: прокручиваем, только если элемента не видно целиком (липкая шапка — видна всегда)
    // и не перекрыт (например, низ прокручиваемого тела окна под его футером)
    const hits = (rect) => {
      const h = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return h && (el === h || el.contains(h));
    };
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth || !hits(r)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = el.getBoundingClientRect();
    }
    if (!r.width || !r.height) return { error: `element ${sel} is not visible` };
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(el === hit || el.contains(hit))) {
      const name = hit ? hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : '') + (hit.className && typeof hit.className === 'string' ? `.${hit.className.split(' ')[0]}` : '') : 'nothing';
      return { error: `element ${sel} is covered by ${name}` };
    }
    return { x, y };
  }, selector);

  /** Настоящий клик мышью (isTrusted, учитывается как ввод для layout-shift). */
  const click = async (selector) => {
    const point = await pointOf(selector);
    if (point.error) throw new Error(`click: ${point.error}`);
    const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  };

  /** Касание в точке окна (например, «мимо» открытого меню); браузер сам превращает его в click. */
  const tapAt = async (x, y) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  /** Касание пальцем (мобильная эмуляция). */
  const tap = async (selector) => {
    const point = await pointOf(selector);
    if (point.error) throw new Error(`tap: ${point.error}`);
    await tapAt(point.x, point.y);
  };

  const KEYS = {
    Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
    Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  };
  const press = async (key) => {
    const info = KEYS[key] || { code: key };
    await send('Input.dispatchKeyEvent', { type: info.text ? 'keyDown' : 'rawKeyDown', key, ...info });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: info.code, windowsVirtualKeyCode: info.windowsVirtualKeyCode });
  };

  const page = {
    send,
    evaluate,
    waitFor,
    waitForNetworkIdle,
    goto,
    click,
    tap,
    tapAt,
    press,
    sleep,
    baseUrl: BASE_URL,
    errors,
    csp,
    external,
    navigations,
    apiCalls,
    get mainFrameId() { return mainFrameId; },
    /** Своя заглушка: match(URL, request) → handle(URL, request) возвращает { status, json | body, delayMs }. */
    route(match, handle) {
      routes.unshift({ match, handle });
    },
    /** Ожидаемые ошибки (например, console.error при сценарии сбоя генерации). */
    allowErrors(...patterns) {
      allowed.push(...patterns);
    },
    async layoutShifts() {
      return evaluate(() => window.__e2e.shifts.slice());
    },
    async clipboard() {
      return evaluate(() => window.__e2e.clipboard.slice());
    },
    async viewport(w, h, isMobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: isMobile });
    },
    /** Ошибки консоли, исключения, нарушения CSP и запросы наружу — всё должно быть пусто. */
    async assertClean(label = '') {
      let pageCsp = [];
      try {
        pageCsp = await evaluate(() => (window.__e2e ? window.__e2e.csp.slice() : []));
      } catch { /* страница закрыта */ }
      const where = label ? ` (${label})` : '';
      assert.deepEqual(errors, [], `console errors / exceptions${where}`);
      assert.deepEqual([...csp, ...pageCsp], [], `CSP violations${where}`);
      assert.deepEqual(external, [], `requests outside the site${where}`);
    },
    async close() {
      conn.off(onEvent);
      try {
        await conn.send('Target.closeTarget', { targetId });
        await conn.send('Target.disposeBrowserContext', { browserContextId });
      } catch { /* браузер уже закрыт */ }
    },
  };
  return page;
};

module.exports = { e2eSuite, fixtures, sleep, BASE_URL };
