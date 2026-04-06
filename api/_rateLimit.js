'use strict';

/**
 * Simple in-memory sliding-window rate limiter for Vercel serverless.
 *
 * Each function instance keeps its own map; on cold starts the map is empty.
 * This is "best-effort" — sufficient to stop casual abuse, not a DDoS shield.
 *
 * @param {{ windowMs?: number, maxHits?: number }} opts
 */
const createRateLimiter = ({ windowMs = 60_000, maxHits = 10 } = {}) => {
  /** @type {Map<string, number[]>} IP → sorted array of timestamps */
  const hits = new Map();

  /** Evict expired entries every 2 minutes to avoid memory leak in long-lived instances. */
  const CLEANUP_INTERVAL_MS = 120_000;
  let lastCleanup = Date.now();

  const cleanup = () => {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = now;
    const cutoff = now - windowMs;
    for (const [ip, timestamps] of hits) {
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }
  };

  /**
   * @param {import('http').IncomingMessage} req
   * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
   */
  const check = (req) => {
    cleanup();

    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      (req.headers['x-real-ip'] || '').trim() ||
      req.socket?.remoteAddress ||
      'unknown';

    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (hits.get(ip) || []).filter((t) => t > cutoff);

    if (timestamps.length >= maxHits) {
      const oldest = timestamps[0];
      const retryAfterMs = oldest + windowMs - now;
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    timestamps.push(now);
    hits.set(ip, timestamps);
    return { allowed: true, remaining: maxHits - timestamps.length, retryAfterMs: 0 };
  };

  return { check };
};

module.exports = { createRateLimiter };
