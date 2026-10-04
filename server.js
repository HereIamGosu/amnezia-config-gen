'use strict';

// Self-hosted runtime: mimics the subset of Vercel behaviour this project relies on
// (static files from public/, /api/<name> -> api/<name>.js, headers from vercel.json),
// so the same code runs on a VPS without the Vercel CLI. No extra dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
// PUBLIC_DIR overrides the static root (tests serve a built copy); production uses ./public.
const PUBLIC_DIR = process.env.PUBLIC_DIR ? path.resolve(process.env.PUBLIC_DIR) : path.join(ROOT, 'public');
const API_DIR = path.join(ROOT, 'api');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DURATION_S = 10;
// Commit SHA baked into the image (deploy/Dockerfile ARG APP_REVISION); anything else is ignored.
const APP_REVISION = /^[0-9a-f]{7,40}$/.test(process.env.APP_REVISION || '') ? process.env.APP_REVISION : null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
};

// Precompressed siblings (<file>.br, <file>.gz) are written by scripts/build-assets.js in the
// Docker builder stage. Preference order: Brotli, then gzip; otherwise the plain file.
const PRECOMPRESSED = [
  { encoding: 'br', suffix: '.br' },
  { encoding: 'gzip', suffix: '.gz' },
];
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.map', '.txt', '.xml', '.webmanifest', '.svg']);

const VERCEL_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

/** vercel.json "headers" sources are path-to-regexp; the ones used here are plain regex-compatible. */
const HEADER_RULES = (VERCEL_CONFIG.headers || []).map((rule) => ({
  re: new RegExp(`^${rule.source.replace(/\.(?!\*)/g, '\\.')}$`),
  headers: rule.headers,
}));

/** Per-function wall-clock limit (vercel.json "functions.*.maxDuration"), enforced by Vercel before. */
const maxDurationMs = (name) =>
  (VERCEL_CONFIG.functions?.[`api/${name}.js`]?.maxDuration ?? DEFAULT_MAX_DURATION_S) * 1000;

const API_ROUTES = new Set(
  fs
    .readdirSync(API_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .map((f) => f.slice(0, -3)),
);

const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

const applyConfigHeaders = (req, res, pathname) => {
  for (const rule of HEADER_RULES) {
    if (!rule.re.test(pathname)) continue;
    for (const { key, value } of rule.headers) {
      let v = value;
      // Over plain HTTP (e.g. direct IP access) upgrade-insecure-requests would break every asset.
      if (key.toLowerCase() === 'content-security-policy' && !isHttps(req)) {
        v = v.replace(/;\s*upgrade-insecure-requests/, '');
      }
      res.setHeader(key, v);
    }
  }
};

const parseQuery = (searchParams) => {
  const query = {};
  for (const [k, v] of searchParams) {
    if (Object.prototype.hasOwnProperty.call(query, k)) {
      query[k] = Array.isArray(query[k]) ? [...query[k], v] : [query[k], v];
    } else {
      query[k] = v;
    }
  }
  return query;
};

const payloadTooLarge = () => Object.assign(new Error('Payload too large'), { statusCode: 413 });

const readBody = (req) =>
  new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      reject(payloadTooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so the 413 response can be delivered
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(payloadTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/** Vercel-style response helpers used by api/*.js. */
const decorateResponse = (res) => {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (body == null) {
      res.end();
    } else if (Buffer.isBuffer(body)) {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/octet-stream');
      res.end(body);
    } else if (typeof body === 'object') {
      res.json(body);
    } else {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(String(body));
    }
    return res;
  };
  res.redirect = (statusOrUrl, maybeUrl) => {
    const [code, url] = typeof statusOrUrl === 'number' ? [statusOrUrl, maybeUrl] : [307, statusOrUrl];
    res.writeHead(code, { Location: url });
    res.end();
    return res;
  };
};

const sendError = (res, code, message) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (code === 413) res.setHeader('Connection', 'close');
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ success: false, message }));
};

const handleApi = async (req, res, name, url) => {
  if (!API_ROUTES.has(name)) {
    sendError(res, 404, 'Not found');
    return;
  }

  req.query = parseQuery(url.searchParams);
  decorateResponse(res);

  const contentType = String(req.headers['content-type'] || '');
  if (!['GET', 'HEAD'].includes(req.method) && contentType.includes('application/json')) {
    // Vercel pre-parses JSON bodies; other content types are left for the handler to stream.
    const raw = await readBody(req);
    if (raw.length) {
      try {
        req.body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendError(res, 400, 'Некорректное JSON-тело запроса.');
        return;
      }
    }
  }

  const handler = require(path.join(API_DIR, `${name}.js`));
  const fn = typeof handler === 'function' ? handler : handler.default;

  // Upstream retries can exceed the old Vercel limit; answer 504 instead of holding the client.
  // The handler keeps running to completion, its late writes are ignored.
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (!res.headersSent) {
        console.error(`[${new Date().toISOString()}] /api/${name} exceeded ${maxDurationMs(name)} ms`);
        sendError(res, 504, 'Превышено время ожидания ответа. Попробуйте позже.');
      }
      resolve();
    }, maxDurationMs(name));
  });
  try {
    await Promise.race([fn(req, res), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

const resolveStaticFile = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  // Precompressed siblings are an internal representation, reachable only via Accept-Encoding.
  if (/\.(br|gz)$/i.test(decoded)) return null;
  let filePath = path.join(PUBLIC_DIR, path.normalize(decoded));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return null;
  try {
    let stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = fs.statSync(filePath);
    }
    return stat.isFile() ? { filePath, stat } : null;
  } catch {
    return null;
  }
};

const pipeFile = (filePath, res) => {
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] static read failed: ${filePath}`, err.message);
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
};

/** Accept-Encoding -> Map(coding -> q). Missing q means 1; unparsable q means "not acceptable". */
const parseAcceptEncoding = (header) => {
  const accepted = new Map();
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const m = /^q\s*=\s*([0-9.]+)$/.exec(param);
      if (m) q = Number(m[1]);
    }
    accepted.set(name, Number.isFinite(q) ? q : 0);
  }
  return accepted;
};

const acceptsEncoding = (accepted, encoding) =>
  (accepted.has(encoding) ? accepted.get(encoding) : accepted.get('*') ?? 0) > 0;

/**
 * Precompressed representation of a static file: { vary, variant }. `vary` is true whenever a
 * sibling exists (the response then depends on Accept-Encoding, plain or not). A sibling older
 * than its file is ignored, so an edited file is never shadowed by a stale build. Range requests
 * always get the plain file.
 */
const pickPrecompressed = (req, filePath, stat) => {
  if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return { vary: false, variant: null };
  const siblings = [];
  for (const { encoding, suffix } of PRECOMPRESSED) {
    try {
      const siblingStat = fs.statSync(filePath + suffix);
      if (siblingStat.isFile() && siblingStat.mtimeMs >= stat.mtimeMs) {
        siblings.push({ encoding, filePath: filePath + suffix, stat: siblingStat });
      }
    } catch {
      // no sibling of this encoding
    }
  }
  if (siblings.length === 0) return { vary: false, variant: null };
  if (req.headers.range) return { vary: true, variant: null };
  const accepted = parseAcceptEncoding(req.headers['accept-encoding']);
  return { vary: true, variant: siblings.find((s) => acceptsEncoding(accepted, s.encoding)) || null };
};

const serveStatic = (req, res, pathname) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  const found = resolveStaticFile(pathname);
  if (!found) {
    const notFound = resolveStaticFile('/404.html');
    res.statusCode = 404;
    res.setHeader('Cache-Control', 'no-cache'); // don't let /static/* immutable rule cache a miss
    if (notFound) {
      res.setHeader('Content-Type', MIME_TYPES['.html']);
      pipeFile(notFound.filePath, res);
    } else {
      res.setHeader('Content-Type', MIME_TYPES['.txt']);
      res.end('404: NOT_FOUND');
    }
    return;
  }

  const { vary, variant } = pickPrecompressed(req, found.filePath, found.stat);
  const { filePath, stat } = variant || found;
  // Each representation gets its own strong validator.
  const etagHash = crypto.createHash('sha1').update(`${stat.size}-${stat.mtimeMs}`).digest('hex').slice(0, 16);
  const etag = `"${etagHash}${variant ? `-${variant.encoding}` : ''}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', found.stat.mtime.toUTCString());
  // The type of the original file, never of the .br/.gz sibling.
  res.setHeader('Content-Type', MIME_TYPES[path.extname(found.filePath).toLowerCase()] || 'application/octet-stream');
  if (vary) res.setHeader('Vary', 'Accept-Encoding');
  if (variant) res.setHeader('Content-Encoding', variant.encoding);

  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeFile(filePath, res);
};

const server = http.createServer(async (req, res) => {
  // Lets deployment checks prove which release answers (a commit SHA is not a secret).
  if (APP_REVISION) res.setHeader('X-App-Revision', APP_REVISION);
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const { pathname } = url;

  // trailingSlash: false
  if (pathname.length > 1 && pathname.endsWith('/')) {
    res.writeHead(308, { Location: pathname.replace(/\/+$/, '') + url.search });
    res.end();
    return;
  }

  applyConfigHeaders(req, res, pathname);

  try {
    const apiMatch = /^\/api\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (apiMatch) {
      await handleApi(req, res, apiMatch[1], url);
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    if (!err.statusCode || err.statusCode >= 500) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${pathname} failed:`, err);
    }
    sendError(res, err.statusCode || 500, err.statusCode ? err.message : 'Internal Server Error');
  }
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = REQUEST_TIMEOUT_MS;

server.listen(PORT, HOST, () => {
  console.log(`amnezia-config-gen listening on http://${HOST}:${PORT} (api: ${[...API_ROUTES].join(', ')})`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
