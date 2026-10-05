// public/lab/lab-quick.js
//
// Быстрый просмотр Endpoint Lab (макеты «из генератора»): сводка + переход на /lab. Самостоятельный модуль:
// окно строится при первом открытии (не дублирует разметку страницы), данные — тем же адаптером
// LabData, модальное окно — общий UiShell. Нужны lab-core.js и lab-data.js раньше этого файла.
// Подключение на любой странице сайта: элементу-кнопке дать атрибут data-lab-quick (на главной — строка
// «Endpoint Lab» в карточке «Статус системы»).
// На странице Lab окно доступно только для локальной проверки: /lab?quick=1 на localhost.

'use strict';

(function initLabQuick(win) {
  const doc = win.document;
  const Core = win.LabCore;
  const Data = win.LabData;
  if (!Core || !Data) return;

  const MODAL_ID = 'labQuickModal';
  const PAGE_LANG = doc.documentElement.lang === 'en' ? 'en' : 'ru';
  const LAB_URL = PAGE_LANG === 'en' ? '/en/lab' : '/lab';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let strings = null;
  let source = null;
  let ticker = null;
  let lastView = null;
  let lastResult = null;

  const t = (key, vars) => {
    const raw = strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : key;
    return vars ? Core.interpolate(raw, vars) : raw;
  };

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  const icon = (id, className = 'icon') => {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = doc.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${id}`);
    svg.appendChild(use);
    return svg;
  };

  const ago = (ts, key) => {
    const span = el('span');
    span.dataset.quickAgo = String(ts);
    if (key) span.dataset.quickKey = key;
    return span;
  };

  const refreshAges = () => {
    doc.querySelectorAll(`#${MODAL_ID} [data-quick-ago]`).forEach((node) => {
      const value = Core.formatAgo(Date.now() - Number(node.dataset.quickAgo), t);
      node.textContent = node.dataset.quickKey ? t(node.dataset.quickKey, { ago: value }) : value;
    });
  };

  const ensureModal = () => {
    let modal = doc.getElementById(MODAL_ID);
    if (modal) return modal;
    modal = el('div', 'modal lab-modal lab-quick');
    modal.id = MODAL_ID;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'labQuickTitle');
    modal.setAttribute('aria-hidden', 'true');
    const dialog = el('div', 'modal__dialog lab-modal__dialog lab-modal__dialog--sm');
    dialog.appendChild(el('div', 'lab-quick__body'));
    modal.appendChild(dialog);
    doc.body.appendChild(modal);
    modal.addEventListener('modal:close', () => {
      if (ticker) win.clearInterval(ticker);
      ticker = null;
    });
    return modal;
  };

  const closeButton = () => {
    const btn = el('button', 'modal__close lab-quick__x');
    btn.type = 'button';
    btn.setAttribute('data-close-modal', '');
    btn.setAttribute('aria-label', t('close_btn_aria'));
    btn.appendChild(icon('i-x'));
    return btn;
  };

  const metricsRow = (items) => {
    const row = el('div', 'lab-quick__metrics');
    items.forEach(({ value, label, tone, iconId, code }) => {
      const card = el('div', `lab-quick__metric lab-quick__metric--${tone}`);
      const ic = el('span', `lab-metric__icon lab-metric__icon--${tone}`);
      ic.appendChild(icon(iconId));
      const text = el('div');
      text.appendChild(el('strong', 'lab-quick__value', Core.formatCount(value, PAGE_LANG)));
      if (code) text.appendChild(el('span', 'lab-quick__code', code));
      text.appendChild(el('span', 'lab-quick__label', label));
      card.append(ic, text);
      row.appendChild(card);
    });
    return row;
  };

  const qualityBlock = (s) => {
    const box = el('div', 'lab-quick__quality');
    const head = el('p', 'lab-quick__final');
    head.append(el('span', null, t('lab_quality_final')), doc.createTextNode(' '), el('strong', null, Core.formatPercent(s.finalSuccess, PAGE_LANG)));
    const bar = el('div', 'lab-stack');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', t('lab_quality_aria', {
      final: Core.formatPercent(s.finalSuccess, PAGE_LANG),
      first: Core.formatPercent(s.firstSession, PAGE_LANG),
      retry: Core.formatPercent(s.retryRescued, PAGE_LANG),
      fail: Core.formatPercent(s.failed, PAGE_LANG),
    }));
    [['first', s.firstSession], ['retry', s.retryRescued], ['fail', s.failed]].forEach(([k, v]) => {
      const seg = el('span', `lab-stack__seg lab-stack__seg--${k}`);
      seg.style.flexGrow = String(v);
      bar.appendChild(seg);
    });
    const legend = el('ul', 'lab-legend');
    [['first', s.firstSession, 'lab_quality_first'], ['retry', s.retryRescued, 'lab_quality_retry'], ['fail', s.failed, 'lab_quality_fail']].forEach(([k, v, key]) => {
      const li = el('li', 'lab-legend__item');
      li.append(el('span', `lab-legend__dot lab-legend__dot--${k}`), el('strong', null, Core.formatPercent(v, PAGE_LANG)), el('span', null, t(key)));
      legend.appendChild(li);
    });
    box.append(head, bar, legend);
    return box;
  };

  const note = (text, iconId = 'i-info') => {
    const p = el('p', 'lab-state-card__note');
    p.append(icon(iconId, 'icon icon--sm'), el('span', null, text));
    return p;
  };

  const actions = (buttons) => {
    const box = el('div', 'lab-quick__actions');
    buttons.forEach((b) => box.appendChild(b));
    return box;
  };

  const openLabLink = () => {
    const a = el('a', 'btn btn--blue btn--block lab-quick__cta');
    a.href = LAB_URL;
    a.append(el('span', null, t('lab_quick_open')), icon('i-arrow-right', 'icon icon--sm'));
    return a;
  };

  const plainButton = (key, className = 'btn btn--block') => {
    const b = el('button', className, t(key));
    b.type = 'button';
    b.setAttribute('data-close-modal', '');
    return b;
  };

  const STATE_ICON = { degraded: 'i-alert', unavailable: 'i-x-circle', stale: 'i-clock', empty: 'i-layers' };

  const render = () => {
    const modal = ensureModal();
    const body = modal.querySelector('.lab-quick__body');
    body.textContent = '';
    const view = lastView;
    const state = view ? Core.deriveLabState(view, Date.now()) : (lastResult ? lastResult.kind : 'loading');
    modal.dataset.state = state;

    if (state === 'ok') {
      const head = el('header', 'lab-quick__head');
      head.append(el('h2', 'lab-quick__title', 'Endpoint Lab'), closeButton());
      head.querySelector('h2').id = 'labQuickTitle';
      const status = el('div', 'lab-quick__status');
      const ok = el('span', 'lab-chip lab-chip--ok');
      ok.append(el('span', 'lab-chip__dot'), el('span', 'lab-chip__text', t('lab_quick_status_ok')));
      status.append(ok, ago(view.generatedAt, 'lab_quick_checked'));
      const counts = view.counts || {};
      body.append(head, status, metricsRow([
        { value: Core.freshActiveCount(view, Date.now()), label: t('lab_quick_metric_active'), tone: 'green', iconId: 'i-layers', code: 'ACTIVE' },
        { value: counts.verified, label: t('lab_state_VERIFIED'), tone: 'blue', iconId: 'i-database' },
        { value: counts.suspect, label: t('lab_state_SUSPECT'), tone: 'yellow', iconId: 'i-database' },
      ]));
      if (view.sessions) body.appendChild(qualityBlock(view.sessions));
      body.appendChild(note(t('lab_disclaimer')));
      body.appendChild(actions([openLabLink(), plainButton('lab_quick_close')]));
    } else {
      const card = el('div', `lab-state-card lab-state-card--${state}`);
      const ic = el('span', 'lab-state-card__icon');
      ic.appendChild(icon(STATE_ICON[state] || 'i-info', 'icon icon--lg'));
      const text = el('div', 'lab-state-card__body');
      const title = el('h2', 'lab-state-card__title', t(`lab_state_${state}_title`));
      title.id = 'labQuickTitle';
      const p = el('p', 'lab-state-card__text');
      if (state === 'stale' && view.freshness && view.freshness.lastSuccessAt !== null) p.appendChild(ago(view.freshness.lastSuccessAt, 'lab_state_stale_text'));
      else p.textContent = t(`lab_state_${state}_text`);
      text.append(title, p);
      card.append(ic, text, closeButton());
      body.appendChild(card);
      if (view && (state === 'degraded' || state === 'stale')) {
        const counts = view.counts || {};
        const fresh = Core.freshActiveCount(view, Date.now());
        body.appendChild(metricsRow([
          { value: fresh, label: 'ACTIVE', tone: 'green', iconId: 'i-layers' },
          { value: counts.verified, label: t('lab_metric_verified'), tone: 'blue', iconId: 'i-database' },
          state === 'stale'
            ? { value: counts.active - (fresh || 0), label: t('lab_metric_outdated'), tone: 'red', iconId: 'i-database' }
            : { value: counts.suspect, label: t('lab_metric_suspect'), tone: 'yellow', iconId: 'i-database' },
        ]));
        const updated = el('p', 'lab-quick__updated');
        updated.append(icon('i-info', 'icon icon--sm'), el('span', null, `${t('lab_updated_label')} `), ago(view.generatedAt));
        body.appendChild(updated);
      }
      if (state === 'unavailable' || state === 'empty') body.appendChild(note(t('lab_note_hostname')));
      const buttons = [];
      if (state === 'stale' && source && source.connected) {
        const refresh = el('button', 'btn btn--blue', t('lab_refresh'));
        refresh.type = 'button';
        refresh.addEventListener('click', load);
        buttons.push(refresh);
      } else if (state === 'degraded') {
        buttons.push(openLabLink());
      }
      buttons.push(plainButton('lab_ok', state === 'unavailable' || state === 'empty' ? 'btn btn--blue' : 'btn'));
      body.appendChild(actions(buttons));
    }
    refreshAges();
  };

  async function load() {
    const result = await source.loadOverview();
    lastResult = result;
    if (result.kind === 'ok') lastView = result.view;
    render();
  }

  // Стили окна — в lab.css: на странице Lab он уже подключён, на других страницах подгружается при первом
  // открытии (все его правила привязаны к классам Lab, __tests__/lab-entry.test.js). Окно открывается
  // после загрузки стилей, но ждёт их не дольше STYLES_TIMEOUT_MS.
  const LAB_CSS = '/lab/lab.css';
  const STYLES_TIMEOUT_MS = 3000;
  let stylesReady = null;

  const ensureStyles = () => {
    if (stylesReady) return stylesReady;
    if (doc.querySelector(`link[rel="stylesheet"][href="${LAB_CSS}"]`)) {
      stylesReady = Promise.resolve();
      return stylesReady;
    }
    stylesReady = new Promise((resolve) => {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = LAB_CSS;
      link.addEventListener('load', resolve);
      link.addEventListener('error', resolve);
      win.setTimeout(resolve, STYLES_TIMEOUT_MS);
      doc.head.appendChild(link);
    });
    return stylesReady;
  };

  const loadStrings = async () => {
    if (strings) return;
    try {
      const res = await fetch(`/locales/${PAGE_LANG}.json`);
      strings = res.ok ? await res.json() : {};
    } catch {
      strings = {};
    }
  };

  // data-lab-quick="off": страница уже знает, что файлов Lab на этом развёртывании нет (/api/status,
  // lab.available) — окно сразу говорит «не подключён», без запроса, на который /api/lab ответил бы 503.
  const open = async (opener, { fixture = null, fixtures = null } = {}) => {
    if (!win.UiShell) return;
    await Promise.all([loadStrings(), ensureStyles()]);
    if (!source) source = Data.createLabSource({ fetchImpl: win.fetch.bind(win), fixture, fixtures });
    const offline = !!(opener && opener.dataset && opener.dataset.labQuick === 'off');
    lastResult = { kind: 'loading' };
    render();
    win.UiShell.openModal(MODAL_ID, opener || null);
    if (offline || !source.connected) {
      lastView = null;
      lastResult = { kind: 'not-connected' };
      render();
    } else {
      await load();
    }
    if (ticker) win.clearInterval(ticker);
    ticker = win.setInterval(refreshAges, 1000);
  };

  doc.addEventListener('click', (ev) => {
    const trigger = ev.target.closest && ev.target.closest('[data-lab-quick]');
    if (!trigger) return;
    ev.preventDefault();
    open(trigger);
  });

  win.LabQuick = Object.freeze({ open });
})(window);
