// __tests__/indexnow.test.js
// IndexNow submission (scripts/indexnow.js): key file, request shape, response handling,
// waiting for a deployed revision and skipping releases that change nothing public.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  KEY, HOST, KEY_LOCATION, ENDPOINT, buildPayload, changedPublicFiles, parseArgs, sitemapUrls, submit, waitForRevision,
} = require('../scripts/indexnow');

const root = path.resolve(__dirname, '..');

test('the key file is served from the site root and holds exactly the key', () => {
  assert.match(KEY, /^[a-f0-9]{32}$/);
  assert.equal(KEY_LOCATION, `https://${HOST}/${KEY}.txt`);
  assert.equal(fs.readFileSync(path.join(root, 'public', `${KEY}.txt`), 'utf8'), KEY);
  const others = fs.readdirSync(path.join(root, 'public')).filter((f) => /^[a-f0-9]{32}\.txt$/.test(f));
  assert.deepEqual(others, [`${KEY}.txt`], 'one key file only, so a rotated key does not linger');
});

test('robots.txt does not block the key file', () => {
  const disallowed = [...fs.readFileSync(path.join(root, 'public', 'robots.txt'), 'utf8').matchAll(/^Disallow:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(disallowed.every((rule) => !`/${KEY}.txt`.startsWith(rule)));
});

test('the request carries host, key, key location and only this host\'s https URLs', () => {
  const urls = sitemapUrls(fs.readFileSync(path.join(root, 'public', 'sitemap.xml'), 'utf8'));
  assert.deepEqual(urls, ['https://awgconfig.com/', 'https://awgconfig.com/en']);
  assert.deepEqual(buildPayload(urls), { host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: urls });
  assert.throws(() => buildPayload([]), /No URLs/);
  assert.throws(() => buildPayload(['https://example.com/']), /Not a https:\/\/awgconfig\.com URL/);
  assert.throws(() => buildPayload(['http://awgconfig.com/']), /Not a https:\/\/awgconfig\.com URL/);
  assert.throws(() => buildPayload(['not a url']), /Not a URL/);
});

const response = (status, headers = {}) => ({ status, headers: new Headers(headers) });

test('200 and 202 count as success; the POST goes to the shared endpoint as JSON', async () => {
  for (const status of [200, 202]) {
    const calls = [];
    const result = await submit(['https://awgconfig.com/'], { fetchImpl: async (url, init) => { calls.push({ url, init }); return response(status); } });
    assert.equal(result.status, status);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ENDPOINT);
    assert.equal(calls[0].init.method, 'POST');
    assert.match(calls[0].init.headers['Content-Type'], /^application\/json/);
    assert.deepEqual(JSON.parse(calls[0].init.body).urlList, ['https://awgconfig.com/']);
  }
});

test('rejections throw with the protocol meaning; 429 is retried once after a pause', async () => {
  for (const [status, pattern] of [[400, /Bad request/], [403, /key not valid/], [422, /do not belong/], [500, /unexpected/]]) {
    await assert.rejects(submit(['https://awgconfig.com/'], { fetchImpl: async () => response(status) }), pattern);
  }
  const statuses = [429, 202];
  const waits = [];
  const result = await submit(['https://awgconfig.com/'], {
    fetchImpl: async () => response(statuses.shift()), wait: async (ms) => { waits.push(ms); }, retryDelayMs: 5,
  });
  assert.equal(result.status, 202);
  assert.deepEqual(waits, [5]);
  await assert.rejects(submit(['https://awgconfig.com/'], {
    fetchImpl: async () => response(429), wait: async () => {}, retryDelayMs: 0,
  }), /Too many requests/);
});

test('waiting for a revision polls X-App-Revision until production serves it', async () => {
  const live = ['old', 'old', null, 'new'];
  let clock = 0;
  const requests = [];
  const result = await waitForRevision('new', {
    fetchImpl: async (url, init) => { requests.push([url, init.method]); return response(200, live.length ? { 'x-app-revision': live.shift() || '' } : {}); },
    wait: async (ms) => { clock += ms; },
    now: () => clock,
    intervalMs: 10,
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { reached: true, initial: 'old' });
  assert.deepEqual(requests[0], ['https://awgconfig.com/', 'HEAD']);
  assert.equal(requests.length, 4);
});

test('waiting gives up at the deadline and tolerates network errors', async () => {
  let clock = 0;
  const result = await waitForRevision('new', {
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
    wait: async (ms) => { clock += ms; },
    now: () => clock,
    intervalMs: 100,
    timeoutMs: 250,
  });
  assert.deepEqual(result, { reached: false, initial: null });
});

test('a release that changes nothing under public/ is detected; unknown history is not', () => {
  const calls = [];
  assert.deepEqual(changedPublicFiles('a', 'b', (args) => { calls.push(args); return ''; }), []);
  assert.deepEqual(calls[0], ['diff', '--name-only', 'a', 'b', '--', 'public/']);
  assert.deepEqual(changedPublicFiles('a', 'b', () => 'public/index.html\npublic/en/index.html\n'), ['public/index.html', 'public/en/index.html']);
  assert.equal(changedPublicFiles('a', 'b', () => { throw new Error('bad revision'); }), null);
});

test('command-line options are validated', () => {
  assert.deepEqual(parseArgs(['--dry-run', 'https://awgconfig.com/en']).urls, ['https://awgconfig.com/en']);
  assert.equal(parseArgs(['--wait-revision', 'abc1234']).waitRevision, 'abc1234');
  assert.throws(() => parseArgs(['--wait-revision', 'main']), /commit SHA/);
  assert.throws(() => parseArgs(['--since']), /needs a commit/);
  assert.throws(() => parseArgs(['--timeout-minutes', '0']), /positive/);
  assert.throws(() => parseArgs(['--force']), /Unknown option/);
});
