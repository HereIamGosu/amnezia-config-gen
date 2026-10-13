// public/static/cps-editor.js
//
// Редактор CPS-цепочек I1–I5 во вкладке «Дополнительно»: для каждого поля «авто» (генератор) или своя
// цепочка, собранная из блоков (байты, случайные байты, цифры, буквы, время) или написанная текстом.
// Разбор и проверку делает public/static/cps-chain.js (window.CpsChain) — тот же код проверяет /api/warp.
// Своя цепочка лежит в cfgState.cpsChains (канонический текст или '' = авто), уровень совместимости —
// в cfgState.cpsCompat: 'all' (все клиенты с I1–I5) или 'modern' (+ <rd>/<rc>, amneziawg-go 0.2.15+).
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → cps-editor.js → settings-link.js →
// history.js → script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t -- i18n.js */
/* global toast -- common.js */
/* global cfgState, updateParamChips -- settings.js */
/* global getSelectedProfile -- script.js */
/* exported initCpsEditor, renderCpsEditor, setCpsChains, resetCpsEditor, getCpsRequest, hasCustomCpsChains */

const cpsChainLib = window.CpsChain || null;

const CPS_FIELDS = ['I1', 'I2', 'I3', 'I4', 'I5'];
/** Блоки палитры в порядке кнопок «+». */
const CPS_BLOCK_ORDER = ['b', 'r', 'rd', 'rc', 't'];
const CPS_BLOCK_DEFAULTS = { b: { tag: 'b', hex: '00000000' }, r: { tag: 'r', n: 32 }, rd: { tag: 'rd', n: 8 }, rc: { tag: 'rc', n: 8 }, t: { tag: 't' } };

/** Состояние редактора: включена ли своя цепочка, вид (блоки/текст) и текст каждого поля. */
const cpsEditorState = {
  custom: { I1: false, I2: false, I3: false, I4: false, I5: false },
  view: { I1: 'blocks', I2: 'blocks', I3: 'blocks', I4: 'blocks', I5: 'blocks' },
  text: { I1: '', I2: '', I3: '', I4: '', I5: '' },
};

const blockLabel = (tag) => ({
  b: t('cps_block_b', 'Байты'),
  r: t('cps_block_r', 'Случайные байты'),
  rd: t('cps_block_rd', 'Случайные цифры'),
  rc: t('cps_block_rc', 'Случайные буквы'),
  t: t('cps_block_t', 'Время'),
}[tag]);

const blockHint = (tag) => ({
  b: t('cps_block_b_hint', 'Фиксированные байты (hex): одинаковые в каждом handshake'),
  r: t('cps_block_r_hint', 'Клиент заново генерирует столько случайных байт при каждой отправке'),
  rd: t('cps_block_rd_hint', 'Случайные цифры 0–9 (ASCII); нужен клиент на amneziawg-go 0.2.15+'),
  rc: t('cps_block_rc_hint', 'Случайные латинские буквы; нужен клиент на amneziawg-go 0.2.15+'),
  t: t('cps_block_t_hint', 'Текущее время unix, 4 байта; не больше одного в поле'),
}[tag]);

const cpsErrorText = (error) => {
  const fallback = cpsChainLib ? cpsChainLib.describeError(error) : error.code;
  const text = t(`cps_err_${error.code}`, cpsChainLib ? cpsChainLib.MESSAGES_RU[error.code] || fallback : fallback);
  return error.tag && ['unknown_tag', 'not_applicable', 'tag_case'].includes(error.code) ? `${text}: <${error.tag}>` : text;
};

const parseField = (field) => cpsChainLib.parse(cpsEditorState.text[field], cfgState.cpsCompat);

const hasCustomCpsChains = () => CPS_FIELDS.some((f) => Boolean(cfgState.cpsChains[f]));

/** Своя цепочка поля, которая уйдёт в запрос: только включённая и непустая. */
const syncCfgChain = (field) => {
  const text = cpsEditorState.text[field].trim();
  cfgState.cpsChains[field] = cpsEditorState.custom[field] && text ? text : '';
};

/** Случайные hex-байты для примеров. */
const randomHex = (length) => {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};
const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/** Пример цепочки для поля: та же идея, что у авто-шаблонов сервера, — немного фиксированных байт и runtime-часть. */
const exampleChain = (field) => {
  const b = (min, max) => `<b 0x${randomHex(randomBetween(min, max))}>`;
  const r = (min, max) => `<r ${randomBetween(min, max)}>`;
  const modern = cfgState.cpsCompat === 'modern';
  switch (field) {
    case 'I1': return `${b(8, 16)}<t>${r(48, 96)}`;
    case 'I2': return `${b(4, 8)}<t>${r(48, 120)}`;
    case 'I3': return modern ? `${r(8, 24)}<rd ${randomBetween(6, 16)}>${r(40, 96)}` : `${r(8, 24)}${b(2, 4)}${r(40, 96)}`;
    case 'I4': return modern ? `<t><rc ${randomBetween(8, 24)}>${r(24, 64)}` : `<t>${r(24, 64)}${b(3, 6)}${r(16, 48)}`;
    default: return `${b(6, 12)}${r(64, 140)}`;
  }
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const iconButton = (label, symbol, onClick, extraClass = '') => {
  const btn = el('button', `btn btn--sm btn--ghost cps-block__btn ${extraClass}`.trim(), symbol);
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.addEventListener('click', onClick);
  return btn;
};

/** Что будет в поле без своей цепочки. */
const autoStatusText = (field) => {
  if (field === 'I1') {
    const protocol = cfgState.cpsProtocol === 'auto' ? 'Auto' : cfgState.cpsProtocol.toUpperCase();
    return `${t('cps_field_auto_i1', 'Авто: протокол CPS')} ${protocol}`;
  }
  return cfgState.extraCps
    ? t('cps_field_auto_cps5', 'Авто: шаблон «Усиленной маскировки»')
    : t('cps_field_off', 'Не отправляется');
};

const formatBytes = (n) => `${n} ${t('cps_bytes_unit', 'Б')}`;

/** Строка состояния в шапке поля. */
const fieldStatusText = (field) => {
  if (!cpsEditorState.custom[field]) return autoStatusText(field);
  if (!cpsEditorState.text[field].trim()) return t('cps_field_empty', 'Своя: пусто — будет авто');
  const parsed = parseField(field);
  if (!parsed.ok) return t('cps_field_invalid', 'Своя: есть ошибки');
  return `${t('cps_field_custom', 'Своя')} · ${formatBytes(parsed.bytes)}`;
};

/**
 * Пропуск в I1–I5 (например, своя I3 без I2 и без «Усиленной маскировки»): клиенты на amneziawg-go до 0.2.16
 * отвергают такой конфиг. В Legacy I2–I5 не выводятся — там пропуск не важен.
 */
const currentGap = () => {
  if (!cpsChainLib || (typeof getSelectedProfile === 'function' && getSelectedProfile() === 'legacy')) return null;
  const present = { I1: true };
  for (const field of CPS_FIELDS.slice(1)) present[field] = Boolean(cfgState.cpsChains[field]) || cfgState.extraCps;
  return cpsChainLib.findGap(present);
};

const gapText = (gap) => t('cps_err_gap',
  'задано {field}, а {missing} — нет: клиенты на amneziawg-go до 0.2.16 отвергают пропуски. Задайте {missing} или включите «Усиленную маскировку»')
  .replaceAll('{field}', gap.field).replaceAll('{missing}', gap.missing);

/** Размер, совместимость и ошибки под полем. */
const renderFieldMeta = (field, card) => {
  const meta = card.querySelector('.cps-field__meta');
  const errorsList = card.querySelector('.cps-field__errors');
  const status = card.querySelector('.cps-field__status');
  if (status) status.textContent = fieldStatusText(field);
  const gapHere = currentGap();
  card.classList.toggle('cps-field--invalid', (cpsEditorState.custom[field]
    && Boolean(cpsEditorState.text[field].trim()) && !parseField(field).ok) || Boolean(gapHere && gapHere.field === field));
  if (!meta || !errorsList) return;
  meta.textContent = '';
  errorsList.textContent = '';
  const parsed = parseField(field);
  if (!cpsEditorState.text[field].trim()) {
    meta.append(el('span', 'cps-field__size', t('cps_meta_empty', 'Добавьте блоки или вставьте цепочку текстом.')));
    return;
  }
  meta.append(el('span', 'cps-field__size', `${formatBytes(parsed.bytes)} ${t('cps_meta_of', 'из')} ${cpsChainLib.MAX_PACKET_BYTES}`));
  if (parsed.runtimeBytes > 0) {
    meta.append(el('span', 'cps-field__runtime', `${t('cps_meta_runtime', 'меняются при каждом handshake:')} ${formatBytes(parsed.runtimeBytes)}`));
  } else {
    meta.append(el('span', 'cps-field__runtime cps-field__runtime--none', t('cps_meta_static', 'все байты фиксированные')));
  }
  const badge = parsed.needsModern
    ? el('span', 'tag tag--violet', t('cps_compat_badge_modern', 'клиенты 0.2.15+'))
    : el('span', 'tag tag--green', t('cps_compat_badge_all', 'все клиенты'));
  meta.append(badge);
  if (parsed.bytes > cpsChainLib.MTU_1280_BYTES && parsed.bytes <= cpsChainLib.MAX_PACKET_BYTES) {
    errorsList.append(el('li', 'cps-field__warning', t('cps_warn_mtu',
      'Больше 1252 байт: в сетях с MTU 1280 пакет может фрагментироваться.')));
  }
  for (const error of parsed.errors) {
    const item = el('li', 'cps-field__error', cpsErrorText(error));
    if (error.code === 'modern_only') {
      const fix = el('button', 'btn btn--sm cps-field__fix', t('cps_fix_modern', 'Переключить на «Новые клиенты»'));
      fix.type = 'button';
      fix.addEventListener('click', () => {
        cfgState.cpsCompat = 'modern';
        renderCpsEditor();
        updateParamChips();
      });
      item.append(' ', fix);
    }
    errorsList.append(item);
  }
  const gap = currentGap();
  if (gap && gap.field === field) errorsList.append(el('li', 'cps-field__error', gapText(gap)));
};

/** Сводка всех полей: пропуск зависит от соседних полей, поэтому перерисовываются все, но без потери фокуса. */
const renderAllMeta = () => {
  CPS_FIELDS.forEach((name) => {
    const card = document.querySelector(`[data-cps-field="${name}"]`);
    if (card) renderFieldMeta(name, card);
  });
};

/** Записывает сегменты в текст поля (правка в блоках). */
const writeSegments = (field, segments) => {
  cpsEditorState.text[field] = cpsChainLib.serialize(segments);
  syncCfgChain(field);
};

const renderBlocks = (field, card) => {
  const parsed = parseField(field);
  const segments = parsed.segments.map((s) => ({ ...s }));
  const list = el('ol', 'cps-blocks');
  list.setAttribute('aria-label', `${field}: ${t('cps_blocks_aria', 'блоки цепочки')}`);
  // Только ошибки разбора теряют части текста (у них есть позиция); совместимость, размер и второй <t> — нет
  if (parsed.errors.some((error) => error.at !== undefined)) {
    card.querySelector('.cps-field__body').append(el('p', 'cps-field__note',
      t('cps_blocks_partial', 'В тексте есть ошибки: в блоках показаны только распознанные части. Правка блоков перепишет текст.')));
  }
  segments.forEach((seg, index) => {
    const item = el('li', `cps-block cps-block--${seg.tag}`);
    item.title = blockHint(seg.tag);
    item.append(el('span', 'cps-block__type', blockLabel(seg.tag)));
    const updateMeta = () => { writeSegments(field, segments); renderAllMeta(); updateParamChips(); };
    if (seg.tag === 'b') {
      const prefix = el('span', 'cps-block__prefix', '0x');
      const input = el('input', 'cps-block__input cps-block__input--hex');
      input.type = 'text';
      input.value = seg.hex;
      input.spellcheck = false;
      input.setAttribute('aria-label', `${field} ${blockLabel('b')} ${index + 1}: hex`);
      input.addEventListener('input', () => {
        const clean = input.value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
        if (clean !== input.value) input.value = clean;
        seg.hex = clean;
        // Нечётная длина — пока ещё печатают; в текст идёт как есть, ошибку покажет разбор
        cpsEditorState.text[field] = segments.map((s) => (s.tag === 'b' ? `<b 0x${s.hex}>` : cpsChainLib.segmentText(s))).join('');
        syncCfgChain(field);
        renderAllMeta();
        updateParamChips();
      });
      const randomBtn = iconButton(t('cps_block_b_random', 'Заполнить случайными байтами той же длины'), '⟳', () => {
        seg.hex = randomHex(Math.max(1, Math.floor(seg.hex.length / 2)));
        input.value = seg.hex;
        updateMeta();
      });
      item.append(prefix, input, randomBtn);
    } else if (seg.tag === 't') {
      item.append(el('span', 'cps-block__fixed', formatBytes(cpsChainLib.TIMESTAMP_BYTES)));
    } else {
      const input = el('input', 'cps-block__input cps-block__input--n');
      input.type = 'number';
      input.min = '1';
      input.max = String(cpsChainLib.MAX_N);
      input.value = String(seg.n);
      input.setAttribute('aria-label', `${field} ${blockLabel(seg.tag)} ${index + 1}: ${t('cps_block_length', 'длина')}`);
      input.addEventListener('input', () => {
        seg.n = Number(input.value);
        // Пустое или вне 1..1000 значение идёт в текст как есть — ошибку покажет разбор
        cpsEditorState.text[field] = segments.map((s) => (s === seg ? `<${s.tag} ${input.value}>` : cpsChainLib.segmentText(s))).join('');
        syncCfgChain(field);
        renderAllMeta();
        updateParamChips();
      });
      item.append(input, el('span', 'cps-block__unit', seg.tag === 'r' ? t('cps_bytes_unit', 'Б') : t('cps_chars_unit', 'симв.')));
    }
    const actions = el('span', 'cps-block__actions');
    if (index > 0) {
      actions.append(iconButton(t('cps_block_left', 'Переместить левее'), '←', () => {
        [segments[index - 1], segments[index]] = [segments[index], segments[index - 1]];
        writeSegments(field, segments);
        renderField(field);
      }));
    }
    if (index < segments.length - 1) {
      actions.append(iconButton(t('cps_block_right', 'Переместить правее'), '→', () => {
        [segments[index + 1], segments[index]] = [segments[index], segments[index + 1]];
        writeSegments(field, segments);
        renderField(field);
      }));
    }
    actions.append(iconButton(t('cps_block_remove', 'Удалить блок'), '✕', () => {
      segments.splice(index, 1);
      writeSegments(field, segments);
      renderField(field);
    }, 'cps-block__btn--remove'));
    item.append(actions);
    list.append(item);
  });

  const palette = el('div', 'cps-palette');
  palette.setAttribute('role', 'group');
  palette.setAttribute('aria-label', `${field}: ${t('cps_palette_aria', 'добавить блок')}`);
  for (const tag of CPS_BLOCK_ORDER) {
    const disabled = (cpsChainLib.TAGS[tag].modernOnly && cfgState.cpsCompat === 'all')
      || (tag === 't' && segments.some((s) => s.tag === 't'));
    const btn = el('button', 'btn btn--sm cps-palette__btn', `+ ${blockLabel(tag)}`);
    btn.type = 'button';
    btn.title = disabled && tag !== 't'
      ? t('cps_palette_modern_only', 'Доступно при совместимости «Новые клиенты»')
      : blockHint(tag);
    btn.disabled = disabled;
    btn.addEventListener('click', () => {
      const seg = { ...CPS_BLOCK_DEFAULTS[tag] };
      if (tag === 'b') seg.hex = randomHex(4);
      segments.push(seg);
      writeSegments(field, segments);
      renderField(field);
    });
    palette.append(btn);
  }
  return [list, palette];
};

const renderText = (field) => {
  const area = el('textarea', 'cps-field__text');
  area.rows = 3;
  area.spellcheck = false;
  area.value = cpsEditorState.text[field];
  area.placeholder = '<b 0x…><t><r 64>';
  area.setAttribute('aria-label', `${field}: ${t('cps_text_aria', 'цепочка текстом')}`);
  area.addEventListener('input', () => {
    cpsEditorState.text[field] = area.value;
    syncCfgChain(field);
    renderAllMeta();
    updateParamChips();
  });
  return [area];
};

/** Перерисовывает одно поле целиком (смена вида, блоков, включение своей цепочки). */
const renderField = (field) => {
  const container = document.getElementById('cpsEditorFields');
  if (!container || !cpsChainLib) return;
  const existing = container.querySelector(`[data-cps-field="${field}"]`);
  const card = el('section', 'cps-field');
  card.dataset.cpsField = field;

  const head = el('div', 'cps-field__head');
  head.append(el('span', 'cps-field__name', field));
  head.append(el('span', 'cps-field__status'));
  const switchLabel = el('label', 'cps-field__switch');
  const toggle = el('input', 'switch');
  toggle.type = 'checkbox';
  toggle.checked = cpsEditorState.custom[field];
  toggle.setAttribute('aria-label', `${field}: ${t('cps_field_custom_toggle', 'своя цепочка')}`);
  toggle.addEventListener('change', () => {
    cpsEditorState.custom[field] = toggle.checked;
    if (toggle.checked && !cpsEditorState.text[field].trim()) cpsEditorState.text[field] = exampleChain(field);
    syncCfgChain(field);
    renderField(field);
    updateParamChips();
  });
  switchLabel.append(toggle, el('span', 'cps-field__switch-text', t('cps_field_custom_toggle_label', 'Своя')));
  head.append(switchLabel);
  card.append(head);

  const body = el('div', 'cps-field__body');
  body.hidden = !cpsEditorState.custom[field];
  card.append(body);
  if (existing) existing.replaceWith(card); else container.append(card);

  if (cpsEditorState.custom[field]) {
    const views = el('div', 'route-mode-toggle cps-field__views');
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', `${field}: ${t('cps_view_aria', 'вид редактора')}`);
    for (const [view, label] of [['blocks', t('cps_view_blocks', 'Блоки')], ['text', t('cps_view_text', 'Текст')]]) {
      const btn = el('button', `route-mode-btn${cpsEditorState.view[field] === view ? ' route-mode-btn--active' : ''}`, label);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(cpsEditorState.view[field] === view));
      btn.addEventListener('click', () => { cpsEditorState.view[field] = view; renderField(field); });
      views.append(btn);
    }
    body.append(views);
    const parts = cpsEditorState.view[field] === 'text' ? renderText(field) : renderBlocks(field, card);
    body.append(...parts);
    body.append(el('div', 'cps-field__meta'));
    const errors = el('ul', 'cps-field__errors');
    errors.setAttribute('role', 'status');
    body.append(errors);
    const tools = el('div', 'cps-field__tools');
    const exampleBtn = el('button', 'btn btn--sm', t('cps_example_btn', 'Пример'));
    exampleBtn.type = 'button';
    exampleBtn.title = t('cps_example_title', 'Заменить цепочку случайным примером');
    exampleBtn.addEventListener('click', () => {
      cpsEditorState.text[field] = exampleChain(field);
      syncCfgChain(field);
      renderField(field);
      updateParamChips();
    });
    const clearBtn = el('button', 'btn btn--sm btn--ghost', t('cps_clear_btn', 'Очистить'));
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      cpsEditorState.text[field] = '';
      syncCfgChain(field);
      renderField(field);
      updateParamChips();
    });
    tools.append(exampleBtn, clearBtn);
    body.append(tools);
  }
  renderAllMeta();
};

const renderCompat = () => {
  document.querySelectorAll('[data-cps-compat]').forEach((btn) => {
    const active = btn.dataset.cpsCompat === cfgState.cpsCompat;
    btn.classList.toggle('route-mode-btn--active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const hint = document.getElementById('cpsCompatHint');
  if (hint) {
    hint.textContent = cfgState.cpsCompat === 'modern'
      ? t('cps_compat_modern_hint', 'Доступны <rd> и <rc>. Клиенты на amneziawg-go старше 0.2.15 (выпуск 1 сентября 2025) не примут такой конфиг.')
      : t('cps_compat_all_hint', 'Только <b>, <r> и <t>: конфиг примут все клиенты с поддержкой I1–I5.');
  }
};

/** Перерисовывает весь редактор (язык, сброс, ссылка, история). */
const renderCpsEditor = () => {
  if (!cpsChainLib) return;
  renderCompat();
  CPS_FIELDS.forEach(renderField);
};

/**
 * Загружает цепочки в редактор: непустые становятся своими, остальные — авто.
 * @param {Record<string, string>} chains  ключи I1..I5
 * @param {{ compat?: 'all'|'modern' }} [options]
 */
const setCpsChains = (chains, { compat } = {}) => {
  if (compat && cpsChainLib && cpsChainLib.isCompat(compat)) cfgState.cpsCompat = compat;
  for (const field of CPS_FIELDS) {
    const text = String((chains && chains[field]) || '').trim();
    cpsEditorState.custom[field] = Boolean(text);
    cpsEditorState.text[field] = text;
    syncCfgChain(field);
  }
  // Цепочка с <rd>/<rc> сама по себе требует новых клиентов
  if (cpsChainLib && CPS_FIELDS.some((f) => cfgState.cpsChains[f] && cpsChainLib.parse(cfgState.cpsChains[f], 'modern').needsModern)) {
    cfgState.cpsCompat = 'modern';
  }
  renderCpsEditor();
  updateParamChips();
};

const resetCpsEditor = () => {
  cfgState.cpsCompat = 'all';
  setCpsChains({});
};

/**
 * Свои цепочки для запроса /api/warp. Ошибка в любой включённой цепочке останавливает генерацию.
 * @returns {{ hasCustom: boolean, body: Record<string, string>, error: { field: string, message: string } | null }}
 */
const getCpsRequest = () => {
  const body = {};
  if (!cpsChainLib) return { hasCustom: false, body, error: null };
  for (const field of CPS_FIELDS) {
    const text = cfgState.cpsChains[field];
    if (!text) continue;
    const parsed = cpsChainLib.parse(text, cfgState.cpsCompat);
    if (!parsed.ok || parsed.segments.length === 0) {
      const first = parsed.errors[0] || { code: 'empty_tag' };
      return { hasCustom: true, body, error: { field, message: `${field}: ${cpsErrorText(first)}` } };
    }
    body[field.toLowerCase()] = parsed.canonical;
  }
  const hasCustom = Object.keys(body).length > 0;
  const gap = hasCustom ? currentGap() : null;
  if (gap) return { hasCustom, body, error: { field: gap.field, message: `${gap.field}: ${gapText(gap)}` } };
  if (hasCustom) body.cpsCompat = cfgState.cpsCompat;
  return { hasCustom, body, error: null };
};

const importFromConf = () => {
  const area = document.getElementById('cpsImportText');
  if (!area || !cpsChainLib) return;
  const chains = cpsChainLib.extractFromConf(area.value);
  const count = Object.keys(chains).length;
  if (!count) {
    toast(t('cps_import_none', 'В тексте нет строк I1–I5.'), 'info');
    return;
  }
  setCpsChains(chains);
  area.value = '';
  toast(`${t('cps_import_done', 'Загружено полей:')} ${count}`, 'success');
};

const initCpsEditor = () => {
  if (!cpsChainLib || !document.getElementById('cpsEditorFields')) return;
  document.querySelectorAll('[data-cps-compat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cfgState.cpsCompat = btn.dataset.cpsCompat;
      renderCpsEditor();
      updateParamChips();
    });
  });
  const importBtn = document.getElementById('cpsImportBtn');
  if (importBtn) importBtn.addEventListener('click', importFromConf);
  const importArea = document.getElementById('cpsImportText');
  if (importArea) importArea.placeholder = t('cps_import_placeholder', 'Вставьте текст .conf или строки «I1 = …»');
  // Подписи «авто» зависят от протокола CPS и переключателя I2–I5 из других вкладок
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target && (target.id === 'cps5Toggle' || target.name === 'cpsProtocol' || target.name === 'awgProfile')) {
      CPS_FIELDS.forEach((field) => {
        const card = document.querySelector(`[data-cps-field="${field}"]`);
        if (card) renderFieldMeta(field, card);
      });
    }
  });
  renderCpsEditor();
};
