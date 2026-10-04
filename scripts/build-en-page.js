#!/usr/bin/env node
/**
 * Builds the English landing page public/en/index.html (served at /en) from public/index.html
 * and public/locales/en.json, so search engines get English text without running JavaScript.
 *
 * Run after editing public/index.html or locale strings: npm run seo:en
 * `--check` only verifies that the committed page is up to date (used by the test suite).
 *
 * The <head> strings of public/index.html must equal the meta_* / og_* / ld_* keys of ru.json:
 * the locale files are the single source of truth for both language versions.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = 'public/index.html';
const TARGET = 'public/en/index.html';
const SITE = 'https://awgconfig.com';
const EN_URL = `${SITE}/en`;
const GENERATED_NOTE = '<!-- Generated from public/index.html and public/locales/en.json by scripts/build-en-page.js. Do not edit: run npm run seo:en -->';

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const escapeText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value) => escapeText(value).replace(/"/g, '&quot;');
const unescapeAttr = (value) => value
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stringOf(strings, key, file) {
  const value = strings[key];
  if (value === undefined) throw new Error(`${file} has no key "${key}" used by ${SOURCE}`);
  return value;
}

// Locale values are strings only, so the JSON-LD featureList is stored as "a; b; c".
const featureList = (strings, file) => stringOf(strings, 'ld_app_features', file).split(/\s*;\s*/).filter(Boolean);

function replaceOnce(html, pattern, replacement, label) {
  let count = 0;
  const out = html.replace(pattern, (...match) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...match) : replacement;
  });
  if (count !== 1) throw new Error(`${label}: expected exactly one match in ${SOURCE}, found ${count}`);
  return out;
}

// <meta name|property="X" content="..."> (attributes may be split across lines).
const metaPattern = (attr, name) => new RegExp(`(<meta\\s+${attr}="${escapeRegExp(name)}"\\s+content=")([^"]*)(")`, 'g');

const HEAD_META = [
  ['name', 'description', 'meta_description'],
  ['property', 'og:title', 'og_title'],
  ['property', 'og:description', 'og_description'],
  ['property', 'og:image:alt', 'og_title'],
  ['name', 'twitter:title', 'og_title'],
  ['name', 'twitter:description', 'twitter_description'],
  ['name', 'twitter:image:alt', 'og_title'],
];

function readMeta(html, attr, name) {
  const matches = [...html.matchAll(metaPattern(attr, name))];
  if (matches.length !== 1) throw new Error(`${name}: expected exactly one meta tag in ${SOURCE}, found ${matches.length}`);
  return unescapeAttr(matches[0][2]);
}

function readTitle(html) {
  const matches = [...html.matchAll(/<title>([^<]*)<\/title>/g)];
  if (matches.length !== 1) throw new Error(`<title>: expected exactly one in ${SOURCE}, found ${matches.length}`);
  return unescapeAttr(matches[0][1]);
}

const JSON_LD_PATTERN = /(<script type="application\/ld\+json">\n)([\s\S]*?)(\n\s*<\/script>)/g;

function readJsonLd(html) {
  const matches = [...html.matchAll(JSON_LD_PATTERN)];
  if (matches.length !== 1) throw new Error(`JSON-LD: expected exactly one block in ${SOURCE}, found ${matches.length}`);
  return JSON.parse(matches[0][2]);
}

function graphNode(data, type) {
  const node = (data['@graph'] || []).find((item) => item['@type'] === type);
  if (!node) throw new Error(`JSON-LD in ${SOURCE} has no ${type} node`);
  return node;
}

/** Fails when the Russian head drifted away from ru.json (the source of truth for both pages). */
function assertSourceMatchesLocale(html, ru) {
  const mismatches = [];
  const expect = (label, actual, key) => {
    const wanted = stringOf(ru, key, 'ru.json');
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) mismatches.push(`${label} differs from ru.json "${key}"`);
  };
  expect('<title>', readTitle(html), 'meta_title');
  for (const [attr, name, key] of HEAD_META) expect(name, readMeta(html, attr, name), key);
  const ld = readJsonLd(html);
  expect('JSON-LD WebPage.name', graphNode(ld, 'WebPage').name, 'meta_title');
  expect('JSON-LD WebPage.description', graphNode(ld, 'WebPage').description, 'meta_description');
  expect('JSON-LD WebApplication.description', graphNode(ld, 'WebApplication').description, 'ld_app_description');
  const features = graphNode(ld, 'WebApplication').featureList;
  if (JSON.stringify(features) !== JSON.stringify(featureList(ru, 'ru.json'))) {
    mismatches.push('JSON-LD WebApplication.featureList differs from ru.json "ld_app_features"');
  }
  if (mismatches.length > 0) throw new Error(`${SOURCE} <head> is out of sync with ru.json:\n- ${mismatches.join('\n- ')}`);
}

function localizeHead(html, en) {
  let out = replaceOnce(html, /<html lang="ru">/g, '<html lang="en">', '<html lang>');
  out = replaceOnce(out, /<title>[^<]*<\/title>/g, `<title>${escapeText(stringOf(en, 'meta_title', 'en.json'))}</title>`, '<title>');
  for (const [attr, name, key] of HEAD_META) {
    out = replaceOnce(out, metaPattern(attr, name), (_, open, __, close) => `${open}${escapeAttr(stringOf(en, key, 'en.json'))}${close}`, name);
  }
  out = replaceOnce(out, /<meta property="og:locale" content="ru_RU" \/>/g, '<meta property="og:locale" content="en_US" />', 'og:locale');
  out = replaceOnce(out, /<meta property="og:locale:alternate" content="en_US" \/>/g, '<meta property="og:locale:alternate" content="ru_RU" />', 'og:locale:alternate');
  out = replaceOnce(out, metaPattern('property', 'og:url'), (_, open, __, close) => `${open}${EN_URL}${close}`, 'og:url');
  out = replaceOnce(out, /<link rel="canonical" href="[^"]*" \/>/g, `<link rel="canonical" href="${EN_URL}" />`, 'canonical');
  out = replaceOnce(out, JSON_LD_PATTERN, (_, open, json, close) => {
    const data = JSON.parse(json);
    const page = graphNode(data, 'WebPage');
    page['@id'] = `${EN_URL}#webpage`;
    page.url = EN_URL;
    page.name = stringOf(en, 'meta_title', 'en.json');
    page.description = stringOf(en, 'meta_description', 'en.json');
    page.inLanguage = 'en-US';
    const app = graphNode(data, 'WebApplication');
    app.description = stringOf(en, 'ld_app_description', 'en.json');
    app.featureList = featureList(en, 'en.json');
    const indent = /^( *)/.exec(json)[1];
    const body = JSON.stringify(data, null, 2).split('\n').map((line) => indent + line).join('\n');
    return `${open}${body}${close}`;
  }, 'JSON-LD');
  return out;
}

function setAttr(attrs, name, value) {
  const pattern = new RegExp(`(\\s${escapeRegExp(name)}=")[^"]*(")`);
  return pattern.test(attrs)
    ? attrs.replace(pattern, (_, open, close) => `${open}${escapeAttr(value)}${close}`)
    : `${attrs} ${name}="${escapeAttr(value)}"`;
}

const attrValue = (attrs, name) => {
  const match = new RegExp(`\\s${escapeRegExp(name)}="([^"]*)"`).exec(attrs);
  return match ? match[1] : null;
};

/** Index just past the closing tag that matches an element opened right before `from`. */
function findClosingTag(html, tagName, from) {
  const pattern = new RegExp(`<(/?)${escapeRegExp(tagName)}\\b[^>]*>`, 'gi');
  pattern.lastIndex = from;
  let depth = 1;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return { innerEnd: match.index, closeEnd: pattern.lastIndex };
  }
  throw new Error(`Unclosed <${tagName}> in ${SOURCE}`);
}

/**
 * Applies data-i18n* translations exactly like applyTranslations() in static/i18n.js does in the
 * browser: data-i18n -> textContent, data-i18n-html -> innerHTML, -title / -aria-label / -alt -> attributes.
 */
function translateBody(html, en) {
  const tokenPattern = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<([a-zA-Z][\w-]*)(\s[^>]*?)?(\/?)>/g;
  let out = '';
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(html)) !== null) {
    const [token, , tagName, rawAttrs = ''] = match;
    if (!tagName || !/\sdata-i18n/.test(rawAttrs)) continue;

    let attrs = rawAttrs;
    const titleKey = attrValue(attrs, 'data-i18n-title');
    if (titleKey) attrs = setAttr(attrs, 'title', stringOf(en, titleKey, 'en.json'));
    const ariaKey = attrValue(attrs, 'data-i18n-aria-label');
    if (ariaKey) attrs = setAttr(attrs, 'aria-label', stringOf(en, ariaKey, 'en.json'));
    const altKey = attrValue(attrs, 'data-i18n-alt');
    if (altKey) attrs = setAttr(attrs, 'alt', stringOf(en, altKey, 'en.json'));

    out += html.slice(cursor, match.index) + `<${tagName}${attrs}${match[4]}>`;
    cursor = match.index + token.length;

    const textKey = attrValue(attrs, 'data-i18n');
    const htmlKey = attrValue(attrs, 'data-i18n-html');
    if (!textKey && !htmlKey) continue;
    if (VOID_ELEMENTS.has(tagName.toLowerCase()) || match[4]) {
      throw new Error(`<${tagName}> cannot carry data-i18n content in ${SOURCE}`);
    }
    const { innerEnd, closeEnd } = findClosingTag(html, tagName, cursor);
    const content = textKey ? escapeText(stringOf(en, textKey, 'en.json')) : stringOf(en, htmlKey, 'en.json');
    out += content + html.slice(innerEnd, closeEnd);
    cursor = closeEnd;
    tokenPattern.lastIndex = closeEnd;
  }
  return out + html.slice(cursor);
}

function localizeChrome(html) {
  let out = replaceOnce(html, /<button class="lang-btn lang-btn--active" data-lang="ru"/g,
    '<button class="lang-btn" data-lang="ru"', 'RU language button');
  out = replaceOnce(out, /<button class="lang-btn" data-lang="en"/g,
    '<button class="lang-btn lang-btn--active" data-lang="en"', 'EN language button');
  // Root-relative asset paths keep working at /en and any deeper path.
  out = out.replace(/(\s(?:href|src)=")static\//g, '$1/static/');
  // Links to pages with their own English version: href="/lab" data-href-en="/en/lab".
  out = out.replace(/(\shref=")[^"]*("[^>]*?\sdata-href-en=")([^"]*)(")/g, (_, open, middle, en, close) => `${open}${en}${middle}${en}${close}`);
  return replaceOnce(out, /^<!doctype html>\n/gi, (doctype) => `${doctype}${GENERATED_NOTE}\n`, 'doctype');
}

function buildEnPage(sourceHtml, en, ru) {
  const html = sourceHtml.replace(/\r\n/g, '\n');
  assertSourceMatchesLocale(html, ru);
  return localizeChrome(translateBody(localizeHead(html, en), en));
}

function main() {
  const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const built = buildEnPage(read(SOURCE), JSON.parse(read('public/locales/en.json')), JSON.parse(read('public/locales/ru.json')));
  const targetPath = path.join(ROOT, TARGET);

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(targetPath) ? read(TARGET).replace(/\r\n/g, '\n') : null;
    if (current !== built) {
      process.stderr.write(`${TARGET} is out of date: run npm run seo:en\n`);
      process.exit(1);
    }
    process.stdout.write(`${TARGET} is up to date\n`);
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, built, 'utf8');
  process.stdout.write(`Wrote ${TARGET}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { buildEnPage, translateBody, SOURCE, TARGET, EN_URL };
