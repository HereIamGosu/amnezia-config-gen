const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const readProjectFile = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');

describe('donate button', () => {
  test('uses CloudTips link instead of legacy embedded payment iframe', () => {
    const html = readProjectFile('public/index.html');
    assert.match(html, /https:\/\/pay\.cloudtips\.ru\/p\/24080824/);
    assert.match(html, /class="donate-link"/);
    assert.match(html, /data-i18n="donate_button"/);
    assert.match(html, /data-i18n-aria-label="donate_aria"/);
    assert.doesNotMatch(html, /yoomoney\.ru\/quickpay\/fundraise\/button/);
    assert.doesNotMatch(html, /class="donate-iframe"/);
  });

  test('has localized button text and accessible label', () => {
    const ru = JSON.parse(readProjectFile('public/locales/ru.json'));
    const en = JSON.parse(readProjectFile('public/locales/en.json'));
    assert.equal(ru.donate_button, 'Поддержать проект');
    assert.equal(ru.donate_aria, 'Поддержать проект через CloudTips');
    assert.equal(ru.donate_text, 'Поддержите автора <br/>и выразите благодарность');
    assert.equal(en.donate_button, 'Support the project');
    assert.equal(en.donate_aria, 'Support the project via CloudTips');
    assert.equal(en.donate_text, 'Support the author <br/>and show appreciation');
  });

  test('lives in the footer as a brand-coloured link with a heart icon (2.8 design)', () => {
    const html = readProjectFile('public/index.html');
    const css = readProjectFile('public/static/styles.css');
    const footer = html.slice(html.indexOf('<footer class="site-footer">'), html.indexOf('</footer>'));
    assert.match(footer, /class="donate-link"/, 'donate link is part of the footer');
    assert.match(footer, /<use href="#i-heart"\/>/, 'donate link shows the heart icon');
    assert.match(css, /\.donate-link\s*\{[^}]*color:\s*var\(--color-orange\);/s, 'donate uses the brand orange');
  });
});
