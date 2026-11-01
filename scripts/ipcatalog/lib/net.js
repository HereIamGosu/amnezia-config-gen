// scripts/ipcatalog/lib/net.js
// Network of the catalogue builder (spec 3.2.0 §4.2): one GET helper with retries on 429, 5xx and network errors
// (up to 4 retries, 1–8 s apart) and a small concurrency pool. The builder runs on the maintainer's machine only;
// tests pass their own `fetchText` and `sleep`, so nothing here touches the network in CI.

'use strict';

const RETRIES = 4;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const TIMEOUT_MS = 30000;
const USER_AGENT = 'amnezia-config-gen-ipcatalog/1.0 (+https://awgconfig.com)';

class HttpError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

const isRetryable = (err) => !(err instanceof HttpError) || err.status === 429 || err.status >= 500;

/** One GET with Node's fetch: the body as text (a Buffer with `binary`), an HttpError for a non-2xx answer. */
const fetchOnce = async (url, { headers = {}, binary = false } = {}) => {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new HttpError(url, res.status);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
};

const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * GET with retries: 429, 5xx and network errors are retried up to four times (1, 2, 4, 8 s); other HTTP errors fail
 * at once.
 * @param {{ fetchText?: typeof fetchOnce, sleep?: (ms: number) => Promise<void>, onRetry?: Function }} [deps]
 */
const createGet = ({ fetchText = fetchOnce, sleep = sleepMs, onRetry = () => {} } = {}) => async (url, opts) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchText(url, opts);
    } catch (err) {
      if (attempt >= RETRIES || !isRetryable(err)) throw err;
      onRetry(url, attempt + 1, err);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
};

/** Runs `task` over `items` with at most `limit` in flight; results in input order. */
const mapPool = async (items, limit, task) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

module.exports = { HttpError, RETRIES, RETRY_DELAYS_MS, createGet, fetchOnce, mapPool };
