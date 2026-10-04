const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { buildResultSummary } = require('../public/static/result-explanation');
const { sanitizePayload } = require('../public/static/analytics');
const { APP_SCRIPTS, readAppScript } = require('./helpers/frontend-scripts');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const summaryFor = (endpointSource) => buildResultSummary(
  { success: true, content: 'base64', configs: [{ index: 1, content: 'base64', endpointSource }] },
  { configCount: 1, routePresets: [] },
);

test('a TCP-checked endpoint from the built-in list is not labelled as KV', () => {
  assert.deepEqual(summaryFor('tcp_check').endpoint, { mode: 'auto', source: 'tcpCheck' });
  assert.deepEqual(summaryFor('fallback').endpoint, { mode: 'auto', source: 'fallback' });
  assert.equal(summaryFor('kv').endpoint.source, 'unknown', 'the API never returns kv; it is not a known source any more');
});

test('telemetry reports tcp_check as is and no longer accepts kv', () => {
  assert.equal(sanitizePayload({ endpoint_source: 'tcp_check' }).endpoint_source, 'tcp_check');
  assert.equal(sanitizePayload({ endpoint_source: 'kv' }).endpoint_source, undefined);
  const script = readAppScript('script.js');
  assert.match(script, /const getEndpointTelemetrySource =[\s\S]*?return source \|\| 'unknown';/);
});

test('no user-facing KV label remains in the frontend', () => {
  const generatorScripts = APP_SCRIPTS.map((name) => `public/static/${name}`);
  for (const file of [...generatorScripts, 'public/static/result-explanation.js', 'public/static/analytics.js', 'public/index.html']) {
    assert.doesNotMatch(read(file), /'KV'|\bkv:|'kv'/, file);
  }
  for (const lang of ['ru', 'en']) {
    const locale = JSON.parse(read(`public/locales/${lang}.json`));
    assert.ok(locale.result_summary_endpoint_tcp_check, `${lang}.result_summary_endpoint_tcp_check`);
    assert.doesNotMatch(JSON.stringify(locale), /"KV"|Vercel KV/);
  }
});
