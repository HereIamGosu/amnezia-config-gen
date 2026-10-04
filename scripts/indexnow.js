#!/usr/bin/env node
/**
 * Submits site URLs to IndexNow: one request reaches every participating engine (Bing, Yandex,
 * Seznam, Naver, Yep). Google does not take part; it reads public/sitemap.xml via Search Console.
 *
 *   npm run indexnow                                  every <loc> of public/sitemap.xml
 *   npm run indexnow -- https://awgconfig.com/en      only the given URLs
 *   npm run indexnow -- --wait-revision <sha>         first wait until production serves <sha>
 *                                                     (X-App-Revision), so engines fetch the new pages
 *   npm run indexnow -- --since <sha>                 skip when nothing under public/ changed since <sha>
 *   npm run indexnow -- --dry-run                     print the request, send nothing
 *
 * The key is public by protocol design: it is served at KEY_LOCATION and only proves that the
 * submitter controls this host. It grants nothing beyond submitting this host's own URLs.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const KEY = '6d52ff40b45b0f9402ffa3609ed0f0b2';
const HOST = 'awgconfig.com';
const SITE = `https://${HOST}`;
const KEY_LOCATION = `${SITE}/${KEY}.txt`;
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const RETRY_DELAY_MS = 60_000;

// https://www.indexnow.org/documentation#response
const RESPONSES = {
  200: 'OK: URLs submitted',
  202: 'Accepted: URLs received, key validation pending',
  400: 'Bad request: invalid format',
  403: `Forbidden: key not valid (is ${KEY_LOCATION} reachable and does it contain the key?)`,
  422: `Unprocessable: URLs do not belong to ${HOST} or the key does not match`,
  429: 'Too many requests: possible spam, slow down',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
}

function buildPayload(urls) {
  if (urls.length === 0) throw new Error('No URLs to submit');
  if (urls.length > 10_000) throw new Error('IndexNow accepts at most 10,000 URLs per request');
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Not a URL: ${url}`);
    }
    if (parsed.protocol !== 'https:' || parsed.host !== HOST) throw new Error(`Not a ${SITE} URL: ${url}`);
  }
  return { host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList: urls };
}

/** POSTs the payload; retries once on 429. Resolves with the status, throws on rejection. */
async function submit(urls, { fetchImpl = fetch, wait = sleep, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const body = JSON.stringify(buildPayload(urls));
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body,
    });
    if (res.status === 200 || res.status === 202) return { status: res.status, message: RESPONSES[res.status] };
    if (res.status === 429 && attempt === 1) {
      await wait(retryDelayMs);
      continue;
    }
    throw new Error(`IndexNow ${res.status}: ${RESPONSES[res.status] || 'unexpected response'}`);
  }
}

const liveRevision = async (fetchImpl) => {
  try {
    const res = await fetchImpl(`${SITE}/`, { method: 'HEAD', cache: 'no-store' });
    return res.headers.get('x-app-revision');
  } catch {
    return null;
  }
};

const gitRun = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * True when `descendant` already contains `revision`: production went straight to a later commit
 * (a quick follow-up push), which includes our changes too. A commit pushed after this checkout is
 * fetched once; any git failure means "not proven", so waiting simply continues.
 */
function isDescendant(revision, descendant, run = gitRun) {
  const check = () => {
    try {
      run(['merge-base', '--is-ancestor', revision, descendant]);
      return true;
    } catch {
      return false;
    }
  };
  if (check()) return true;
  try {
    run(['fetch', '--quiet', 'origin', descendant]);
  } catch {
    return false;
  }
  return check();
}

/**
 * Polls production until it serves `revision` or a later commit that contains it. Returns
 * { reached, initial }, where `initial` is the revision that was live when waiting started (null if unknown).
 */
async function waitForRevision(revision, {
  fetchImpl = fetch, wait = sleep, now = Date.now, timeoutMs = 30 * 60_000, intervalMs = 30_000, onPoll = () => {},
  descends = isDescendant,
} = {}) {
  const deadline = now() + timeoutMs;
  const initial = await liveRevision(fetchImpl);
  let current = initial;
  // Only a revision that changed since waiting started can be a descendant: no git calls while production is idle.
  // The live header goes to git only when it looks like a commit SHA (defence in depth: no option-like values).
  const reached = () => current === revision
    || (!!current && current !== initial && /^[0-9a-f]{7,40}$/.test(current) && descends(revision, current));
  while (!reached()) {
    onPoll(current);
    if (now() >= deadline) return { reached: false, initial };
    await wait(intervalMs);
    current = await liveRevision(fetchImpl);
  }
  return { reached: true, initial };
}

/** Files under public/ that differ between two commits; null when git cannot compare them. */
function changedPublicFiles(base, head, run = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })) {
  try {
    return run(['diff', '--name-only', base, head, '--', 'public/']).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { urls: [], dryRun: false, waitRevision: null, since: null, timeoutMinutes: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--wait-revision') args.waitRevision = argv[++i];
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--timeout-minutes') args.timeoutMinutes = Number(argv[++i]);
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else args.urls.push(arg);
  }
  if (args.waitRevision !== null && !/^[0-9a-f]{7,40}$/.test(args.waitRevision || '')) throw new Error('--wait-revision needs a commit SHA');
  if (args.since !== null && !args.since) throw new Error('--since needs a commit');
  if (!(args.timeoutMinutes > 0)) throw new Error('--timeout-minutes must be positive');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = (line) => process.stdout.write(`${line}\n`);
  const urls = args.urls.length > 0 ? args.urls : sitemapUrls(fs.readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8'));

  if (args.waitRevision) {
    out(`Waiting until ${SITE} serves ${args.waitRevision} (up to ${args.timeoutMinutes} min)...`);
    const { reached } = await waitForRevision(args.waitRevision, {
      timeoutMs: args.timeoutMinutes * 60_000,
      onPoll: (current) => out(`  live revision: ${current || 'unknown'}`),
    });
    if (!reached) throw new Error(`Production did not reach ${args.waitRevision}; nothing submitted`);
  }

  if (args.since) {
    const changed = changedPublicFiles(args.since, args.waitRevision || 'HEAD');
    if (changed && changed.length === 0) {
      out(`Nothing under public/ changed since ${args.since}; nothing submitted.`);
      return;
    }
    out(changed ? `Changed under public/: ${changed.join(', ')}` : `Cannot compare with ${args.since}; submitting anyway.`);
  }

  const payload = buildPayload(urls);
  if (args.dryRun) {
    out(`POST ${ENDPOINT}\n${JSON.stringify(payload, null, 2)}`);
    return;
  }
  const { status, message } = await submit(urls);
  out(`IndexNow ${status}: ${message}\n${urls.map((url) => `  ${url}`).join('\n')}`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  KEY, HOST, KEY_LOCATION, ENDPOINT, buildPayload, changedPublicFiles, isDescendant, parseArgs, sitemapUrls, submit, waitForRevision,
};
