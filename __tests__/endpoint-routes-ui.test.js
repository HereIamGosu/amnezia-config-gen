// __tests__/endpoint-routes-ui.test.js
// The 3.2.0 Endpoint rule (I15, spec 3.2.0 §5.4) in the UI, run as code (vm) where it matters: the Lab Auto refusal
// lab_endpoints_in_routes is a Lab refusal (localized text, the hostname button), and the warning
// "Endpoint override inside routes: <address>" is shown in the visitor's language with its address.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const { readAppScript } = require('./helpers/frontend-scripts');
const { buildResultSummary } = require('../public/static/result-explanation');

const LOCALES = path.resolve(__dirname, '..', 'public', 'locales');
const strings = (lang) => JSON.parse(fs.readFileSync(path.join(LOCALES, `${lang}.json`), 'utf8'));
const slice = (source, from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} … ${to}`);
  return source.slice(start, end);
};

describe('lab_endpoints_in_routes is a Lab Auto refusal', () => {
  const load = (lang) => {
    const code = `${slice(readAppScript('script.js'), 'const LAB_AUTO_ERRORS', 'const PROFILE_MODES')}\n;({ LAB_AUTO_ERRORS, apiError })`;
    return vm.runInNewContext(code, { t: (key, fallback) => strings(lang)[key] ?? fallback });
  };

  for (const lang of ['ru', 'en']) {
    test(`${lang}: the localized text and the hostname button flag`, () => {
      const { apiError } = load(lang);
      const error = apiError({ success: false, error: 'lab_endpoints_in_routes', message: 'server text' }, 'fallback');
      assert.equal(error.labRefusal, true, 'the error panel offers hostname');
      assert.equal(error.message, strings(lang).err_lab_endpoints_in_routes);
      assert.doesNotMatch(error.message, /server text/);
    });
  }

  test('every Lab Auto code of the server has a UI entry and a key in both locales', () => {
    const { LAB_AUTO_ERROR_CODES } = require('../src/server/endpointProvider');
    const { LAB_AUTO_ERRORS } = load('ru');
    for (const code of LAB_AUTO_ERROR_CODES) {
      assert.ok(LAB_AUTO_ERRORS[code], code);
      for (const lang of ['ru', 'en']) assert.ok(strings(lang)[`err_${code}`], `${lang}: err_${code}`);
    }
    assert.ok(LAB_AUTO_ERROR_CODES.includes('lab_endpoints_in_routes'));
  });
});

describe('the manual override warning', () => {
  const MESSAGE = 'Endpoint override inside routes: 188.114.96.7';

  test('it gets the stable code endpoint_override_in_routes', () => {
    const summary = buildResultSummary({
      success: true, mode: 'awg2', count: 1, routeMode: 'split', routesSource: 'presets',
      configs: [{ content: 'a', endpointSource: 'hostname' }], warning: MESSAGE,
    }, { warpEndpoint: '188.114.96.7', port: 2408, configCount: 1 });
    assert.deepEqual(summary.warnings.map((w) => w.code), ['endpoint_override_in_routes']);
  });

  for (const lang of ['ru', 'en']) {
    test(`${lang}: the localized text names the address`, () => {
      const code = `${slice(readAppScript('result.js'), 'const warningText', 'const appendSummaryField')}\n;warningText`;
      const warningText = vm.runInNewContext(code, { t: (key, fallback) => strings(lang)[key] ?? fallback });
      const template = strings(lang).risk_endpoint_override_in_routes;
      assert.match(template, /\{address\}/);
      assert.equal(warningText({ code: 'endpoint_override_in_routes', message: MESSAGE }), template.replace('{address}', '188.114.96.7'));
    });
  }
});
