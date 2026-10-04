#!/usr/bin/env node
/**
 * Production asset build, run inside the Docker builder stage (deploy/Dockerfile) on a COPY of
 * public/. Sources in git stay readable; only the image ships the built files.
 *
 *   node scripts/build-assets.js <public-dir>            minify + precompress in place
 *   node scripts/build-assets.js <public-dir> --force    allow a directory inside a git work tree
 *
 * 1. Minifies every *.js and *.css under <public-dir>/static (recursively, so new files are
 *    covered without touching this script) with esbuild `transform` — no bundling, no wrapper.
 *    The frontend scripts are classic <script> files that share top-level const/let/function
 *    names with each other and with inline scripts in the HTML (global lexical scope), so
 *    identifiers are NOT renamed and nothing is tree-shaken: only whitespace and syntax are
 *    minified. Every built script is compiled once as a classic script to fail the build early.
 * 2. Writes precompressed siblings next to every text asset under <public-dir>: <file>.br
 *    (Brotli, quality 11) and <file>.gz (gzip, level 9). server.js serves them when the client
 *    accepts the encoding. A sibling is written only when it is smaller than the file itself.
 *
 * Refuses to run on a directory inside a git work tree (it would overwrite the readable sources)
 * unless --force is given.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const MINIFY_EXTENSIONS = new Set(['.js', '.css']);
const COMPRESS_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.json', '.map', '.svg', '.html', '.txt', '.xml', '.webmanifest']);

// Identifiers are kept: classic scripts share top-level names across files and inline scripts.
const JS_OPTIONS = Object.freeze({
  loader: 'js',
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  treeShaking: false,
  charset: 'utf8',
  legalComments: 'inline',
});
const CSS_OPTIONS = Object.freeze({
  loader: 'css',
  minify: true,
  charset: 'utf8',
  legalComments: 'inline',
});

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return entry.isFile() ? [full] : [];
});

const isInsideGitWorkTree = (dir) => {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    if (path.dirname(current) === current) return false;
  }
};

const brotli = (buf) => zlib.brotliCompressSync(buf, {
  params: {
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
  },
});
const gzip = (buf) => zlib.gzipSync(buf, { level: 9 });

/** Minifies one JS or CSS source; throws when the result is not a valid classic script. */
async function minify(code, ext, filename, esbuild = require('esbuild')) {
  const result = await esbuild.transform(code, { ...(ext === '.css' ? CSS_OPTIONS : JS_OPTIONS), sourcefile: filename });
  if (ext === '.js') new vm.Script(result.code, { filename }); // syntax check only, never run
  return { code: result.code, warnings: result.warnings };
}

/** Minifies every static JS/CSS file in place. Returns per-file size stats. */
async function minifyStatic(publicDir) {
  const staticDir = path.join(publicDir, 'static');
  if (!fs.existsSync(staticDir)) return [];
  const files = walk(staticDir).filter((file) => MINIFY_EXTENSIONS.has(path.extname(file).toLowerCase())).sort();
  const stats = [];
  for (const file of files) {
    const source = fs.readFileSync(file);
    const rel = path.relative(publicDir, file).split(path.sep).join('/');
    const { code, warnings } = await minify(source.toString('utf8'), path.extname(file).toLowerCase(), rel);
    for (const warning of warnings) process.stderr.write(`warning: ${rel}: ${warning.text}\n`);
    const built = Buffer.from(code, 'utf8');
    fs.writeFileSync(file, built);
    stats.push({
      file: rel,
      raw: [source.length, built.length],
      gzip: [gzip(source).length, gzip(built).length],
      br: [brotli(source).length, brotli(built).length],
    });
  }
  return stats;
}

/** Writes .br/.gz siblings for every compressible file under publicDir. */
function precompress(publicDir) {
  const written = [];
  const files = walk(publicDir).filter((file) => COMPRESS_EXTENSIONS.has(path.extname(file).toLowerCase())).sort();
  for (const file of files) {
    const body = fs.readFileSync(file);
    for (const [suffix, encode] of [['.br', brotli], ['.gz', gzip]]) {
      const sibling = `${file}${suffix}`;
      const encoded = encode(body);
      if (encoded.length < body.length) {
        fs.writeFileSync(sibling, encoded);
        written.push(path.relative(publicDir, sibling).split(path.sep).join('/'));
      } else if (fs.existsSync(sibling)) {
        fs.rmSync(sibling); // never leave a stale sibling for a file that is now served plain
      }
    }
  }
  return written;
}

const pct = (before, after) => (before ? `${(((before - after) / before) * 100).toFixed(1)}%` : '-');

function formatReport(stats) {
  const rows = [['file', 'raw', 'saved', 'gzip', 'saved', 'brotli', 'saved']];
  const total = { raw: [0, 0], gzip: [0, 0], br: [0, 0] };
  for (const s of stats) {
    rows.push([s.file, `${s.raw[0]} -> ${s.raw[1]}`, pct(...s.raw), `${s.gzip[0]} -> ${s.gzip[1]}`, pct(...s.gzip),
      `${s.br[0]} -> ${s.br[1]}`, pct(...s.br)]);
    for (const key of Object.keys(total)) for (const i of [0, 1]) total[key][i] += s[key][i];
  }
  rows.push(['total', `${total.raw[0]} -> ${total.raw[1]}`, pct(...total.raw), `${total.gzip[0]} -> ${total.gzip[1]}`,
    pct(...total.gzip), `${total.br[0]} -> ${total.br[1]}`, pct(...total.br)]);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

async function build(publicDir, { force = false } = {}) {
  const dir = path.resolve(publicDir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Not a directory: ${publicDir}`);
  if (!force && isInsideGitWorkTree(dir)) {
    throw new Error(`${dir} is inside a git work tree: building would overwrite the readable sources. `
      + 'Run it on a copy (the Docker builder stage does), or pass --force.');
  }
  const stats = await minifyStatic(dir);
  const compressed = precompress(dir);
  return { stats, compressed };
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const unknown = argv.filter((arg) => arg.startsWith('--') && arg !== '--force');
  const dirs = argv.filter((arg) => !arg.startsWith('--'));
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  if (dirs.length !== 1) throw new Error('Usage: node scripts/build-assets.js <public-dir> [--force]');
  const { stats, compressed } = await build(dirs[0], { force });
  process.stdout.write(`Minified ${stats.length} file(s) (bytes, before -> after):\n${formatReport(stats)}\n`);
  process.stdout.write(`Precompressed siblings written: ${compressed.length}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`build-assets: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { COMPRESS_EXTENSIONS, JS_OPTIONS, build, formatReport, isInsideGitWorkTree, minify, precompress };
