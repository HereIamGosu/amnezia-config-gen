// public/lab/lab.js
//
// Страница Endpoint Lab (/lab, /en/lab): только чтение. Данные — через LabData (единственный адаптер),
// логика и проверка — LabCore, модальные окна и мобильное меню — общий UiShell сайта.
// Строки сети попадают в DOM только через textContent / атрибуты: никакого innerHTML.
// Опрос данных (раз в 30 с) и обновление подписей «… назад» (раз в секунду) — разные процессы.

'use strict';

(function initLabPage(win) {
  const doc = win.document;
  const Core = win.LabCore;
  const Data = win.LabData;
  if (!Core || !Data) return;

  const PAGE_LANG = doc.documentElement.lang === 'en' ? 'en' : 'ru';
  const LANG_PATHS = { ru: '/lab', en: '/en/lab' };
  const MOBILE_QUERY = '(max-width: 760px)';
  const PAGE_SIZE_DESKTOP = 25;
  const PAGE_SIZE_MOBILE = 10;
  const ACTIVITY_PREVIEW = 4;
  const CHANGE_HIGHLIGHT_MS = 2500;
  const GENERATOR_HISTORY_KEY = 'awg_history';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── Язык: адрес задаёт язык страницы, явный выбор посетителя — localStorage 'lang' (как у генератора) ──

  const readSavedLang = () => {
    try {
      const saved = win.localStorage.getItem('lang');
      return saved === 'ru' || saved === 'en' ? saved : null;
    } catch {
      return null;
    }
  };

  const goToLang = (lang, replace) => {
    const url = LANG_PATHS[lang] + win.location.search + win.location.hash;
    if (replace) win.location.replace(url);
    else win.location.assign(url);
  };

  const savedLang = readSavedLang();
  if (savedLang && savedLang !== PAGE_LANG) {
    goToLang(savedLang, true);
    return;
  }

  let strings = {};
  const t = (key, vars) => {
    const raw = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : key;
    return vars ? Core.interpolate(raw, vars) : raw;
  };

  const applyStaticTranslations = () => {
    const each = (attr, fn) => doc.querySelectorAll(`[${attr}]`).forEach((node) => {
      const key = node.getAttribute(attr);
      if (Object.prototype.hasOwnProperty.call(strings, key)) fn(node, strings[key]);
    });
    each('data-i18n', (node, v) => { node.textContent = v; });
    each('data-i18n-aria-label', (node, v) => node.setAttribute('aria-label', v));
    each('data-i18n-title', (node, v) => node.setAttribute('title', v));
    each('data-i18n-placeholder', (node, v) => node.setAttribute('placeholder', v));
    each('data-i18n-alt', (node, v) => node.setAttribute('alt', v));
  };

  const loadStrings = async () => {
    try {
      const res = await fetch(`/locales/${PAGE_LANG}.json`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data === 'object') strings = data;
    } catch {
      // Без словаря остаются тексты из HTML; динамические подписи покажут ключи.
    }
  };

  // ── DOM-помощники ──────────────────────────────────────────────

  const $ = (id) => doc.getElementById(id);

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  const svgEl = (tag, attrs) => {
    const node = doc.createElementNS(SVG_NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  const icon = (id, className = 'icon icon--sm') => {
    const svg = svgEl('svg', { class: className, 'aria-hidden': 'true' });
    svg.appendChild(svgEl('use', { href: `#${id}` }));
    return svg;
  };

  const setText = (node, text) => {
    if (node && node.textContent !== text) node.textContent = text;
  };

  /** Шаблон «Endpoint {endpoint} {action}» → узлы: текст шаблона + готовые элементы вместо плейсхолдеров. */
  const fillTemplate = (target, template, parts) => {
    target.textContent = '';
    for (const piece of String(template).split(/(\{\w+\})/)) {
      const m = /^\{(\w+)\}$/.exec(piece);
      if (m && parts[m[1]] !== undefined) {
        const part = parts[m[1]];
        target.appendChild(typeof part === 'string' ? doc.createTextNode(part) : part);
      } else if (piece) {
        target.appendChild(doc.createTextNode(piece));
      }
    }
    return target;
  };

  const now = () => Date.now();

  // Подписи «… назад» / «ещё …» обновляет тикер раз в секунду, без запросов к API.
  const bindAgo = (node, ts, { mode = 'ago', key = null } = {}) => {
    if (ts === null || ts === undefined) {
      delete node.dataset.agoTs;
      setText(node, '—');
      return node;
    }
    node.dataset.agoTs = String(ts);
    node.dataset.agoMode = mode;
    if (key) node.dataset.agoKey = key;
    else delete node.dataset.agoKey;
    renderAgo(node);
    return node;
  };

  function renderAgo(node) {
    const ts = Number(node.dataset.agoTs);
    if (!Number.isFinite(ts)) return;
    const value = node.dataset.agoMode === 'left' ? Core.formatLeft(ts - now(), t) : Core.formatAgo(now() - ts, t);
    setText(node, node.dataset.agoKey ? t(node.dataset.agoKey, { ago: value }) : value);
  }

  // ── Подписи перечислений ──────────────────────────────────────

  const STATE_TONE = {
    ACTIVE: 'ok', VERIFIED: 'info', SUSPECT: 'warn', QUARANTINE: 'error', DEAD: 'dead',
    DISCOVERED: 'cyan', CHECKING: 'cyan', EXPIRED: 'muted', UNKNOWN: 'muted',
  };
  const stateLabel = (s) => t(`lab_state_${s}`);
  const stateLongLabel = (s) => t(`lab_state_long_${s}`);
  const sourceLabel = (s) => (s ? t(`lab_source_${s}`) : '—');

  const stateChip = (state, { long = false } = {}) => {
    const chip = el('span', `lab-chip lab-chip--${STATE_TONE[state] || 'muted'}`);
    chip.appendChild(el('span', 'lab-chip__dot'));
    chip.appendChild(el('span', 'lab-chip__text', long ? stateLongLabel(state) : stateLabel(state)));
    return chip;
  };

  // ── Состояние страницы ─────────────────────────────────────────

  const ui = {
    view: null,
    issues: [],
    labState: 'loading',
    lastResult: null,
    receivedAt: null,
    chartRange: '6h',
    filters: { query: '', state: 'all', port: 'all', source: 'all' },
    sort: null,
    order: new Map(),
    visible: 0,
    prevStates: new Map(),
    changedUntil: new Map(),
    detailsId: null,
    detailsView: null,
    historyRange: 'all',
    historyId: null,
    mobile: win.matchMedia ? win.matchMedia(MOBILE_QUERY).matches : false,
  };
  const pageSize = () => (ui.mobile ? PAGE_SIZE_MOBILE : PAGE_SIZE_DESKTOP);
  ui.visible = pageSize();

  const fixtureName = Core.fixtureFromLocation(win.location.search, win.location.hostname);
  let source = null;
  let poller = null;

  // ── Hero: карточка состояния Lab ───────────────────────────────

  const STATE_CARD = {
    loading: { tone: 'loading', icon: null },
    'not-connected': { tone: 'info', icon: 'i-info' },
    error: { tone: 'error', icon: 'i-x-circle', retry: true },
    malformed: { tone: 'error', icon: 'i-alert', retry: true },
    nodata: { tone: 'info', icon: 'i-info' },
    ok: { tone: 'ok', icon: null, note: 'ok' },
    degraded: { tone: 'warn', icon: 'i-alert' },
    unavailable: { tone: 'error', icon: 'i-x-circle', note: 'hostname' },
    stale: { tone: 'warn', icon: 'i-clock', retry: true },
    empty: { tone: 'muted', icon: 'i-layers', note: 'hostname' },
  };

  const renderStatusCard = () => {
    const state = ui.labState;
    const spec = STATE_CARD[state] || STATE_CARD.nodata;
    const card = $('labStatus');
    card.dataset.tone = spec.tone;
    const iconBox = $('labStatusIcon');
    iconBox.textContent = '';
    if (spec.icon) iconBox.appendChild(icon(spec.icon, 'icon'));
    else iconBox.appendChild(el('span', `dot ${spec.tone === 'loading' ? 'dot--loading' : 'dot--ok'}`));

    setText($('labStatusTitle'), t(`lab_state_${state}_title`));
    $('labStatusTitle').removeAttribute('data-i18n');

    const textNode = $('labStatusText');
    const view = ui.view;
    if (state === 'stale' && view && view.freshness && view.freshness.lastSuccessAt !== null) {
      bindAgo(textNode, view.freshness.lastSuccessAt, { key: 'lab_state_stale_text' });
    } else if (state === 'error' && ui.lastResult && ui.lastResult.status) {
      delete textNode.dataset.agoTs;
      setText(textNode, t('lab_state_error_text_http', { status: ui.lastResult.status }));
    } else {
      delete textNode.dataset.agoTs;
      setText(textNode, t(`lab_state_${state}_text`));
    }

    const updated = $('labStatusUpdated');
    updated.textContent = '';
    if (view && !['loading', 'not-connected'].includes(state)) {
      updated.appendChild(el('span', 'lab-status__updated-label', t('lab_updated_label')));
      updated.appendChild(doc.createTextNode(' '));
      updated.appendChild(bindAgo(el('span'), view.generatedAt));
      updated.hidden = false;
    } else {
      updated.hidden = true;
    }

    // «В пуле есть свежие endpoint'ы» — только когда их число доказано (список или счётчики), а не неизвестно.
    const noteKind = spec.note === 'ok' && !(view && Core.freshActiveCount(view, now()) > 0) ? null : spec.note;
    const note = $('labStatusNote');
    note.hidden = !noteKind;
    if (noteKind) {
      note.dataset.kind = noteKind;
      const noteIcon = note.querySelector('.lab-status__note-icon');
      noteIcon.textContent = '';
      noteIcon.appendChild(icon(noteKind === 'ok' ? 'i-arrow-down-circle' : 'i-info', 'icon'));
      setText($('labStatusNoteTitle'), noteKind === 'ok' ? t('lab_note_ok_title') : '');
      $('labStatusNoteTitle').hidden = noteKind !== 'ok';
      setText($('labStatusNoteText'), noteKind === 'ok' ? t('lab_note_ok_text') : t('lab_note_hostname'));
    }
    $('labStatusActions').hidden = !(spec.retry && source && source.connected);
  };

  // ── Предупреждение под hero: частичные данные, ошибка обновления ──

  const renderAlert = () => {
    const alert = $('labAlert');
    const r = ui.lastResult;
    alert.textContent = '';
    let text = null;
    let tone = 'warn';
    if (ui.view && r && r.kind !== 'ok') {
      text = t(r.kind === 'malformed' ? 'lab_alert_refresh_malformed' : 'lab_alert_refresh_failed');
    } else if (ui.view && ui.issues.some((i) => !i.startsWith('endpoints:dropped') && !i.endsWith(':missing'))) {
      text = t('lab_alert_partial');
      tone = 'info';
    }
    alert.hidden = !text;
    if (!text) return;
    alert.dataset.tone = tone;
    alert.appendChild(icon(tone === 'info' ? 'i-info' : 'i-alert'));
    const span = el('span');
    if (ui.view && r && r.kind !== 'ok' && ui.receivedAt) {
      fillTemplate(span, text, { ago: bindAgo(el('span'), ui.receivedAt) });
    } else {
      span.textContent = text;
    }
    alert.appendChild(span);
  };

  // ── Метрики, свежесть, качество ────────────────────────────────

  const renderMetrics = () => {
    const view = ui.view;
    const counts = view && view.counts;
    const stale = ui.labState === 'stale';
    const fresh = view ? Core.freshActiveCount(view, now()) : null;
    const setMetric = (name, value, labelKey) => {
      const card = doc.querySelector(`[data-metric="${name}"]`);
      const valueNode = card.querySelector('[data-value]');
      valueNode.classList.remove('lab-skel');
      valueNode.classList.toggle('lab-metric__value--none', !Number.isInteger(value));
      setText(valueNode, Core.formatCount(value, PAGE_LANG));
      const label = card.querySelector('[data-label]');
      label.dataset.i18n = labelKey;
      setText(label, t(labelKey));
    };
    setMetric('active', fresh, 'lab_metric_active');
    setMetric('verified', counts ? counts.verified : null, 'lab_metric_verified');
    if (stale && counts && fresh !== null && counts.active > fresh) {
      setMetric('suspect', counts.active - fresh, 'lab_metric_outdated');
    } else {
      setMetric('suspect', counts ? counts.suspect : null, 'lab_metric_suspect');
    }
    setMetric('quarantine', counts ? counts.quarantine : null, 'lab_metric_quarantine');
    $('labMetrics').dataset.tone = ui.labState;
  };

  const renderFreshness = () => {
    const f = ui.view && ui.view.freshness;
    const put = (id, ts) => {
      const node = $(id);
      node.textContent = '';
      node.appendChild(bindAgo(el('span'), f ? ts : null));
    };
    put('labFreshLast', f && f.lastSuccessAt);
    put('labFreshOldest', f && f.oldestActiveVerifiedAt);
    const windowNode = $('labFreshWindow');
    windowNode.textContent = '';
    windowNode.appendChild(el('span', null, f && f.activeTtlSec ? t('lab_fresh_window_value', { span: Core.formatSpan(f.activeTtlSec, t) }) : '—'));
    doc.querySelector('.lab-fresh').dataset.tone = ui.labState;
  };

  const renderQuality = () => {
    const s = ui.view && ui.view.sessions;
    setText($('labQualityFinal'), s ? Core.formatPercent(s.finalSuccess, PAGE_LANG) : '—');
    $('labQualityFinal').dataset.tone = !s ? 'none' : s.finalSuccess >= 0.9 ? 'ok' : s.finalSuccess >= 0.7 ? 'warn' : 'error';
    const bar = $('labQualityBar');
    const segs = bar.querySelectorAll('.lab-stack__seg');
    const parts = s ? [s.firstSession, s.retryRescued, s.failed] : [0, 0, 0];
    segs.forEach((seg, i) => { seg.style.flexGrow = String(parts[i]); });
    bar.classList.toggle('lab-stack--empty', !s);
    bar.setAttribute('aria-label', s ? t('lab_quality_aria', {
      final: Core.formatPercent(s.finalSuccess, PAGE_LANG),
      first: Core.formatPercent(s.firstSession, PAGE_LANG),
      retry: Core.formatPercent(s.retryRescued, PAGE_LANG),
      fail: Core.formatPercent(s.failed, PAGE_LANG),
    }) : t('lab_no_data'));
    const legend = $('labQualityLegend');
    setText(legend.querySelector('[data-q="first"]'), s ? Core.formatPercent(s.firstSession, PAGE_LANG) : '—');
    setText(legend.querySelector('[data-q="retry"]'), s ? Core.formatPercent(s.retryRescued, PAGE_LANG) : '—');
    setText(legend.querySelector('[data-q="fail"]'), s ? Core.formatPercent(s.failed, PAGE_LANG) : '—');
    // Основание долей: 100% из трёх проверок и из трёхсот выглядят одинаково без числа.
    const basis = $('labQualityBasis');
    const n = s && s.window === '15m' ? s.samples : null;
    basis.hidden = n === null;
    setText(basis, n === null ? '' : Core.plural(PAGE_LANG, n, {
      one: t('lab_quality_basis_one', { n: Core.formatCount(n, PAGE_LANG) }),
      few: t('lab_quality_basis_few', { n: Core.formatCount(n, PAGE_LANG) }),
      many: t('lab_quality_basis_many', { n: Core.formatCount(n, PAGE_LANG) }),
      other: t('lab_quality_basis_other', { n: Core.formatCount(n, PAGE_LANG) }),
    }));
  };

  // ── График ACTIVE (SVG, без библиотек) ─────────────────────────

  /** Верх шкалы = 4 целых «круглых» шага (1, 2, 3, 5 × 10ⁿ) с запасом над максимумом: подписи без дробей. */
  const niceMax = (value) => {
    const raw = Math.max(1, value + 1) / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 3, 5, 10].map((k) => k * mag).find((s) => s >= raw && Number.isInteger(s)) || Math.ceil(raw);
    return step * 4;
  };

  const TICK_STEP = { '1h': 10 * 60e3, '6h': 3600e3, '24h': 4 * 3600e3 };

  const renderChart = () => {
    const frame = $('labChartFrame');
    const range = ui.chartRange;
    setText($('labChartSub'), t(`lab_chart_sub_${range}`));
    $('labChartSub').dataset.i18n = `lab_chart_sub_${range}`;
    frame.textContent = '';
    const summary = $('labChartSummary');
    const history = ui.view && ui.view.activeHistory;
    const until = now();
    const from = until - Core.CHART_RANGES[range];
    const points = history ? history.filter((p) => p.at >= from) : [];
    if (!ui.view || !history || points.length < 2) {
      const key = !ui.view ? 'lab_no_data' : !history ? 'lab_chart_unavailable' : 'lab_chart_no_points';
      frame.appendChild(el('p', 'lab-empty lab-empty--chart', t(key)));
      frame.removeAttribute('tabindex');
      setText(summary, t(key));
      return;
    }

    const width = Math.max(280, Math.round(frame.clientWidth || 600));
    const height = ui.mobile ? 180 : 190;
    const pad = { top: 10, right: 12, bottom: 26, left: 30 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const max = niceMax(Math.max(...points.map((p) => p.active)));
    const x = (at) => pad.left + ((at - from) / (until - from)) * innerW;
    const y = (v) => pad.top + innerH - (v / max) * innerH;

    const svg = svgEl('svg', { class: 'lab-chart__svg', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-labelledby': 'labChartSummary' });
    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'labChartFill', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#3b82f6', 'stop-opacity': 0.42 }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#3b82f6', 'stop-opacity': 0.02 }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    const grid = svgEl('g', { class: 'lab-chart__grid' });
    for (let i = 0; i <= 4; i += 1) {
      const v = (max / 4) * i;
      grid.appendChild(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
      const label = svgEl('text', { x: pad.left - 8, y: y(v) + 4, 'text-anchor': 'end' });
      label.textContent = String(Math.round(v));
      grid.appendChild(label);
    }
    const step = TICK_STEP[range];
    for (let tick = Math.ceil(from / step) * step; tick <= until; tick += step) {
      const label = svgEl('text', { x: x(tick), y: height - 6, 'text-anchor': 'middle' });
      label.textContent = Core.formatClock(tick);
      grid.appendChild(label);
    }
    svg.appendChild(grid);

    const coords = points.map((p) => [x(p.at), y(p.active)]);
    const line = coords.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
    const baseY = y(0);
    svg.appendChild(svgEl('path', { class: 'lab-chart__area', d: `${line}L${coords[coords.length - 1][0].toFixed(1)},${baseY}L${coords[0][0].toFixed(1)},${baseY}Z`, fill: 'url(#labChartFill)' }));
    svg.appendChild(svgEl('path', { class: 'lab-chart__line', d: line }));
    const last = coords[coords.length - 1];
    svg.appendChild(svgEl('circle', { class: 'lab-chart__last', cx: last[0], cy: last[1], r: 3.5 }));

    const guide = svgEl('line', { class: 'lab-chart__guide', y1: pad.top, y2: pad.top + innerH, visibility: 'hidden' });
    const marker = svgEl('circle', { class: 'lab-chart__marker', r: 4.5, visibility: 'hidden' });
    svg.append(guide, marker);

    const tip = el('div', 'lab-tip');
    tip.hidden = true;
    const showPoint = (index) => {
      const p = points[index];
      const [px, py] = coords[index];
      guide.setAttribute('x1', px);
      guide.setAttribute('x2', px);
      guide.setAttribute('visibility', 'visible');
      marker.setAttribute('cx', px);
      marker.setAttribute('cy', py);
      marker.setAttribute('visibility', 'visible');
      tip.textContent = '';
      tip.appendChild(el('span', 'lab-tip__time', Core.formatClock(p.at)));
      tip.appendChild(el('strong', null, t('lab_chart_tip', { n: p.active })));
      tip.hidden = false;
      const left = (px / width) * frame.clientWidth;
      tip.style.left = `${Math.min(Math.max(left, 50), frame.clientWidth - 50)}px`;
      tip.style.top = `${(py / height) * frame.clientHeight}px`;
    };
    const hide = () => {
      tip.hidden = true;
      guide.setAttribute('visibility', 'hidden');
      marker.setAttribute('visibility', 'hidden');
    };
    const nearest = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const sx = ((clientX - rect.left) / rect.width) * width;
      let best = 0;
      for (let i = 1; i < coords.length; i += 1) if (Math.abs(coords[i][0] - sx) < Math.abs(coords[best][0] - sx)) best = i;
      return best;
    };
    let focusIndex = points.length - 1;
    svg.addEventListener('pointermove', (ev) => showPoint(nearest(ev.clientX)));
    svg.addEventListener('pointerdown', (ev) => showPoint(nearest(ev.clientX)));
    svg.addEventListener('pointerleave', hide);
    frame.tabIndex = 0;
    frame.onfocus = () => showPoint(focusIndex);
    frame.onblur = hide;
    frame.onkeydown = (ev) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
      ev.preventDefault();
      if (ev.key === 'ArrowLeft') focusIndex = Math.max(0, focusIndex - 1);
      if (ev.key === 'ArrowRight') focusIndex = Math.min(points.length - 1, focusIndex + 1);
      if (ev.key === 'Home') focusIndex = 0;
      if (ev.key === 'End') focusIndex = points.length - 1;
      showPoint(focusIndex);
    };
    frame.setAttribute('aria-describedby', 'labChartSummary');
    frame.append(svg, tip);

    const values = points.map((p) => p.active);
    setText(summary, t('lab_chart_summary', {
      range: t(`lab_range_${range}_long`),
      min: Math.min(...values),
      max: Math.max(...values),
      now: values[values.length - 1],
    }));
  };

  // ── Недавняя активность ────────────────────────────────────────

  const EVENT_TONE = { restored: 'ok', promoted: 'ok', discovery: 'ok', suspect: 'warn', demoted: 'warn', excluded: 'error', dead: 'error' };

  const eventItem = (event, { full = false } = {}) => {
    const li = el('li', `lab-event lab-event--${EVENT_TONE[event.type]}`);
    li.appendChild(el('span', 'lab-event__dot'));
    li.appendChild(el('time', 'lab-event__time', full ? Core.formatDayTime(event.at, now(), t) : Core.formatClock(event.at)));
    li.lastChild.setAttribute('datetime', new Date(event.at).toISOString());
    const body = el('div', 'lab-event__body');
    const title = el('p', 'lab-event__title');
    if (event.type === 'discovery') {
      title.textContent = t('lab_event_discovery');
    } else {
      fillTemplate(title, t('lab_event_endpoint'), {
        endpoint: el('span', 'lab-mono', event.endpoint),
        action: el('span', `lab-event__action lab-event__action--${EVENT_TONE[event.type]}`, t(`lab_event_${event.type}`)),
      });
    }
    const sub = el('p', 'lab-event__sub', event.type === 'discovery'
      ? Core.plural(PAGE_LANG, event.count, {
        one: t('lab_event_discovery_sub_one', { n: event.count }),
        few: t('lab_event_discovery_sub_few', { n: event.count }),
        many: t('lab_event_discovery_sub_many', { n: event.count }),
        other: t('lab_event_discovery_sub_other', { n: event.count }),
      })
      : t(`lab_event_${event.type}_sub`));
    body.append(title, sub);
    li.appendChild(body);
    return li;
  };

  const renderActivity = () => {
    const list = $('labActivityList');
    const empty = $('labActivityEmpty');
    const events = ui.view && ui.view.events;
    list.textContent = '';
    $('labEventsBtn').disabled = !(events && events.length > ACTIVITY_PREVIEW);
    if (!events || !events.length) {
      list.hidden = true;
      empty.hidden = false;
      setText(empty, t(!ui.view ? 'lab_no_data' : !events ? 'lab_activity_unavailable' : 'lab_activity_empty'));
      return;
    }
    list.hidden = false;
    empty.hidden = true;
    events.slice(0, ACTIVITY_PREVIEW).forEach((e) => list.appendChild(eventItem(e)));
    if (UiShellOpen('labEventsModal')) renderAllEvents();
  };

  const renderAllEvents = () => {
    const list = $('labEventsFull');
    list.textContent = '';
    const events = (ui.view && ui.view.events) || [];
    events.forEach((e) => list.appendChild(eventItem(e, { full: true })));
  };

  // ── Список endpoint'ов: таблица на десктопе, карточки на телефоне ──

  const visibleEndpoints = () => {
    const list = (ui.view && ui.view.endpoints) || [];
    const filtered = Core.filterEndpoints(list, ui.filters, now());
    return { all: list, filtered, sorted: Core.sortEndpoints(filtered, ui.sort, ui.order) };
  };

  const reliabilityTone = (r) => (r === null ? '' : r >= 0.99 ? 'good' : r < 0.8 ? 'warn' : '');

  const httpsCell = (value) => {
    const wrap = el('span', `lab-https lab-https--${value || 'none'}`);
    if (value === 'ok') wrap.appendChild(icon('i-check-circle', 'icon'));
    else if (value === 'fail') wrap.appendChild(icon('i-x-circle', 'icon'));
    else wrap.appendChild(el('span', null, '—'));
    wrap.appendChild(el('span', 'visually-hidden', t(`lab_https_${value || 'none'}`)));
    return wrap;
  };

  const sessionText = (s) => el('span', `lab-session lab-session--${s || 'none'}`, s ? t(`lab_session_${s}`) : '—');

  const menuButton = (ep) => {
    const btn = el('button', 'icon-btn lab-row-menu');
    btn.type = 'button';
    btn.dataset.endpoint = ep.id;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', t('lab_row_menu_for', { endpoint: ep.id }));
    btn.appendChild(icon('i-more', 'icon'));
    return btn;
  };

  const endpointButton = (ep) => {
    const btn = el('button', 'lab-ep-btn lab-mono', ep.id);
    btn.type = 'button';
    btn.dataset.endpoint = ep.id;
    btn.setAttribute('aria-label', t('lab_open_details_for', { endpoint: ep.id }));
    return btn;
  };

  const fillRow = (tr, ep) => {
    const shown = Core.displayState(ep, now());
    const signature = JSON.stringify([shown, ep.lastVerifiedAt, ep.session, ep.https, ep.reliability, ep.source, PAGE_LANG]);
    if (tr.dataset.sig === signature) return;
    tr.dataset.sig = signature;
    const cells = [
      endpointButton(ep),
      stateChip(shown),
      bindAgo(el('span', 'lab-ago'), ep.lastVerifiedAt),
      sessionText(ep.session),
      httpsCell(ep.https),
      el('span', `lab-rel lab-rel--${reliabilityTone(ep.reliability)}`, Core.formatPercent(ep.reliability, PAGE_LANG, 1)),
      el('span', 'lab-source', sourceLabel(ep.source)),
      menuButton(ep),
    ];
    // Фокус внутри строки (кнопка endpoint'а или меню) переживает перерисовку.
    const focusedClass = tr.contains(doc.activeElement) ? doc.activeElement.className : null;
    tr.textContent = '';
    cells.forEach((cell, i) => {
      const td = el(i === 0 ? 'th' : 'td');
      if (i === 0) td.setAttribute('scope', 'row');
      if (i === 4) td.className = 'lab-col-center';
      if (i === 6) td.className = 'lab-col-source';
      if (i === 7) td.className = 'lab-col-menu';
      td.appendChild(cell);
      tr.appendChild(td);
    });
    if (focusedClass) {
      const again = tr.querySelector(focusedClass.split(' ').map((c) => `.${c}`).join(''));
      if (again) again.focus({ preventScroll: true });
    }
  };

  const fillCard = (li, ep) => {
    const shown = Core.displayState(ep, now());
    const signature = JSON.stringify([shown, ep.lastVerifiedAt, ep.session, ep.https, ep.reliability, ep.source, PAGE_LANG]);
    if (li.dataset.sig === signature) return;
    li.dataset.sig = signature;
    li.textContent = '';
    const head = el('div', 'lab-card__head');
    head.append(endpointButton(ep), menuButton(ep));
    const meta = el('dl', 'lab-card__meta');
    const row = (labelKey, node) => {
      const box = el('div');
      box.append(el('dt', null, t(labelKey)), (() => { const dd = el('dd'); dd.appendChild(node); return dd; })());
      meta.appendChild(box);
    };
    row('lab_col_checked', bindAgo(el('span', 'lab-ago'), ep.lastVerifiedAt));
    row('lab_col_session', sessionText(ep.session));
    row('lab_col_https', httpsCell(ep.https));
    row('lab_col_reliability', el('span', `lab-rel lab-rel--${reliabilityTone(ep.reliability)}`, Core.formatPercent(ep.reliability, PAGE_LANG, 1)));
    const line = el('div', 'lab-card__line');
    const src = el('span', 'lab-source', sourceLabel(ep.source));
    src.setAttribute('aria-label', `${t('lab_col_source')}: ${sourceLabel(ep.source)}`);
    line.append(stateChip(shown), src);
    li.append(head, line, meta);
  };

  /** Сверка по ключу: существующие узлы переиспользуются и только переставляются — фокус и прокрутка не сбрасываются. */
  const reconcile = (container, items, tag, fill) => {
    const existing = new Map();
    Array.from(container.children).forEach((node) => {
      if (node.dataset.key) existing.set(node.dataset.key, node);
      else node.remove();
    });
    items.forEach((ep, index) => {
      let node = existing.get(ep.id);
      if (node) existing.delete(ep.id);
      else {
        node = el(tag, tag === 'li' ? 'lab-card' : 'lab-tr');
        node.dataset.key = ep.id;
      }
      fill(node, ep);
      node.classList.toggle('is-changed', (ui.changedUntil.get(ep.id) || 0) > now());
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    });
    existing.forEach((node) => node.remove());
  };

  const trackChanges = (list) => {
    const at = now();
    for (const ep of list) {
      const prev = ui.prevStates.get(ep.id);
      if (prev !== undefined && prev !== ep.state) {
        ui.changedUntil.set(ep.id, at + CHANGE_HIGHLIGHT_MS);
        win.setTimeout(() => {
          doc.querySelectorAll('.is-changed').forEach((node) => {
            if ((ui.changedUntil.get(node.dataset.key) || 0) <= now()) node.classList.remove('is-changed');
          });
        }, CHANGE_HIGHLIGHT_MS + 50);
      }
      ui.prevStates.set(ep.id, ep.state);
    }
  };

  const syncSelect = (select, values, labelFor) => {
    const current = select.value;
    const wanted = ['all', ...values];
    if (current !== 'all' && !wanted.includes(current)) wanted.push(current);
    const have = Array.from(select.options).map((o) => o.value);
    if (JSON.stringify(have) !== JSON.stringify(wanted) || select.dataset.lang !== PAGE_LANG) {
      const first = select.options[0];
      select.textContent = '';
      select.appendChild(first);
      wanted.slice(1).forEach((v) => {
        const opt = el('option', null, labelFor(v));
        opt.value = v;
        select.appendChild(opt);
      });
      select.dataset.lang = PAGE_LANG;
    }
    select.value = current;
  };

  // Поштучно публикуются только эти состояния; остальные — счётчики и события.
  const FILTER_STATES = ['ACTIVE', 'VERIFIED', 'SUSPECT'];

  const renderFilters = () => {
    const list = (ui.view && ui.view.endpoints) || [];
    syncSelect($('labFilterState'), FILTER_STATES, stateLabel);
    syncSelect($('labFilterPort'), [...new Set(list.map((ep) => ep.port))].sort((a, b) => a - b).map(String), (v) => v);
    syncSelect($('labFilterSource'), [...new Set(list.map((ep) => ep.source).filter(Boolean))].sort(), sourceLabel);
    $('labFilters').querySelectorAll('input, select').forEach((c) => { c.disabled = !list.length; });
  };

  const renderSortHeaders = () => {
    doc.querySelectorAll('#labTable th[data-sort]').forEach((th) => {
      const active = ui.sort && ui.sort.key === th.dataset.sort;
      th.setAttribute('aria-sort', active ? (ui.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
    });
  };

  /** Код ошибки проверки → подпись словаря; незнакомый код показывается как есть (это уже чистый текст). */
  const errorText = (code) => {
    if (!code) return t('lab_hist_event_fail_unknown');
    return Object.prototype.hasOwnProperty.call(strings, `lab_error_${code}`) ? t(`lab_error_${code}`) : code;
  };

  const renderEndpoints = () => {
    const tbody = $('labTableBody');
    const cards = $('labCards');
    const empty = $('labEndpointsEmpty');
    const foot = $('labEndpointsFoot');
    const view = ui.view;
    const { all, filtered, sorted } = visibleEndpoints();
    const shown = sorted.slice(0, ui.visible);

    $('labTableWrap').hidden = ui.mobile;
    cards.hidden = !ui.mobile;
    tbody.querySelectorAll('.lab-skel-row').forEach((row) => row.remove());

    let emptyKey = null;
    if (!view) emptyKey = ui.labState === 'loading' ? null : 'lab_endpoints_nodata';
    else if (!view.endpoints) emptyKey = 'lab_endpoints_unavailable';
    // Пустой список — не всегда «Lab ничего не опубликовал»: устаревший или урезанный API список ничего не доказывает.
    else if (!all.length) emptyKey = ui.labState === 'stale' ? 'lab_endpoints_stale' : view.endpointsPartial ? 'lab_endpoints_unavailable' : 'lab_endpoints_empty';
    else if (!filtered.length) emptyKey = 'lab_endpoints_no_match';

    empty.textContent = '';
    if (emptyKey) {
      empty.appendChild(el('span', null, t(emptyKey)));
      if (emptyKey === 'lab_endpoints_no_match') {
        const reset = el('button', 'link-btn', t('lab_filters_reset'));
        reset.type = 'button';
        reset.addEventListener('click', resetFilters);
        empty.appendChild(doc.createTextNode(' '));
        empty.appendChild(reset);
      }
    }
    empty.hidden = !emptyKey;
    // Режим совместимости API: в списке только ACTIVE — не создаём впечатление полного списка.
    $('labCoverageNote').hidden = !(view && view.coverage === 'active-only' && !emptyKey);

    const target = ui.mobile ? cards : tbody;
    const other = ui.mobile ? tbody : cards;
    other.textContent = '';
    reconcile(target, emptyKey ? [] : shown, ui.mobile ? 'li' : 'tr', ui.mobile ? fillCard : fillRow);
    $('labTable').classList.toggle('lab-table--empty', !!emptyKey);

    foot.hidden = !!emptyKey;
    if (!emptyKey) {
      setText($('labEndpointsCount'), t('lab_endpoints_count', { shown: shown.length, total: filtered.length }));
      $('labMoreBtn').hidden = filtered.length <= shown.length;
    }
    renderSortHeaders();
  };

  const resetFilters = () => {
    ui.filters = { query: '', state: 'all', port: 'all', source: 'all' };
    $('labSearch').value = '';
    $('labFilterState').value = 'all';
    $('labFilterPort').value = 'all';
    $('labFilterSource').value = 'all';
    ui.visible = pageSize();
    renderEndpoints();
  };

  // ── Меню строки ────────────────────────────────────────────────

  const rowMenu = $('labRowMenu');
  let menuOpener = null;

  const closeRowMenu = (restoreFocus) => {
    if (rowMenu.hidden) return;
    rowMenu.hidden = true;
    if (menuOpener) {
      menuOpener.setAttribute('aria-expanded', 'false');
      if (restoreFocus) menuOpener.focus();
    }
    menuOpener = null;
  };

  const openRowMenu = (button) => {
    closeRowMenu(false);
    menuOpener = button;
    rowMenu.dataset.endpoint = button.dataset.endpoint;
    rowMenu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const rect = button.getBoundingClientRect();
    const menuW = rowMenu.offsetWidth;
    const menuH = rowMenu.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - menuW, win.innerWidth - menuW - 8));
    const below = rect.bottom + 4 + menuH <= win.innerHeight;
    rowMenu.style.left = `${left}px`;
    rowMenu.style.top = `${below ? rect.bottom + 4 : Math.max(8, rect.top - menuH - 4)}px`;
    rowMenu.querySelector('[role="menuitem"]').focus();
  };

  rowMenu.addEventListener('keydown', (ev) => {
    const items = Array.from(rowMenu.querySelectorAll('[role="menuitem"]'));
    const index = items.indexOf(doc.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[(index + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeRowMenu(true);
    } else if (ev.key === 'Tab') {
      closeRowMenu(false);
    }
  });

  rowMenu.addEventListener('click', (ev) => {
    const item = ev.target.closest('[role="menuitem"]');
    if (!item) return;
    const id = rowMenu.dataset.endpoint;
    const opener = menuOpener;
    closeRowMenu(false);
    if (item.dataset.action === 'details') openDetails(id, opener);
    if (item.dataset.action === 'history') openHistory(id, opener);
    if (item.dataset.action === 'copy') copyEndpoint(id, opener);
  });

  doc.addEventListener('click', (ev) => {
    const menuBtn = ev.target.closest('.lab-row-menu');
    if (menuBtn) {
      ev.stopPropagation();
      if (menuOpener === menuBtn) closeRowMenu(true);
      else openRowMenu(menuBtn);
      return;
    }
    if (!rowMenu.hidden && !rowMenu.contains(ev.target)) closeRowMenu(false);
    const epBtn = ev.target.closest('.lab-ep-btn');
    if (epBtn) openDetails(epBtn.dataset.endpoint, epBtn);
  });
  win.addEventListener('scroll', () => closeRowMenu(false), { passive: true });
  win.addEventListener('resize', () => closeRowMenu(false));

  const toast = (text, kind) => {
    if (win.UiShell) win.UiShell.toast(text, kind);
  };

  const copyEndpoint = async (id, opener) => {
    try {
      await win.navigator.clipboard.writeText(id);
      toast(t('lab_copied', { endpoint: id }));
    } catch {
      toast(t('lab_copy_failed'), 'info');
    }
    if (opener && doc.contains(opener)) opener.focus();
  };

  // ── Подробности endpoint'а (модальное окно, состояние в адресе ?endpoint=) ──

  const UiShellOpen = (id) => !!(win.UiShell && win.UiShell.isOpen(id));
  const findEndpoint = (id) => ((ui.view && ui.view.endpoints) || []).find((ep) => ep.id === id) || null;

  let pushedDetails = false;
  let closingFromPop = false;
  let detailsRequest = 0;

  const tile = (iconId, labelKey, valueNode) => {
    const box = el('div', 'lab-tile');
    box.appendChild(el('span', 'lab-tile__icon')).appendChild(icon(iconId, 'icon'));
    const text = el('div', 'lab-tile__text');
    text.append(el('span', 'lab-tile__label', t(labelKey)), valueNode);
    box.appendChild(text);
    return box;
  };

  const renderDetailsHeader = (ep) => {
    setText($('labEpHeading'), ep ? ep.id : ui.detailsId || '—');
    const chips = $('labEpChips');
    chips.textContent = '';
    if (!ep) return;
    const shown = Core.displayState(ep, now());
    chips.appendChild(stateChip(shown, { long: true }));
    chips.appendChild(el('span', 'tag lab-code-tag', shown === 'UNKNOWN' ? '?' : shown));
    if (ep.source) chips.appendChild(el('span', 'tag lab-source-tag', sourceLabel(ep.source)));
  };

  const CHECK_ROWS = [['handshake', 'lab_check_handshake'], ['tunnel', 'lab_check_tunnel'], ['https', 'lab_check_https']];

  const timelineBlock = (timeline) => {
    const wrap = el('div', 'lab-timeline');
    if (!timeline || timeline.length < 2) {
      wrap.appendChild(el('p', 'lab-empty', t('lab_timeline_unavailable')));
      return wrap;
    }
    const from = now() - 24 * 3600e3;
    const until = now();
    const track = el('div', 'lab-timeline__track');
    const counts = {};
    timeline.filter((p) => p.at >= from).forEach((p) => {
      const dot = el('span', `lab-timeline__dot lab-timeline__dot--${STATE_TONE[p.state] || 'muted'}`);
      dot.style.left = `${((p.at - from) / (until - from)) * 100}%`;
      dot.title = `${Core.formatClock(p.at)} — ${stateLabel(p.state)}`;
      track.appendChild(dot);
      counts[p.state] = (counts[p.state] || 0) + 1;
    });
    const axis = el('div', 'lab-timeline__axis');
    for (let i = 0; i <= 4; i += 1) axis.appendChild(el('span', null, Core.formatClock(from + (i / 4) * (until - from))));
    const legend = el('ul', 'lab-timeline__legend');
    Object.keys(counts).forEach((s) => {
      const li = el('li');
      li.append(el('span', `lab-timeline__key lab-timeline__dot--${STATE_TONE[s] || 'muted'}`), el('span', null, stateLabel(s)));
      legend.appendChild(li);
    });
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', t('lab_timeline_aria', {
      summary: Object.entries(counts).map(([s, n]) => `${stateLabel(s)}: ${n}`).join(', '),
    }));
    wrap.append(track, axis, legend);
    return wrap;
  };

  const renderDetailsBody = () => {
    const body = $('labEpBody');
    const id = ui.detailsId;
    const ep = findEndpoint(id) || (ui.detailsView && ui.detailsView.endpoint);
    renderDetailsHeader(ep);
    body.textContent = '';
    const dv = ui.detailsView;
    if (!ep && !dv) {
      body.appendChild(el('p', 'lab-empty', ui.detailsError ? t(ui.detailsError) : t('lab_loading')));
      return;
    }
    const shown = Core.displayState(ep, now());
    const tiles = el('div', 'lab-tiles');
    tiles.appendChild(tile('i-clock', 'lab_tile_last_check', bindAgo(el('strong'), ep.lastVerifiedAt)));
    const left = shown === 'ACTIVE' && ep.expiresAt !== null
      ? bindAgo(el('strong'), ep.expiresAt, { mode: 'left' })
      : el('strong', null, t(shown === 'EXPIRED' ? 'lab_left_expired' : 'lab_tile_not_in_pool'));
    tiles.appendChild(tile('i-timer', 'lab_tile_valid_for', left));
    tiles.appendChild(tile('i-plug', 'lab_tile_port', el('strong', 'lab-mono', String(ep.port))));
    tiles.appendChild(tile('i-tag', 'lab_tile_source', el('strong', null, sourceLabel(ep.source))));
    body.appendChild(tiles);

    if (!dv) {
      body.appendChild(el('p', 'lab-empty', ui.detailsError ? t(ui.detailsError) : t('lab_loading')));
      return;
    }
    if (dv.partial) body.appendChild(el('p', 'lab-empty', t('lab_alert_partial')));

    body.appendChild(el('h3', 'lab-section-title', t('lab_details_last_check')));
    const checkGrid = el('div', 'lab-checkgrid');
    const checks = el('ul', 'lab-checks');
    CHECK_ROWS.forEach(([key, labelKey]) => {
      const c = dv.checks && dv.checks[key];
      const li = el('li', `lab-checks__row lab-checks__row--${c ? c.result : 'none'}`);
      li.appendChild(icon(c ? (c.result === 'ok' ? 'i-check-circle' : 'i-x-circle') : 'i-info', 'icon'));
      li.appendChild(el('span', 'lab-checks__name', t(labelKey)));
      li.appendChild(el('span', 'visually-hidden', c ? t(`lab_check_${c.result}`) : t('lab_check_none')));
      li.appendChild(bindAgo(el('span', 'lab-checks__time'), c ? c.at : null, { mode: 'ago' }));
      checks.appendChild(li);
    });
    const session = el('div', `lab-session-box lab-session-box--${ep.session || 'none'}`);
    session.appendChild(el('span', 'lab-session-box__label', t('lab_details_session')));
    const sv = el('span', 'lab-session-box__value');
    sv.appendChild(icon(ep.session === 'failed' ? 'i-x-circle' : ep.session ? 'i-check-circle' : 'i-info', 'icon'));
    sv.appendChild(el('span', null, ep.session ? t(`lab_session_long_${ep.session}`) : '—'));
    session.appendChild(sv);
    checkGrid.append(checks, session);
    body.appendChild(checkGrid);

    body.appendChild(el('h3', 'lab-section-title', t('lab_details_stability')));
    const stab = el('div', 'lab-tiles lab-tiles--three');
    const st = dv.stability;
    stab.appendChild(tile('i-clock', 'lab_stab_1h', el('strong', `lab-rel lab-rel--${reliabilityTone(st && st.h1)}`, Core.formatPercent(st && st.h1, PAGE_LANG, 1))));
    stab.appendChild(tile('i-clock', 'lab_stab_24h', el('strong', `lab-rel lab-rel--${reliabilityTone(st && st.h24)}`, Core.formatPercent(st && st.h24, PAGE_LANG, 1))));
    stab.appendChild(tile('i-activity', 'lab_stab_obs', el('strong', null, Core.formatCount(st && st.observations, PAGE_LANG))));
    body.appendChild(stab);

    body.appendChild(el('h3', 'lab-section-title', t('lab_details_timeline')));
    body.appendChild(timelineBlock(dv.timeline));

    body.appendChild(el('h3', 'lab-section-title', t('lab_details_last_error')));
    const err = el('p', `lab-last-error lab-last-error--${!dv.lastErrorKnown ? 'unknown' : dv.lastError ? 'yes' : 'no'}`);
    if (!dv.lastErrorKnown) err.textContent = t('lab_last_error_unknown');
    else if (!dv.lastError) err.textContent = t('lab_last_error_none');
    else {
      const known = dv.lastError.code && Object.prototype.hasOwnProperty.call(strings, `lab_error_${dv.lastError.code}`);
      err.appendChild(el('span', null, known ? t(`lab_error_${dv.lastError.code}`) : (dv.lastError.message || dv.lastError.code)));
      if (dv.lastError.at) {
        err.appendChild(doc.createTextNode(' · '));
        err.appendChild(bindAgo(el('span', 'lab-muted'), dv.lastError.at));
      }
    }
    body.appendChild(err);
  };

  const loadDetails = async (id, { quiet = false } = {}) => {
    const request = ++detailsRequest;
    if (!quiet) {
      ui.detailsView = null;
      ui.detailsError = null;
      renderDetailsBody();
    }
    const result = source ? await source.loadEndpoint(id, 'all') : { kind: 'not-connected' };
    if (request !== detailsRequest || ui.detailsId !== id) return;
    if (result.kind === 'ok') {
      ui.detailsView = result.view;
      ui.detailsError = null;
    } else if (!quiet || !ui.detailsView) {
      ui.detailsView = null;
      const gone = result.kind === 'error' && (result.code === 'endpoint_not_found' || result.status === 404);
      ui.detailsError = gone ? 'lab_details_gone'
        : result.kind === 'not-connected' || result.code === 'lab_not_available' ? 'lab_details_unavailable'
          : result.kind === 'malformed' || result.code === 'lab_malformed' ? 'lab_details_malformed' : 'lab_details_error';
    }
    renderDetailsBody();
  };

  const setUrlEndpoint = (id, mode) => {
    try {
      const url = new URL(win.location.href);
      if (id) url.searchParams.set('endpoint', id);
      else url.searchParams.delete('endpoint');
      if (mode === 'push') win.history.pushState({ labEndpoint: id }, '', url);
      else win.history.replaceState(win.history.state, '', url);
    } catch {
      // Без History API детали просто не попадут в адрес.
    }
  };

  function openDetails(id, opener, { fromHistory = false } = {}) {
    const parsed = Core.parseEndpointId(id);
    if (!parsed || !win.UiShell) return;
    if (ui.detailsId === parsed.id && UiShellOpen('labEndpointModal')) return;
    ui.detailsId = parsed.id;
    if (!fromHistory) {
      setUrlEndpoint(parsed.id, 'push');
      pushedDetails = true;
    }
    win.UiShell.openModal('labEndpointModal', opener || null);
    loadDetails(parsed.id);
  }

  $('labEndpointModal').addEventListener('modal:close', () => {
    detailsRequest += 1;
    ui.detailsId = null;
    ui.detailsView = null;
    if (UiShellOpen('labHistoryModal')) win.UiShell.closeModal('labHistoryModal');
    if (closingFromPop) {
      closingFromPop = false;
      return;
    }
    if (pushedDetails) {
      pushedDetails = false;
      win.history.back();
    } else {
      setUrlEndpoint(null, 'replace');
    }
  });

  win.addEventListener('popstate', () => {
    let id = null;
    try {
      id = new URL(win.location.href).searchParams.get('endpoint');
    } catch {
      id = null;
    }
    const parsed = id ? Core.parseEndpointId(id) : null;
    if (parsed) {
      if (ui.detailsId !== parsed.id) {
        if (UiShellOpen('labEndpointModal')) {
          closingFromPop = true;
          win.UiShell.closeModal('labEndpointModal');
        }
        openDetails(parsed.id, null, { fromHistory: true });
      }
    } else if (UiShellOpen('labEndpointModal')) {
      pushedDetails = false;
      closingFromPop = true;
      win.UiShell.closeModal('labEndpointModal');
    }
  });

  $('labEpCopy').addEventListener('click', (ev) => copyEndpoint(ui.detailsId, ev.currentTarget));
  $('labEpHistoryBtn').addEventListener('click', (ev) => openHistory(ui.detailsId, ev.currentTarget));

  // ── История проверок endpoint'а ────────────────────────────────

  let historyRequest = 0;

  const histChart = (buckets) => {
    const frame = $('labHistChart');
    frame.textContent = '';
    if (!buckets || !buckets.length) {
      frame.appendChild(el('p', 'lab-empty lab-empty--chart', t('lab_history_unavailable')));
      return;
    }
    const width = Math.max(280, Math.round(frame.clientWidth || 520));
    const height = 150;
    const pad = { top: 6, right: 4, bottom: 22, left: 4 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const max = Math.max(1, ...buckets.map((b) => b.first + b.retry + b.fail));
    const slot = innerW / buckets.length;
    const barW = Math.max(2, Math.min(14, slot * 0.62));
    const svg = svgEl('svg', { class: 'lab-hist__svg', viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' });
    const tip = el('div', 'lab-tip');
    tip.hidden = true;
    buckets.forEach((b, i) => {
      const g = svgEl('g', { class: 'lab-hist__bar' });
      let yCursor = pad.top + innerH;
      const cx = pad.left + slot * i + (slot - barW) / 2;
      [['first', b.first], ['retry', b.retry], ['fail', b.fail]].forEach(([kind, v]) => {
        if (!v) return;
        const h = (v / max) * innerH;
        yCursor -= h;
        g.appendChild(svgEl('rect', { class: `lab-hist__seg lab-hist__seg--${kind}`, x: cx.toFixed(1), y: yCursor.toFixed(1), width: barW.toFixed(1), height: Math.max(1, h).toFixed(1), rx: 1.5 }));
      });
      const hit = svgEl('rect', { x: (pad.left + slot * i).toFixed(1), y: pad.top, width: slot.toFixed(1), height: innerH, fill: 'transparent' });
      const show = () => {
        tip.textContent = '';
        tip.appendChild(el('span', 'lab-tip__time', Core.formatDayTime(b.at, now(), t)));
        tip.appendChild(el('strong', null, t('lab_hist_tip', { first: b.first, retry: b.retry, fail: b.fail })));
        tip.hidden = false;
        tip.style.left = `${Math.min(Math.max(((cx + barW / 2) / width) * frame.clientWidth, 70), frame.clientWidth - 70)}px`;
        tip.style.top = '8px';
      };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointerdown', show);
      g.appendChild(hit);
      svg.appendChild(g);
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; });
    const axis = svgEl('g', { class: 'lab-chart__grid' });
    const ticks = 5;
    const span = buckets[buckets.length - 1].at - buckets[0].at;
    for (let i = 0; i < ticks; i += 1) {
      const at = buckets[0].at + (span * i) / (ticks - 1);
      const label = svgEl('text', { x: pad.left + (i / (ticks - 1)) * innerW, y: height - 4, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle' });
      label.textContent = span > 2 * 86400e3 ? Core.formatDayTime(at, now(), t).split(',')[0] : Core.formatClock(at);
      axis.appendChild(label);
    }
    svg.appendChild(axis);
    frame.append(svg, tip);
    const total = buckets.reduce((acc, b) => ({ first: acc.first + b.first, retry: acc.retry + b.retry, fail: acc.fail + b.fail }), { first: 0, retry: 0, fail: 0 });
    setText($('labHistSummary'), t('lab_hist_summary', total));
  };

  const renderHistoryEvents = (events) => {
    const list = $('labHistEvents');
    list.textContent = '';
    if (!events || !events.length) {
      list.appendChild(el('li', 'lab-empty', t('lab_history_events_empty')));
      return;
    }
    events.slice(0, 20).forEach((e) => {
      const ok = e.result !== 'fail';
      const li = el('li', `lab-checklog__item lab-checklog__item--${ok ? 'ok' : 'fail'}`);
      li.appendChild(icon(ok ? 'i-check-circle' : 'i-x-circle', 'icon'));
      const time = el('time', 'lab-checklog__time', Core.formatClock(e.at));
      time.setAttribute('datetime', new Date(e.at).toISOString());
      li.appendChild(time);
      const text = el('div');
      text.appendChild(el('p', 'lab-checklog__title', t(ok ? 'lab_hist_event_ok' : 'lab_hist_event_fail')));
      text.appendChild(el('p', 'lab-checklog__sub', ok ? t(`lab_session_long_${e.result === 'retry' ? 'retry' : 'first'}`) : errorText(e.error)));
      li.appendChild(text);
      list.appendChild(li);
    });
  };

  const loadHistory = async () => {
    const id = ui.historyId;
    const request = ++historyRequest;
    $('labHistChart').textContent = '';
    $('labHistChart').appendChild(el('div', 'lab-skel-block'));
    $('labHistEvents').textContent = '';
    doc.querySelectorAll('#labHistRange [data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === ui.historyRange)));
    const result = source ? await source.loadEndpoint(id, ui.historyRange) : { kind: 'not-connected' };
    if (request !== historyRequest) return;
    const history = result.kind === 'ok' ? result.view.history : null;
    histChart(history && history.buckets);
    renderHistoryEvents(history && history.events);
    if (!history) setText($('labHistSummary'), t('lab_history_unavailable'));
  };

  function openHistory(id, opener) {
    const parsed = Core.parseEndpointId(id);
    if (!parsed || !win.UiShell) return;
    ui.historyId = parsed.id;
    ui.historyRange = 'all';
    setText($('labHistEndpoint'), parsed.id);
    win.UiShell.openModal('labHistoryModal', opener || null);
    loadHistory();
  }

  $('labHistRange').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-range]');
    if (!btn || btn.dataset.range === ui.historyRange) return;
    ui.historyRange = btn.dataset.range;
    loadHistory();
  });
  $('labHistoryModal').addEventListener('modal:close', () => { historyRequest += 1; });

  // ── Всё вместе ─────────────────────────────────────────────────

  const renderAll = () => {
    ui.labState = ui.view ? Core.deriveLabState(ui.view, now()) : (ui.lastResult ? resultState(ui.lastResult) : 'loading');
    const main = $('labMain');
    main.dataset.labState = ui.labState;
    main.setAttribute('aria-busy', String(ui.labState === 'loading'));
    renderStatusCard();
    renderAlert();
    renderMetrics();
    renderFreshness();
    renderQuality();
    renderChart();
    renderActivity();
    renderFilters();
    renderEndpoints();
    if (ui.detailsId && UiShellOpen('labEndpointModal')) renderDetailsBody();
  };

  const resultState = (r) => {
    if (r.kind === 'not-connected') return 'not-connected';
    if (r.kind === 'malformed') return 'malformed';
    // 503 lab_not_available: публичных файлов Lab нет (Vercel, форк, Lab не смонтирован) — как «не подключено».
    if (r.kind === 'error' && r.code === 'lab_not_available') return 'not-connected';
    if (r.kind === 'error' && r.code === 'lab_malformed') return 'malformed';
    if (r.kind === 'error') return 'error';
    return 'nodata';
  };

  const onResult = (result) => {
    ui.lastResult = result;
    if (result.kind === 'ok') {
      ui.view = result.view;
      ui.issues = result.issues || [];
      ui.receivedAt = now();
      if (ui.view.endpoints) trackChanges(ui.view.endpoints);
    }
    renderAll();
    if (result.kind === 'ok' && ui.detailsId && UiShellOpen('labEndpointModal')) loadDetails(ui.detailsId, { quiet: true });
  };

  // ── Тикер «… назад» и смена раскладки ──────────────────────────

  let lastStateCheck = 0;
  const tick = () => {
    if (doc.hidden) return;
    doc.querySelectorAll('[data-ago-ts]').forEach(renderAgo);
    // Свежесть уходит со временем и без новых данных: раз в 5 с пересчитываем общее состояние.
    if (ui.view && now() - lastStateCheck > 5000) {
      lastStateCheck = now();
      const next = Core.deriveLabState(ui.view, now());
      if (next !== ui.labState) renderAll();
    }
  };

  const bindControls = () => {
    doc.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.classList.toggle('lang-btn--active', btn.dataset.lang === PAGE_LANG);
      btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        if (lang !== 'ru' && lang !== 'en') return;
        try {
          win.localStorage.setItem('lang', lang);
        } catch {
          // Без localStorage выбор не запомнится, но переход сработает.
        }
        if (lang !== PAGE_LANG) goToLang(lang, false);
      });
    });

    $('labChartRange').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-range]');
      if (!btn) return;
      ui.chartRange = btn.dataset.range;
      $('labChartRange').querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderChart();
    });

    let searchTimer = null;
    $('labSearch').addEventListener('input', (ev) => {
      win.clearTimeout(searchTimer);
      searchTimer = win.setTimeout(() => {
        ui.filters.query = ev.target.value.slice(0, 60);
        ui.visible = pageSize();
        renderEndpoints();
      }, 150);
    });
    $('labFilters').addEventListener('submit', (ev) => ev.preventDefault());
    [['labFilterState', 'state'], ['labFilterPort', 'port'], ['labFilterSource', 'source']].forEach(([id, key]) => {
      $(id).addEventListener('change', (ev) => {
        ui.filters[key] = ev.target.value;
        ui.visible = pageSize();
        renderEndpoints();
      });
    });
    doc.querySelectorAll('#labTable th[data-sort] .lab-th-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.closest('th').dataset.sort;
        if (!ui.sort || ui.sort.key !== key) ui.sort = { key, dir: key === 'endpoint' || key === 'state' ? 'asc' : 'desc' };
        else if (ui.sort.dir === (key === 'endpoint' || key === 'state' ? 'asc' : 'desc')) ui.sort = { key, dir: ui.sort.dir === 'asc' ? 'desc' : 'asc' };
        else ui.sort = null;
        renderEndpoints();
      });
    });
    $('labMoreBtn').addEventListener('click', () => {
      ui.visible += pageSize();
      renderEndpoints();
    });
    $('labEventsBtn').addEventListener('click', (ev) => {
      renderAllEvents();
      if (win.UiShell) win.UiShell.openModal('labEventsModal', ev.currentTarget);
    });
    $('labRetryBtn').addEventListener('click', () => {
      if (poller) poller.refresh();
    });

    if (win.matchMedia) {
      const mq = win.matchMedia(MOBILE_QUERY);
      const onChange = () => {
        ui.mobile = mq.matches;
        renderEndpoints();
        renderChart();
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
    if (typeof win.ResizeObserver === 'function') {
      let lastWidth = 0;
      let resizeTimer = null;
      new win.ResizeObserver((entries) => {
        const width = Math.round(entries[0].contentRect.width);
        if (Math.abs(width - lastWidth) < 4) return;
        lastWidth = width;
        win.clearTimeout(resizeTimer);
        resizeTimer = win.setTimeout(renderChart, 120);
      }).observe($('labChartFrame'));
    }
  };

  const renderGeneratorHistoryCount = () => {
    let count = 0;
    try {
      const arr = JSON.parse(win.localStorage.getItem(GENERATOR_HISTORY_KEY) || '[]');
      count = Array.isArray(arr) ? Math.min(arr.length, 99) : 0;
    } catch {
      count = 0;
    }
    setText($('historyCount'), count ? String(count) : '');
  };

  const showFixtureBadge = (name) => {
    const badge = el('p', 'lab-dev-badge', `DEV · fixture: ${name}`);
    badge.setAttribute('role', 'note');
    doc.body.appendChild(badge);
  };

  /** Фикстуры подключаются отдельным файлом и только на localhost: на боевом домене их код не грузится. */
  const loadFixtures = () => new Promise((resolve) => {
    const script = doc.createElement('script');
    script.src = '/lab/lab-fixtures.js';
    script.onload = () => resolve(win.LabFixtures || null);
    script.onerror = () => resolve(null);
    doc.head.appendChild(script);
  });

  const start = async () => {
    await loadStrings();
    applyStaticTranslations();
    renderGeneratorHistoryCount();
    bindControls();

    let fixtures = null;
    if (fixtureName) {
      fixtures = await loadFixtures();
      if (fixtures) showFixtureBadge(fixtureName);
    }
    source = Data.createLabSource({ fetchImpl: win.fetch.bind(win), fixture: fixtureName, fixtures });
    renderAll();
    if (!source.connected) {
      onResult({ kind: 'not-connected' });
    } else {
      poller = Data.createPoller({ load: source.loadOverview, onResult, doc });
      poller.start();
    }

    // Быстрый просмотр — окно для страницы генератора; здесь его можно открыть только локально: ?quick=1.
    if (Core.isLocalHost(win.location.hostname) && new URLSearchParams(win.location.search).get('quick') === '1') {
      const quick = doc.createElement('script');
      quick.src = '/lab/lab-quick.js';
      quick.onload = () => { if (win.LabQuick) win.LabQuick.open(null, { fixture: fixtureName, fixtures }); };
      doc.head.appendChild(quick);
    }

    win.setInterval(tick, 1000);
    doc.addEventListener('visibilitychange', tick);

    // Прямая ссылка на endpoint (?endpoint=…): открываем после первой загрузки, без новой записи в истории.
    let initialId = null;
    try {
      initialId = new URL(win.location.href).searchParams.get('endpoint');
    } catch {
      initialId = null;
    }
    if (initialId && Core.parseEndpointId(initialId)) openDetails(initialId, null, { fromHistory: true });
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();

  // Для e2e и ручной отладки: только чтение.
  win.LabPage = Object.freeze({ getState: () => ({ labState: ui.labState, rows: ui.view && ui.view.endpoints ? ui.view.endpoints.length : null, mobile: ui.mobile, fixture: fixtureName }) });
})(window);
