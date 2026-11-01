// __tests__/warp-registration-request.test.js
// The requests to the Cloudflare WARP API stay byte for byte what 3.1.7 sent (profile `legacy`): method, host,
// port, path, agent, headers in order, body. Guards the move of the registration code to
// src/server/warpRegistration.js (3.1.8). No network: the harness answers every request.

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const nacl = require('tweetnacl');
const { generate, registrationAnswer } = require('./helpers/warp-harness');

const HOST = 'api.cloudflareclient.com';
const PREFIX = '/v0i1909051800';

const headerList = (request) => Object.entries(request.headers);
const privateKeyOf = (conf) => /^PrivateKey = (.+)$/m.exec(conf)[1];
const publicKeyOf = (privateKey) => Buffer.from(nacl.box.keyPair.fromSecretKey(Buffer.from(privateKey, 'base64')).publicKey).toString('base64');

/** The three requests of one registration, checked against the 3.1.7 wire form. */
const assertRegistration = ([post, patch, get], conf) => {
  for (const request of [post, patch, get]) {
    assert.equal(request.hostname, HOST);
    assert.equal(request.port, 443);
    assert.equal(request.agent, false);
  }

  assert.equal(post.method, 'POST');
  assert.equal(post.path, `${PREFIX}/reg`);
  const reg = JSON.parse(post.body);
  assert.deepEqual(Object.keys(reg), ['install_id', 'tos', 'key', 'fcm_token', 'type', 'locale']);
  assert.match(reg.tos, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(reg.tos) - Date.now()) < 60_000, 'tos is the time of the request');
  assert.equal(reg.key, publicKeyOf(privateKeyOf(conf)), 'key is the public key of the config PrivateKey');
  assert.equal(post.body, JSON.stringify({ install_id: '', tos: reg.tos, key: reg.key, fcm_token: '', type: 'ios', locale: 'en_US' }));
  assert.deepEqual(headerList(post), [
    ['Content-Type', 'application/json'],
    ['User-Agent', 'okhttp/3.12.1'],
    ['Content-Length', Buffer.byteLength(post.body)],
  ]);

  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.path, `${PREFIX}/reg/harness-id`);
  assert.equal(patch.body, '{"warp_enabled":true}');
  assert.deepEqual(headerList(patch), [
    ['Content-Type', 'application/json'],
    ['User-Agent', 'okhttp/3.12.1'],
    ['Authorization', 'Bearer t'],
    ['Content-Length', 21],
  ]);

  assert.equal(get.method, 'GET');
  assert.equal(get.path, `${PREFIX}/reg/harness-id`);
  assert.equal(get.body, '');
  assert.deepEqual(headerList(get), [
    ['Content-Type', 'application/json'],
    ['User-Agent', 'okhttp/3.12.1'],
    ['Authorization', 'Bearer t'],
    ['Content-Length', 0],
  ]);
};

for (const mode of ['legacy', 'awg2', 'awg3', 'awg31']) {
  test(`${mode}: POST reg, PATCH reg/{id}, GET reg/{id} as in 3.1.7`, async () => {
    const out = await generate({ mode }, { cloudflare: registrationAnswer() });
    assert.equal(out.status, 200);
    assert.equal(out.requests.length, 3);
    assertRegistration(out.requests, out.configs[0]);
  });
}

test('count=3: three registrations, each with its own key, in the same form', async () => {
  const out = await generate({ count: '3' }, { cloudflare: registrationAnswer() });
  assert.equal(out.status, 200);
  assert.equal(out.requests.length, 9);
  for (let i = 0; i < 3; i += 1) assertRegistration(out.requests.slice(i * 3, i * 3 + 3), out.configs[i]);
  assert.equal(new Set(out.requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body).key)).size, 3);
});
