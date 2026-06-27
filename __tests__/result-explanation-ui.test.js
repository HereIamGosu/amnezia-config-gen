const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('result explanation loads before the main UI and stays hidden before generation', () => {
  const html = read('public/index.html');
  const modelIndex = html.indexOf('static/result-explanation.js');
  const mainIndex = html.indexOf('static/script.js');

  assert.ok(modelIndex >= 0 && modelIndex < mainIndex);
  assert.match(html, /static\/styles\.css\?v=2\.5\.0/);
  assert.match(html, /id="resultInfoModal" class="modal" role="dialog" aria-modal="true"/);
  assert.match(html, /aria-labelledby="resultInfoModalHeading" aria-hidden="true"/);
  assert.match(html, /id="resultSummaryFields"/);
  assert.match(html, /id="resultRiskLabels"/);
});

test('generation renders summary and diagnostics without replacing result actions', () => {
  const html = read('public/index.html');
  const script = read('public/static/script.js');

  assert.match(script, /buildResultSummary\(data, resultState\)/);
  assert.match(script, /renderResultExplanation\(lastResultSummary\)/);
  assert.match(script, /variantRow = row\.cloneNode\(true\)/);
  assert.match(html, /post-gen-row__download/);
  assert.match(html, /post-gen-row__preview/);
  assert.match(html, /post-gen-row__copy-vpn-link/);
  assert.match(html, /data-i18n="diagnostics_no_handshake"/);
  assert.match(html, /data-i18n="diagnostics_import_failed"/);
  assert.doesNotMatch(script, /console\.log\(['"]vpn:\/\//);
});

test('RU and EN locales contain result, risk, and diagnostic labels', () => {
  const ru = JSON.parse(read('public/locales/ru.json'));
  const en = JSON.parse(read('public/locales/en.json'));
  const keys = [
    'result_summary_title',
    'result_summary_format',
    'result_summary_variants',
    'result_summary_endpoint',
    'result_summary_routes_source',
    'result_summary_profile',
    'result_summary_ipv6',
    'result_summary_import',
    'result_summary_warnings',
    'risk_info',
    'risk_warning',
    'risk_blocking',
    'risk_no_critical_warnings',
    'diagnostics_title',
    'diagnostics_no_handshake',
    'diagnostics_connected_no_sites',
    'diagnostics_wifi_vs_mobile',
    'diagnostics_import_failed',
    'diagnostics_open_troubleshooting',
  ];

  keys.forEach((key) => {
    assert.equal(typeof ru[key], 'string', `missing RU key ${key}`);
    assert.equal(typeof en[key], 'string', `missing EN key ${key}`);
    assert.ok(ru[key].length > 0, `empty RU key ${key}`);
    assert.ok(en[key].length > 0, `empty EN key ${key}`);
  });
});
