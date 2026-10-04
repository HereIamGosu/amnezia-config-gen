#!/usr/bin/env node
/**
 * Builds the English Endpoint Lab page public/en/lab/index.html (served at /en/lab) from
 * public/lab/index.html and public/locales/en.json — the same way scripts/build-en-page.js builds /en:
 * the address sets the page language, visible text is translated without running JavaScript.
 *
 * Run after editing public/lab/index.html or lab_* locale strings: npm run seo:en
 * `--check` only verifies that the committed page is up to date (used by the test suite).
 *
 * The Russian <title> and description must equal lab_meta_title / lab_meta_description in ru.json.
 * Links that differ by language carry data-href-en="<english url>".
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { translateBody } = require('./build-en-page');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = 'public/lab/index.html';
const TARGET = 'public/en/lab/index.html';
const GENERATED_NOTE = '<!-- Generated from public/lab/index.html and public/locales/en.json by scripts/build-lab-page.js. Do not edit: run npm run seo:en -->';

const escapeText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value) => escapeText(value).replace(/"/g, '&quot;');
const unescapeAttr = (value) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function stringOf(strings, key, file) {
  const value = strings[key];
  if (value === undefined) throw new Error(`${file} has no key "${key}" used by ${SOURCE}`);
  return value;
}

function replaceOnce(html, pattern, replacement, label) {
  let count = 0;
  const out = html.replace(pattern, (...match) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...match) : replacement;
  });
  if (count !== 1) throw new Error(`${label}: expected exactly one match in ${SOURCE}, found ${count}`);
  return out;
}

const TITLE = /<title>([^<]*)<\/title>/g;
const DESCRIPTION = /(<meta name="description" content=")([^"]*)(" \/>)/g;

function assertSourceMatchesLocale(html, ru) {
  const title = [...html.matchAll(TITLE)];
  const description = [...html.matchAll(DESCRIPTION)];
  if (title.length !== 1 || description.length !== 1) throw new Error(`${SOURCE} needs exactly one <title> and one description`);
  const mismatches = [];
  if (unescapeAttr(title[0][1]) !== stringOf(ru, 'lab_meta_title', 'ru.json')) mismatches.push('<title> differs from ru.json "lab_meta_title"');
  if (unescapeAttr(description[0][2]) !== stringOf(ru, 'lab_meta_description', 'ru.json')) mismatches.push('description differs from ru.json "lab_meta_description"');
  if (mismatches.length) throw new Error(`${SOURCE} <head> is out of sync with ru.json:\n- ${mismatches.join('\n- ')}`);
}

/** data-i18n-placeholder (строка поиска) — build-en-page его не знает. */
function translatePlaceholders(html, en) {
  return html.replace(/<input\b[^>]*>/g, (tag) => {
    const key = /\sdata-i18n-placeholder="([^"]+)"/.exec(tag);
    if (!key) return tag;
    return tag.replace(/(\splaceholder=")[^"]*(")/, (_, open, close) => `${open}${escapeAttr(stringOf(en, key[1], 'en.json'))}${close}`);
  });
}

/** href="/" data-href-en="/en" → href="/en": ссылки ведут на страницы того же языка. */
function localizeLinks(html) {
  return html.replace(/(\shref=")[^"]*("[^>]*?\sdata-href-en=")([^"]*)(")/g, (_, open, middle, en, close) => `${open}${en}${middle}${en}${close}`);
}

function buildLabPage(sourceHtml, en, ru) {
  const html = sourceHtml.replace(/\r\n/g, '\n');
  assertSourceMatchesLocale(html, ru);
  let out = replaceOnce(html, /<html lang="ru">/g, '<html lang="en">', '<html lang>');
  out = replaceOnce(out, TITLE, `<title>${escapeText(stringOf(en, 'lab_meta_title', 'en.json'))}</title>`, '<title>');
  out = replaceOnce(out, DESCRIPTION, (_, open, __, close) => `${open}${escapeAttr(stringOf(en, 'lab_meta_description', 'en.json'))}${close}`, 'description');
  out = translateBody(out, en);
  out = translatePlaceholders(out, en);
  out = localizeLinks(out);
  out = replaceOnce(out, /<button class="lang-btn lang-btn--active" data-lang="ru"/g, '<button class="lang-btn" data-lang="ru"', 'RU language button');
  out = replaceOnce(out, /<button class="lang-btn" data-lang="en"/g, '<button class="lang-btn lang-btn--active" data-lang="en"', 'EN language button');
  return replaceOnce(out, /^<!doctype html>\n/gi, (doctype) => `${doctype}${GENERATED_NOTE}\n`, 'doctype');
}

function main() {
  const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const built = buildLabPage(read(SOURCE), JSON.parse(read('public/locales/en.json')), JSON.parse(read('public/locales/ru.json')));
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

module.exports = { buildLabPage, SOURCE, TARGET };
