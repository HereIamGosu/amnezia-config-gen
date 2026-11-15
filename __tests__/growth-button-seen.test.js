// Growth iteration 3 (2026-11): generate_button_seen says whether a visitor ever had the generate button on screen.
// About a fifth of new visitors never start a generation, and the button sits below the first screen on phones and
// desktops alike; the event separates "did not reach the button" from "saw it and left".
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { describe, test } = require('node:test');

const { trackEvent } = require('../public/static/analytics');
const { readAppScript } = require('./helpers/frontend-scripts');

const script = readAppScript('script.js');

const withYm = (fn) => {
  const calls = [];
  global.ym = (...args) => calls.push(args);
  try {
    fn();
  } finally {
    delete global.ym;
  }
  return calls;
};

/** watchGenerateButtonSeen из script.js в песочнице с подставным IntersectionObserver и telemetry. */
const loadWatcher = ({ withObserver = true } = {}) => {
  const source = script.match(/const watchGenerateButtonSeen = \(button\) => \{[\s\S]*?\n\};/);
  assert.ok(source, 'watchGenerateButtonSeen is defined in script.js');
  const events = [];
  const observers = [];
  class FakeObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = [];
      this.disconnected = false;
      observers.push(this);
    }

    observe(el) { this.observed.push(el); }

    disconnect() { this.disconnected = true; }

    /** Браузер после disconnect() записи не доставляет. */
    emit(isIntersecting) {
      if (!this.disconnected) this.callback([{ isIntersecting }]);
    }
  }
  const sandbox = { telemetry: { trackEvent: (name, payload) => events.push([name, payload]) } };
  if (withObserver) sandbox.IntersectionObserver = FakeObserver;
  vm.runInNewContext(`${source[0]}\nthis.watch = watchGenerateButtonSeen;`, sandbox);
  return { watch: sandbox.watch, events, observers };
};

describe('generate_button_seen', () => {
  test('passes the allowlist and carries no parameters, whatever the caller hands over', () => {
    const calls = withYm(() => {
      assert.equal(trackEvent('generate_button_seen'), true);
      assert.equal(trackEvent('generate_button_seen', { url: 'https://awgconfig.com/?profile=awg31', text: 'x' }), true);
    });
    assert.deepEqual(calls, [
      [99328227, 'reachGoal', 'generate_button_seen', {}],
      [99328227, 'reachGoal', 'generate_button_seen', {}],
    ]);
  });

  test('is sent once, when at least half of the button is on screen', () => {
    const { watch, events, observers } = loadWatcher();
    const button = { id: 'generateButton' };
    watch(button);
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].observed, [button]);
    assert.equal(observers[0].options.threshold, 0.5);

    observers[0].emit(false);
    assert.deepEqual(events, [], 'the first callback of an observer reports a button below the screen: no event');
    observers[0].emit(true);
    assert.deepEqual(events, [['generate_button_seen', undefined]]);
    assert.equal(observers[0].disconnected, true);
    observers[0].emit(true);
    assert.equal(events.length, 1, 'scrolling away and back does not send it again');
  });

  test('a browser without IntersectionObserver sends nothing and does not throw', () => {
    const { watch, events } = loadWatcher({ withObserver: false });
    assert.doesNotThrow(() => watch({ id: 'generateButton' }));
    assert.deepEqual(events, []);
  });

  test('the watcher starts with the page, on the generate button itself', () => {
    const wiring = script.slice(script.indexOf('document.addEventListener(\'DOMContentLoaded\''));
    assert.match(wiring, /const generateButton = document\.getElementById\('generateButton'\);\s*if \(generateButton\) \{[^}]*watchGenerateButtonSeen\(generateButton\);/);
    assert.equal(script.match(/watchGenerateButtonSeen\(/g).length, 1, 'one call: one event per page load');
    assert.equal(script.match(/trackEvent\('generate_button_seen'/g).length, 1);
  });
});
