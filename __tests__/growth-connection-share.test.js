// Growth iteration 2 (2026-11): «Подключилось?» after the result (ACT-2) and «Поделиться» after «Да» (REF-1).
// Real activation was not measured at all; these events measure it without collecting anything personal.
// Evidence and metrics: _private/docs/growth (outside the repo). Browser behaviour: e2e/generate.e2e.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');

const { sanitizePayload, trackEvent } = require('../public/static/analytics');
const { readAppScript } = require('./helpers/frontend-scripts');

const feedback = readAppScript('result-feedback.js');
const result = readAppScript('result.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
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

/** Top-level helpers of result-feedback.js in a sandbox (the file calls nothing at load time). */
const runFeedback = (expression, context) => vm.runInNewContext(`${feedback}\n;${expression}`, {
  window: {},
  navigator: {},
  document: { getElementById: () => null, querySelector: () => null, addEventListener: () => {} },
  t: (key, fallback) => fallback,
  ...context,
});

describe('adapter: connection and share events', () => {
  test('connection_works / connection_fails carry the anonymous generation context', () => {
    const context = {
      mode: 'awg2',
      endpoint_mode: 'lab',
      endpoint_source: 'lab',
      cps_mode: 'auto',
      cps_requested: 'auto',
      cps_resolved: 'quic',
      cps_stability: 'stable',
      mobile_profile: true,
      router_profile: false,
    };
    const calls = withYm(() => {
      assert.equal(trackEvent('connection_works', context), true);
      assert.equal(trackEvent('connection_fails', context), true);
    });
    assert.deepEqual(calls, [
      [99328227, 'reachGoal', 'connection_works', context],
      [99328227, 'reachGoal', 'connection_fails', context],
    ]);
  });

  test('connection_next_step and share_clicked accept only their bounded values', () => {
    for (const step of ['endpoint', 'profile', 'faq', 'telegram']) {
      assert.deepEqual(sanitizePayload({ next_step: step }), { next_step: step });
    }
    for (const channel of ['telegram', 'copy', 'native']) {
      assert.deepEqual(sanitizePayload({ share_channel: channel }), { share_channel: channel });
    }
    assert.deepEqual(sanitizePayload({ next_step: 'regenerate', share_channel: 'email' }), {});
    assert.deepEqual(sanitizePayload({ next_step: 'FAQ', share_channel: ' telegram' }), {});
    const calls = withYm(() => {
      trackEvent('connection_next_step', { mode: 'awg31', next_step: 'profile' });
      trackEvent('share_clicked', { share_channel: 'copy' });
    });
    assert.deepEqual(calls, [
      [99328227, 'reachGoal', 'connection_next_step', { mode: 'awg31', next_step: 'profile' }],
      [99328227, 'reachGoal', 'share_clicked', { share_channel: 'copy' }],
    ]);
  });

  test('keys, addresses, presets and free text never pass the adapter', () => {
    const leaked = sanitizePayload({
      next_step: 'faq',
      comment: 'не работает в МТС',
      config: '[Interface]\nPrivateKey = x',
      vpn_link: 'vpn://AAAA',
      endpoint: '162.159.192.1:4500',
      presets: 'youtube,discord',
      url: 'https://awgconfig.com/?utm_source=share',
    });
    assert.deepEqual(leaked, { next_step: 'faq' });
  });

  test('an unknown event name is dropped', () => {
    const calls = withYm(() => assert.equal(trackEvent('connection_feedback_text', { next_step: 'faq' }), false));
    assert.deepEqual(calls, []);
  });
});

describe('call sites in result.js and result-feedback.js', () => {
  test('the question waits for an action with the result: download, vpn:// copy, code copy, preview', () => {
    const init = result.slice(result.indexOf('const initResultPanel'));
    assert.match(init, /trackEvent\('config_downloaded', currentResult\.telemetryContext\);\s*afterResultAction\(\);/);
    assert.match(init, /trackEvent\('vpn_link_copied', currentResult\.telemetryContext\);[\s\S]{0,140}afterResultAction\(\);/);
    assert.match(init, /if \(copied\) afterResultAction\(\);/);
    assert.match(init, /trackEvent\('config_preview_opened', currentResult\.telemetryContext\);\s*afterResultAction\(\);/);
    // not right after the generation: showResult resets the answer and does not ask
    const show = result.slice(result.indexOf('const showResult ='), result.indexOf('const initResultPanel'));
    assert.match(show, /connection: 'idle'/);
    assert.doesNotMatch(show, /noteResultAction|afterResultAction/);
  });

  test('result.js reaches result-feedback.js only behind typeof: the result shows even without that file', () => {
    const code = result.replace(/^\/\*[\s\S]*?\*\//gm, '').replace(/\/\/.*$/gm, '');
    const calls = [...code.matchAll(/\b(noteResultAction|renderConnectionCheck|initConnectionCheck)\(\)/g)];
    assert.equal(calls.length, 3, calls.map((c) => c[0]).join(' '));
    for (const call of calls) {
      const before = code.slice(Math.max(0, call.index - 60), call.index);
      assert.match(before, new RegExp(`typeof ${call[1]} === 'function'\\)\\s*$`), `${call[1]} is guarded`);
    }
  });

  test('an auto-downloaded file asks only after the tab was hidden and became visible again', () => {
    assert.match(feedback, /addEventListener\('visibilitychange'/);
    assert.match(feedback, /!currentResult\.autoDownloaded/);
    assert.match(feedback, /document\.visibilityState === 'hidden'\) \{\s*hiddenWith = currentResult;/);
  });

  test('one answer per generation: the answer handler runs only from the ask stage', () => {
    const answer = feedback.slice(feedback.indexOf('const answerConnection'), feedback.indexOf('const initConnectionCheck'));
    assert.match(answer, /if \(connectionStage\(\) !== 'ask'\) return;/);
    assert.ok(answer.indexOf('!== \'ask\') return') < answer.indexOf('trackEvent('), 'guard before the event');
    assert.match(answer, /trackEvent\(works \? 'connection_works' : 'connection_fails', connectionContext\(\)\)/);
  });

  test('«Нет» steps never start a generation or call /api/warp themselves', () => {
    assert.doesNotMatch(feedback, /generateConfig|\/api\/warp|fetch\(/);
    assert.doesNotMatch(feedback, /generateButton'\)\??\.click\(/);
  });

  test('share uses only the home page link: no config text, no vpn:// link', () => {
    assert.doesNotMatch(feedback, /vpnLink|decodedConfig|variants/);
    assert.match(feedback, /telemetry\.trackEvent\('share_clicked', \{ share_channel: 'telegram' \}\)/);
    assert.match(feedback, /telemetry\.trackEvent\('share_clicked', \{ share_channel: 'copy' \}\)/);
    assert.match(feedback, /telemetry\.trackEvent\('share_clicked', \{ share_channel: 'native' \}\)/);
  });

  test('the generation context of the answer is a fixed subset of keys', () => {
    const ctx = runFeedback('currentResult.connection = "ask"; connectionContext({ next_step: "faq" })', {
      currentResult: {
        telemetryContext: {
          mode: 'awg3', endpoint_mode: 'hostname', endpoint_source: 'hostname', cps_mode: 'auto',
          cps_requested: 'auto', cps_resolved: 'dns', cps_stability: 'stable', mobile_profile: false,
          router_profile: true, count_requested: 1, duration_ms: 900, routes_source: 'catalog',
        },
      },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(ctx)), {
      mode: 'awg3', endpoint_mode: 'hostname', endpoint_source: 'hostname', cps_mode: 'auto',
      cps_requested: 'auto', cps_resolved: 'dns', cps_stability: 'stable', mobile_profile: false,
      router_profile: true, next_step: 'faq',
    });
  });
});

describe('share link and the «Нет» advice', () => {
  test('the shared link is the home page of the page language with utm, nothing else', () => {
    assert.equal(runFeedback('shareUrl("telegram")', { _i18n: { locale: 'ru' } }),
      'https://awgconfig.com/?utm_source=share&utm_medium=telegram');
    assert.equal(runFeedback('shareUrl("copy")', { _i18n: { locale: 'en' } }),
      'https://awgconfig.com/en?utm_source=share&utm_medium=copy');
    assert.equal(runFeedback('shareUrl("native")', { _i18n: { locale: 'ru' } }),
      'https://awgconfig.com/?utm_source=share&utm_medium=native');
  });

  test('robots.txt cleans the utm labels for Yandex and the canonical has no parameters', () => {
    const robots = fs.readFileSync(path.join(__dirname, '..', 'public', 'robots.txt'), 'utf8');
    assert.match(robots, /Clean-param: utm_source&utm_medium&/);
    assert.match(html, /<link rel="canonical" href="https:\/\/awgconfig\.com\/" \/>/);
    const en = fs.readFileSync(path.join(__dirname, '..', 'public', 'en', 'index.html'), 'utf8');
    assert.match(en, /<link rel="canonical" href="https:\/\/awgconfig\.com\/en" \/>/);
  });

  test('a profile accepted by more clients: 3.x → 2.0, 2.0 → 1.5, none after 1.5', () => {
    const map = runFeedback('PROFILE_FALLBACK', {});
    assert.deepEqual(JSON.parse(JSON.stringify(map)), { awg31: 'awg2', awg3: 'awg2', awg2: 'legacy' });
  });

  test('endpoint advice flips Lab Auto ↔ hostname and never offers a stale Lab', () => {
    const alt = (used, labReady) => runFeedback('endpointAlternative()', {
      currentResult: { snapshot: { warpEndpoint: used } },
      endpointDefault: { labReady },
    });
    assert.equal(alt('lab', true), 'hostname');
    assert.equal(alt('lab', false), 'hostname');
    assert.equal(alt('hostname', true), 'lab');
    assert.equal(alt('hostname', false), null);
    assert.equal(alt('162.159.192.7', true), 'hostname', 'a manual address → hostname');
  });
});

describe('markup and texts', () => {
  const block = html.slice(html.indexOf('id="connectCheck"'), html.indexOf('</section>', html.indexOf('id="connectStepsPanel"')));

  test('no free text field: the block holds buttons and links only', () => {
    assert.ok(block.length > 1000, 'block found');
    assert.doesNotMatch(block, /<(input|textarea|select)\b|contenteditable/);
  });

  test('the block lives in the success view and announces its changes', () => {
    const success = html.slice(html.indexOf('id="resultSuccess"'), html.indexOf('id="compatibilityCard"'));
    assert.ok(success.includes('id="connectCheck"'));
    assert.match(block, /class="connect-slot" aria-live="polite"/);
    assert.match(block, /data-slot="next"[\s\S]*data-slot="ask"[\s\S]*data-slot="yes"[\s\S]*data-slot="no"/);
  });

  test('every new string exists in both locales and avoids the forbidden wording', () => {
    const keys = Object.keys(locales.ru).filter((k) => /^(connect_|share_(title|note|telegram|copy|native|copied|message))/.test(k));
    assert.ok(keys.length >= 25, `found ${keys.length} keys`);
    for (const key of keys) {
      assert.ok(locales.en[key], `en: ${key}`);
      for (const lang of ['ru', 'en']) {
        assert.doesNotMatch(locales[lang][key], /обход блокировок|free vpn|бесплатный vpn/i, `${lang}: ${key}`);
      }
    }
    // the placeholders are the same in both languages
    for (const key of keys) {
      const marks = (s) => (s.match(/\{[a-z]+\}/g) || []).sort().join(',');
      assert.equal(marks(locales.en[key]), marks(locales.ru[key]), `placeholders of ${key}`);
    }
  });

  test('the shared message names no vpn:// link, so nothing in a share looks like a config', () => {
    for (const lang of ['ru', 'en']) assert.doesNotMatch(locales[lang].share_message, /vpn:\/\//, lang);
    assert.doesNotMatch(feedback.slice(feedback.indexOf('const shareMessage'), feedback.indexOf('const canShareNatively')), /vpn:\/\//);
  });

  test('the step texts name the real button and FAQ question of each language', () => {
    for (const lang of ['ru', 'en']) {
      const strings = locales[lang];
      assert.ok(strings.connect_steps_note.includes(strings.btn_generate), `${lang}: names the generate button`);
      const question = strings.faq_q5.replace(/[.?]\s.*$/, '').replace(/\.$/, '');
      assert.ok(strings.connect_step_faq_text.includes(question), `${lang}: names FAQ q5 (${question})`);
    }
  });
});
