// e2e/design-floor.e2e.js — нижняя планка вёрстки и доступности (дефекты аудита 3.0.2): подписи Lab не
// наезжают и не рвут слово, бейджи профилей читаемы на телефоне, индикаторы загрузки живут при
// prefers-reduced-motion, skip-link контрастен при наведении, цвет события Lab совпадает с его точкой.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { e2eSuite, fixtures } = require('./lib/harness');

/** Контраст WCAG двух цветов из getComputedStyle (rgb/rgba, фон непрозрачный). */
const contrastOf = (fg, bg) => {
  const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [l1, l2] = [lum(parse(fg)), lum(parse(bg))].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
};

/** Пункты легенды «Качество проверок»: подпись помещается в свой пункт, пункты не пересекаются. */
const legendGeometry = () => Array.from(document.querySelectorAll('#labQualityLegend .lab-legend__item')).map((li) => {
  const label = li.querySelector('span:last-child');
  const item = li.getBoundingClientRect();
  return {
    text: label.textContent,
    overflow: label.scrollWidth - label.clientWidth,
    left: Math.round(item.left),
    right: Math.round(item.right),
    labelRight: Math.round(label.getBoundingClientRect().right),
  };
});

/**
 * Подписи плиток сводки Lab: каждый кусок слова (между пробелами и мягкими переносами) стоит на одной
 * строке — первая и последняя буквы куска на одной высоте. Слово, разорванное посреди без дефиса, даёт
 * кусок на двух строках. Диапазон буквы сразу после мягкого переноса захватывает и нарисованный дефис
 * предыдущей строки, поэтому строка буквы — по её последнему прямоугольнику (сама буква).
 */
const brokenWords = () => {
  const broken = [];
  const lineOf = (node, i) => {
    const range = document.createRange();
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const rects = range.getClientRects();
    return Math.round(rects[rects.length - 1].top);
  };
  for (const label of document.querySelectorAll('.lab-metric__label')) {
    const node = label.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    for (const m of node.nodeValue.matchAll(/[^\s\u00ad]+/g)) {
      if (lineOf(node, m.index) !== lineOf(node, m.index + m[0].length - 1)) broken.push(`${label.textContent} → "${m[0]}"`);
    }
  }
  return broken;
};

e2eSuite('design floor', (openPage) => {
  test('Lab summary: quality legend labels fit their items and tile labels never split a word', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    for (const lab of ['/lab', '/en/lab']) {
      for (const width of [1440, 1280, 1024, 768]) {
        const at = `${lab} ${width}px`;
        await page.viewport(width, 900);
        await page.goto(`${lab}?fixture=healthy`, { app: false });
        await page.waitFor(() => document.getElementById('labQualityFinal').textContent === '98%', { message: 'quality rendered' });
        const items = await page.evaluate(legendGeometry);
        assert.equal(items.length, 3, `${at}: three legend items`);
        for (const it of items) {
          assert.ok(it.overflow <= 1, `${at}: "${it.text}" overflows its item by ${it.overflow}px`);
          assert.ok(it.labelRight <= it.right + 1, `${at}: "${it.text}" sticks out of its item`);
        }
        // Пункты в одной строке не пересекаются (перенос на следующую строку допустим)
        for (let i = 1; i < items.length; i += 1) {
          const prev = items[i - 1];
          const cur = items[i];
          if (cur.left > prev.left) assert.ok(prev.right <= cur.left, `${at}: "${prev.text}" overlaps "${cur.text}"`);
        }
        assert.deepEqual(await page.evaluate(brokenWords), [], `${at}: a tile label splits a word mid-way`);
      }
    }
    await page.assertClean('/lab legend');
  });

  test('Lab activity: the action word takes the colour of its event dot', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    await page.goto('/lab?fixture=healthy', { app: false });
    await page.waitFor(() => document.querySelectorAll('#labActivityList .lab-event').length > 0, { message: 'events rendered' });
    const tones = await page.evaluate(() => {
      const resolve = (name) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${name})`;
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      };
      const out = {};
      for (const tone of ['ok', 'warn', 'error']) {
        const action = document.querySelector(`#labActivityList .lab-event__action--${tone}`);
        out[tone] = action ? getComputedStyle(action).color : null;
      }
      return { ...out, expected: { ok: resolve('--lab-ok'), warn: resolve('--lab-warn'), error: resolve('--lab-error') } };
    });
    for (const tone of ['ok', 'warn', 'error']) {
      if (tones[tone] === null) continue; // фикстура может не содержать события этого тона
      assert.equal(tones[tone], tones.expected[tone], `${tone} action colour`);
    }
    assert.ok(tones.ok && tones.error, 'the healthy fixture has restored and excluded events');
    assert.notEqual(tones.ok, tones.error, 'a restored and an excluded event look different');
    await page.assertClean('/lab events');
  });

  test('phone: profile badges are at least 11px and stay inside their card', async () => {
    for (const width of [320, 360]) {
      const page = await openPage({ width, height: 800, mobile: true });
      await page.goto('/');
      const tags = await page.evaluate(() => Array.from(document.querySelectorAll('.profile-card__head .tag')).map((tag) => {
        const card = tag.closest('.profile-card').getBoundingClientRect();
        const r = tag.getBoundingClientRect();
        return { text: tag.textContent.trim(), size: parseFloat(getComputedStyle(tag).fontSize), inside: r.right <= card.right + 0.5 };
      }));
      assert.ok(tags.length >= 4, `${width}px: profile badges present`);
      for (const tag of tags) {
        assert.ok(tag.size >= 11, `${width}px: badge "${tag.text}" is ${tag.size}px`);
        assert.ok(tag.inside, `${width}px: badge "${tag.text}" leaves its card`);
      }
      await page.assertClean(`/ ${width}px badges`);
      await page.close();
    }
  });

  test('prefers-reduced-motion: decorative motion stops, loading indicators keep turning', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.goto('/');
    page.route((u) => u.pathname === '/api/warp', () => ({ delayMs: 1500, json: fixtures.warpSuccess() }));
    await page.click('#generateButton');
    await page.waitFor(() => document.getElementById('generateButton').classList.contains('btn--loading'), { message: 'loading state' });
    const motion = await page.evaluate(() => {
      const spinner = getComputedStyle(document.getElementById('generateButton'), '::after');
      const hero = getComputedStyle(document.querySelector('.hero-art'));
      return {
        spinName: spinner.animationName,
        spinCount: spinner.animationIterationCount,
        spinDuration: parseFloat(spinner.animationDuration),
        heroDuration: parseFloat(hero.animationDuration),
      };
    });
    assert.equal(motion.spinName, 'spin');
    assert.equal(motion.spinCount, 'infinite', 'the generate spinner keeps turning');
    assert.ok(motion.spinDuration >= 1, `the spinner turns slowly, got ${motion.spinDuration}s`);
    assert.ok(motion.heroDuration < 0.01, 'decorative hero float is stopped');

    // Все правила со spin/pulse вне медиа-запросов (индикаторы загрузки) исключены из общего гашения
    const uncovered = await page.evaluate(() => {
      const loaders = [];
      let exempt = '';
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (rule.selectorText && /\b(spin|pulse)\b/.test(rule.style.animationName || '')) loaders.push(rule.selectorText);
          if (rule.media && /prefers-reduced-motion/.test(rule.media.mediaText)) {
            for (const inner of rule.cssRules) {
              if (inner.selectorText && inner.style.animationIterationCount === 'infinite') exempt += `,${inner.selectorText}`;
            }
          }
        }
      }
      const exemptList = exempt.split(',').map((s) => s.trim()).filter(Boolean);
      return loaders.filter((sel) => sel.split(',').some((s) => !exemptList.includes(s.trim())));
    });
    assert.deepEqual(uncovered, [], 'every loading indicator stays animated under reduced motion');
    await page.assertClean('reduced motion');
  });

  test('skip link: readable on hover while focused', async () => {
    const page = await openPage({ width: 1440, height: 900 });
    await page.goto('/');
    await page.press('Tab');
    const point = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !el.classList.contains('skip-link')) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    assert.ok(point, 'Tab focuses the skip link first');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    const colours = await page.evaluate(() => {
      const el = document.querySelector('.skip-link');
      const s = getComputedStyle(el);
      return { fg: s.color, bg: s.backgroundColor, hovered: el.matches(':hover') };
    });
    assert.equal(colours.hovered, true, 'the pointer is over the skip link');
    const ratio = contrastOf(colours.fg, colours.bg);
    assert.ok(ratio >= 4.5, `skip link contrast on hover ${ratio.toFixed(2)}:1 (${colours.fg} on ${colours.bg})`);
    await page.assertClean('skip link');
  });
});
