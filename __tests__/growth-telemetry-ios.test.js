// Growth iteration 1 (2026-11): events that Metrika goals wait for actually reach Metrika, the counter
// runs only on the production host, and iPhone/iPad keep the result panel instead of an auto-download.
// Evidence and metrics: _private/docs/growth (outside the repo).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');

const { sanitizePayload, trackEvent } = require('../public/static/analytics');
const { readAppScript } = require('./helpers/frontend-scripts');

const script = readAppScript('script.js');
const result = readAppScript('result.js');
const common = readAppScript('common.js');
const settingsLink = readAppScript('settings-link.js');
const history = readAppScript('history.js');
const locales = {
  ru: require('../public/locales/ru.json'),
  en: require('../public/locales/en.json'),
};

const withYm = (fn) => {
  const calls = [];
  global.ym = (...args) => calls.push(args);
  try {
    fn();
  } finally {
    delete global.ym;
  }
  return calls;
};

describe('events behind Metrika goals are not dropped by the allowlist', () => {
  test('telegram_channel_cta_click, history_chains_used and settings_link_copied reach ym', () => {
    const calls = withYm(() => {
      assert.equal(trackEvent('telegram_channel_cta_click'), true);
      assert.equal(trackEvent('history_chains_used', { mode: 'awg2', chain_fields: 3 }), true);
      assert.equal(trackEvent('settings_link_copied', { chains_dropped: false }), true);
    });
    assert.deepEqual(calls, [
      [99328227, 'reachGoal', 'telegram_channel_cta_click', {}],
      [99328227, 'reachGoal', 'history_chains_used', { mode: 'awg2', chain_fields: 3 }],
      [99328227, 'reachGoal', 'settings_link_copied', { chains_dropped: false }],
    ]);
  });

  test('new payload keys stay bounded: integer and boolean only', () => {
    assert.deepEqual(sanitizePayload({ chain_fields: '5', chains_dropped: 'yes' }), {});
    assert.deepEqual(sanitizePayload({ chain_fields: 2.6, chains_dropped: true }), { chain_fields: 3, chains_dropped: true });
  });

  test('the Telegram buttons send the goal name through the adapter, not the renamed footer event', () => {
    assert.match(script, /telemetry\.trackEvent\('telegram_channel_cta_click'\)/);
    assert.doesNotMatch(script, /telegram_channel_footer_click/);
  });

  test('history and settings link call sites use the allowlisted names and keys', () => {
    assert.match(history, /trackEvent\('history_chains_used', \{ \.\.\.telemetryContext, chain_fields: chainFields\.length \}\)/);
    assert.match(settingsLink, /telemetry\.trackEvent\('settings_link_copied', \{ chains_dropped: chainsDropped \}\)/);
    // the event follows a successful copy only
    const fn = settingsLink.slice(settingsLink.indexOf('const copySettingsLink'));
    assert.ok(fn.indexOf('toast(t(\'copy_failed\'') < fn.indexOf('trackEvent(\'settings_link_copied\''));
  });
});

describe('Metrika runs only on the production host', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'static', 'metrika.js'), 'utf8');

  const load = (hostname) => {
    const inserted = [];
    const firstScript = { parentNode: { insertBefore: (el) => inserted.push(el.src) } };
    const window = { location: { hostname } };
    const document = {
      scripts: [],
      createElement: () => ({}),
      getElementsByTagName: () => [firstScript],
    };
    window.document = document;
    vm.runInNewContext(source, { window, document, Date });
    return { inserted, queue: window.ym.a };
  };

  test('awgconfig.com loads tag.js and queues init and infoLink', () => {
    const { inserted, queue } = load('awgconfig.com');
    assert.deepEqual(inserted, ['https://mc.yandex.ru/metrika/tag.js']);
    assert.equal(queue[0][1], 'init');
    assert.equal(queue[1][2], 'infoLink');
  });

  for (const host of ['localhost', '127.0.0.1', '', 'awgconfig-test.185-239-49-253.sslip.io', 'mirror.example.org']) {
    test(`${host || 'file://'} keeps the ym queue but never loads tag.js`, () => {
      const { inserted, queue } = load(host);
      assert.deepEqual(inserted, []);
      assert.equal(typeof queue, 'object', 'calls are queued, so analytics.js does not throw');
    });
  }
});

describe('iPhone and iPad: no auto-download, the result panel names the buttons', () => {
  const isAppleMobile = (userAgent, maxTouchPoints = 0) => {
    const start = script.indexOf('const isAppleMobile');
    const body = script.slice(start, script.indexOf('\n};', start) + 3);
    const window = { navigator: { userAgent, maxTouchPoints } };
    return vm.runInNewContext(`${body}\nisAppleMobile();`, { window });
  };

  test('detects iOS browsers and iPadOS desktop mode, not desktop or Android', () => {
    const iphoneSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    const iphoneChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';
    const ipadDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    assert.equal(isAppleMobile(iphoneSafari), true);
    assert.equal(isAppleMobile(iphoneChrome), true);
    assert.equal(isAppleMobile(ipadDesktop, 5), true);
    assert.equal(isAppleMobile(ipadDesktop, 0), false, 'a real Mac has no touch points');
    assert.equal(isAppleMobile(android, 5), false);
    assert.equal(isAppleMobile(windows), false);
  });

  test('the detector lives next to its only caller, so a cached old common.js cannot break generation', () => {
    assert.match(script, /const isAppleMobile = \(\) =>/);
    assert.doesNotMatch(common, /isAppleMobile/);
  });

  test('generation downloads automatically and counts config_downloaded only outside iOS', () => {
    assert.match(script, /const autoDownload = !isAppleMobile\(\);/);
    assert.match(script, /autoDownloaded: autoDownload \? variants\[0\]\.filename : null,\s*manualDownload: !autoDownload,/);
    assert.match(script, /if \(autoDownload\) \{\s*downloadFile\(variants\[0\]\.decodedConfig, variants\[0\]\.filename\);\s*telemetry\.trackEvent\('config_downloaded', completedContext\);\s*\}/);
    // generation_succeeded is sent before any download, on every platform
    assert.ok(script.indexOf('\'generation_succeeded\'') < script.indexOf('const autoDownload'));
  });

  test('the note shows for both paths, with a translated text on iOS', () => {
    assert.match(result, /autoNote\.hidden = !currentResult\.autoDownloaded && !currentResult\.manualDownload/);
    assert.match(result, /setI18nText\(autoNote, 'result_manual_download_note'/);
    for (const lang of ['ru', 'en']) {
      const note = locales[lang].result_manual_download_note;
      assert.ok(note, `${lang}: result_manual_download_note`);
      assert.ok(note.includes(locales[lang].result_download), `${lang}: names the download button`);
      assert.ok(note.includes(locales[lang].result_copy_link), `${lang}: names the vpn:// button`);
      const confOnly = locales[lang].result_manual_download_note_conf;
      assert.ok(confOnly.includes(locales[lang].result_download), `${lang}: conf-only note names the download button`);
      assert.ok(!confOnly.includes('vpn://'), `${lang}: conf-only note does not offer the disabled vpn:// button`);
    }
  });

  test('without vpn:// (AWG 3.0) the iOS note names only the download', () => {
    assert.match(result, /manualDownload && variant && variant\.vpnLink\) \{\s*setI18nText\(autoNote, 'result_manual_download_note',/);
    assert.match(result, /setI18nText\(autoNote, 'result_manual_download_note_conf',/);
  });
});
