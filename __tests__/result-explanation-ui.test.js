const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { readAppScript, readAllAppScripts } = require('./helpers/frontend-scripts');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('result explanation loads before the main UI and stays hidden before generation', () => {
  const html = read('public/index.html');
  const modelIndex = html.indexOf('static/result-explanation.js');
  const mainIndex = html.indexOf('static/script.js');
  const resultIndex = html.indexOf('static/result.js');

  assert.ok(modelIndex >= 0 && modelIndex < mainIndex);
  assert.ok(modelIndex < resultIndex, 'result.js reads window.ResultExplanation when it loads');
  assert.ok(html.includes(`static/styles.css?v=${JSON.parse(read('package.json')).version}"`));
  assert.match(html, /id="resultInfoModal" class="modal" role="dialog" aria-modal="true"/);
  assert.match(html, /aria-labelledby="resultInfoModalHeading" aria-hidden="true"/);
  assert.match(html, /id="resultSummaryFields"/);
  assert.match(html, /id="resultRiskLabels"/);
});

test('generation renders summary and diagnostics without replacing result actions', () => {
  const html = read('public/index.html');
  // Генерация — script.js, отрисовка объяснения — result.js.
  const script = readAppScript('script.js');
  const result = readAppScript('result.js');

  assert.match(script, /buildResultSummary\(data, resultState\)/);
  assert.match(script, /renderResultExplanation\(lastResultSummary\)/);
  assert.match(result, /formatAwgCapabilityEvidence/);
  assert.match(result, /awg_protocol_evidence/);
  // Варианты (count = 2–3) — переключатель в панели результата, а не клоны строк кнопок.
  assert.match(script, /data\.configs\.map\(\(cfg, idx\) => \(\{/);
  assert.match(script, /_variant\$\{idx \+ 1\}\.conf/);
  assert.match(html, /id="resultVariantButtons"/);
  assert.match(html, /id="resultDownload"/);
  assert.match(html, /data-result-action="preview"/);
  assert.match(html, /id="resultCopyLink"/);
  assert.match(html, /data-i18n="diagnostics_no_handshake"/);
  assert.match(html, /data-i18n="diagnostics_import_failed"/);
  assert.doesNotMatch(readAllAppScripts(), /console\.log\(['"]vpn:\/\//);
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
    'awg_protocol_evidence',
    'awg_capability_content_padding',
    'awg_capability_disable_cookies',
    'awg_capability_random_trailers',
    'awg_capability_header_protection_key',
    'awg_evidence_status_source_confirmed',
    'awg_evidence_status_peer_dependent_disabled',
    'awg_effective_state_active',
    'awg_effective_state_blocked',
    'awg_effective_value',
  ];

  keys.forEach((key) => {
    assert.equal(typeof ru[key], 'string', `missing RU key ${key}`);
    assert.equal(typeof en[key], 'string', `missing EN key ${key}`);
    assert.ok(ru[key].length > 0, `empty RU key ${key}`);
    assert.ok(en[key].length > 0, `empty EN key ${key}`);
  });
});
