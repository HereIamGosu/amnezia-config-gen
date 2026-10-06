// __tests__/mobile-shell.test.js
//
// iPhone (Safari) specifics that a desktop Chrome emulation cannot reproduce, so they are checked in the source:
// 1. 100vh in Safari is the screen without the browser bars, larger than the visible area — a bottom sheet sized in
//    vh pushed its header with the close button above the screen. Every vh size of a dialog needs a dvh twin, the
//    dialog is centred with margin: auto (its top stays reachable) and the backdrop scrolls.
// 2. Safari sends no click for a tap on a plain <div> without a handler or cursor: pointer, so the backdrop did not
//    close the dialog. The backdrop has cursor: pointer and the press is tracked with pointerdown.
// e2e/mobile-dialogs.e2e.js checks the layout of every dialog at iPhone sizes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const css = read('public/static/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const html = read('public/index.html');
const lab = read('public/lab/index.html');

/** Declarations of every rule whose selector list matches. */
const rulesOf = (selectorPattern) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, selector]) => selectorPattern.test(selector))
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));

test('dialog heights follow the visible area (dvh), not only vh', () => {
  const rules = rulesOf(/\.modal(__dialog)?\b/);
  assert.ok(rules.length > 3, 'found the dialog rules');
  for (const { selector, body } of rules) {
    for (const [, prop] of body.matchAll(/(?:^|;|\n)\s*((?:max-)?height):[^;]*\b\d+vh\b/g)) {
      assert.match(body, new RegExp(`${prop}:[^;]*dvh`), `${selector}: ${prop} in vh needs a dvh twin`);
    }
  }
});

test('a dialog taller than the screen keeps its top reachable', () => {
  const modal = rulesOf(/^\s*\.modal\s*$/)[0].body;
  assert.match(modal, /overflow-y:\s*auto/, 'the backdrop scrolls');
  assert.match(modal, /align-items:\s*flex-start/, 'no centring that pushes the top above the screen');
  const dialog = rulesOf(/^\s*\.modal__dialog\s*$/)[0].body;
  assert.match(dialog, /margin:\s*auto/, 'centred by auto margins');
});

test('a tap on the backdrop closes the dialog on iPhone', () => {
  assert.match(rulesOf(/^\s*\.modal\s*$/)[0].body, /cursor:\s*pointer/, 'Safari sends click only to "clickable" elements');
  assert.match(rulesOf(/^\s*\.modal__dialog\s*$/)[0].body, /cursor:\s*auto/);
  const shell = read('public/static/ui-shell.js');
  assert.match(shell, /addEventListener\('pointerdown', \(ev\) => \{\s*pressStartedOnBackdrop =/);
  assert.doesNotMatch(shell, /addEventListener\('mousedown'/);
});

test('header: GitHub only as the icon, visible on a phone', () => {
  for (const [name, page] of [['index', html], ['lab', lab]]) {
    const nav = /<nav class="site-nav"[\s\S]*?<\/nav>/.exec(page)[0];
    assert.doesNotMatch(nav, /github\.com/, `${name}: no GitHub item in the menu`);
    assert.match(page, /<a class="header-icon-link" href="https:\/\/github\.com\/HereIamGosu\/amnezia-config-gen"/, `${name}: GitHub icon`);
  }
  assert.doesNotMatch(css, /\.header-icon-link\s*\{\s*display:\s*none/, 'the icon is not hidden on a phone');
});

test('phone: step 2 starts expanded; "Community" opens a dialog with Telegram, GitHub and Discord', () => {
  assert.doesNotMatch(/<section[^>]*id="stepParams"[\s\S]*?<\/header>/.exec(html)?.[0] || html, /data-collapse-mobile/);
  assert.doesNotMatch(html, /data-step-toggle data-collapse-mobile[^>]*aria-controls="stepParamsBody"/);
  assert.match(html, /<button type="button" class="info-card__head" data-open-modal="communityModal">/);
  const modal = /<div id="communityModal"[\s\S]*?\n {4}<\/div>\n/.exec(html)[0];
  for (const host of ['t.me/amnezia_config', 'github.com/HereIamGosu/amnezia-config-gen', 'discord.gg/']) {
    assert.ok(modal.includes(host), `community dialog links ${host}`);
  }
});
