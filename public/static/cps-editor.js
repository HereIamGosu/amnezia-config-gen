// public/static/cps-editor.js
//
// CPS-пакеты перед handshake во вкладке «Дополнительно». Сверху — готовые варианты в один клик
// (Стандарт / Усиленная / Больше случайности / Ручная настройка); ручной режим открывает редактор I1–I5:
// у каждого поля «авто» или своя цепочка из блоков (байты, случайные байты, цифры, буквы, время) или текстом.
// Редактор не даёт собрать то, что сломает клиент: hex только чётной длины, длины 1–1000, пакет до 1472 байт,
// пропуск в I1–I5 закрывается сам, <rd>/<rc> при «Все клиенты» заменяются после вопроса. Разбор и проверку
// делает public/static/cps-chain.js (window.CpsChain) — тот же код проверяет /api/warp.
// Состояние: cfgState.cpsPreset, cfgState.cpsChains (канонический текст или '' = авто), cfgState.cpsCompat
// ('all' | 'modern'), cfgState.extraCps (авто-пакеты I2–I5, параметр cps5).
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → cps-editor.js → settings-link.js →
// history.js → script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t -- i18n.js */
/* global toast, openModal, uiShell -- common.js */
/* global cfgState, updateParamChips -- settings.js */
/* global getSelectedProfile -- script.js */
/* exported initCpsEditor, renderCpsEditor, setCpsChains, resetCpsEditor, getCpsRequest, hasCustomCpsChains,
   syncCpsPresetFromState, confirmReplaceCpsChains */

const cpsChainLib = window.CpsChain || null;

const CPS_FIELDS = ['I1', 'I2', 'I3', 'I4', 'I5'];
const CPS_PRESETS = ['standard', 'enhanced', 'random', 'manual'];
/** Блоки палитры в порядке кнопок «+». */
const CPS_BLOCK_ORDER = ['b', 'r', 'rd', 'rc', 't'];
const CPS_BLOCK_DEFAULT_N = { r: 32, rd: 8, rc: 8 };

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
  if (error.code === 'empty_chain') return t('cps_err_empty_chain', 'цепочка пустая: добавьте блок или выключите «Своя»');
  const fallback = cpsChainLib ? cpsChainLib.describeError(error) : error.code;
  const text = t(`cps_err_${error.code}`, cpsChainLib ? cpsChainLib.MESSAGES_RU[error.code] || fallback : fallback);
  return error.tag && ['unknown_tag', 'not_applicable', 'tag_case'].includes(error.code) ? `${text}: <${error.tag}>` : text;
};

const fieldList = (fields) => fields.join(', ');

const parseField = (field) => cpsChainLib.parse(cpsEditorState.text[field], cfgState.cpsCompat);

const hasCustomCpsChains = () => CPS_FIELDS.some((f) => Boolean(cfgState.cpsChains[f]));

const isLegacyProfile = () => typeof getSelectedProfile === 'function' && getSelectedProfile() === 'legacy';

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

/**
 * Пример цепочки для поля: немного фиксированных байт и runtime-часть, как у авто-шаблонов сервера.
 * modern — с цифрами и буквами (<rd>/<rc>), для «Больше случайности» и совместимости «Новые клиенты».
 */
const exampleChain = (field, modern = cfgState.cpsCompat === 'modern') => {
  const b = (min, max) => `<b 0x${randomHex(randomBetween(min, max))}>`;
  const r = (min, max) => `<r ${randomBetween(min, max)}>`;
  const rd = (min, max) => `<rd ${randomBetween(min, max)}>`;
  const rc = (min, max) => `<rc ${randomBetween(min, max)}>`;
  switch (field) {
    case 'I1': return `${b(8, 16)}<t>${r(48, 96)}`;
    case 'I2': return modern ? `${b(4, 8)}<t>${rd(8, 16)}${r(40, 100)}` : `${b(4, 8)}<t>${r(48, 120)}`;
    case 'I3': return modern ? `${r(8, 24)}${rc(8, 20)}${r(32, 80)}` : `${r(8, 24)}${b(2, 4)}${r(40, 96)}`;
    case 'I4': return modern ? `<t>${rc(8, 24)}${r(24, 64)}${rd(4, 10)}` : `<t>${r(24, 64)}${b(3, 6)}${r(16, 48)}`;
    default: return modern ? `${b(6, 12)}${rd(6, 12)}${r(56, 120)}` : `${b(6, 12)}${r(64, 140)}`;
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

const formatBytes = (n) => `${n} ${t('cps_bytes_unit', 'Б')}`;

// ── Диалог подтверждения ─────────────────────────────────────────────────────────────────────────────────

let cpsConfirmAction = null;

/**
 * Вопрос с двумя ответами поверх настроек (#cpsConfirmModal). onConfirm — по «Да»; закрытие и «Отмена» —
 * ничего не меняют. Без разметки диалога (страница Lab) — действие без вопроса не выполняется.
 */
const askCpsConfirm = ({ title, text, confirmLabel }, onConfirm) => {
  const modal = document.getElementById('cpsConfirmModal');
  if (!modal) return;
  document.getElementById('cpsConfirmTitle').textContent = title;
  document.getElementById('cpsConfirmText').textContent = text;
  document.getElementById('cpsConfirmOk').textContent = confirmLabel;
  cpsConfirmAction = onConfirm;
  openModal('cpsConfirmModal', document.activeElement);
};

const closeCpsConfirm = () => {
  cpsConfirmAction = null;
  if (uiShell) uiShell.closeModal('cpsConfirmModal');
};

/**
 * Перед заменой уже заданных своих цепочек (импорт, история, ссылка) — вопрос; без своих — сразу.
 * @param {() => void} apply
 */
const confirmReplaceCpsChains = (apply) => {
  if (!hasCustomCpsChains()) { apply(); return; }
  askCpsConfirm({
    title: t('cps_confirm_replace_title', 'Заменить свои цепочки?'),
    text: `${t('cps_confirm_replace_text', 'Сейчас заданы свои цепочки:')} ${fieldList(CPS_FIELDS.filter((f) => cfgState.cpsChains[f]))}. ${t('cps_confirm_replace_text2', 'Они будут заменены.')}`,
    confirmLabel: t('cps_confirm_replace_ok', 'Заменить'),
  }, apply);
};

// ── Пропуски в I1–I5 ─────────────────────────────────────────────────────────────────────────────────────

/** Будет ли поле в конфиге: своя непустая цепочка или авто-пакет I2–I5. I1 есть всегда (протокол или своя). */
const fieldPresent = (field) => field === 'I1' || Boolean(cfgState.cpsChains[field]) || cfgState.extraCps;

const currentGap = () => {
  if (!cpsChainLib || isLegacyProfile()) return null;
  const present = {};
  for (const field of CPS_FIELDS) present[field] = fieldPresent(field);
  return cpsChainLib.findGap(present);
};

/**
 * Клиенты на amneziawg-go до 0.2.16 отвергают пропуск в I1–I5. Пропуск не допускаем: каждое пустое поле перед
 * последним заданным получает случайную цепочку, о чём говорит уведомление.
 */
const fillGaps = () => {
  if (cfgState.extraCps) return [];
  const lastCustom = CPS_FIELDS.reduce((last, f, i) => (cfgState.cpsChains[f] ? i : last), -1);
  const filled = [];
  for (let i = 1; i < lastCustom; i += 1) {
    const field = CPS_FIELDS[i];
    // Своё поле, которое сейчас пустое, не перезаписываем: его правят, ошибку покажет «цепочка пустая»
    if (cfgState.cpsChains[field] || cpsEditorState.custom[field]) continue;
    cpsEditorState.custom[field] = true;
    cpsEditorState.text[field] = exampleChain(field);
    syncCfgChain(field);
    filled.push(field);
  }
  if (filled.length) {
    toast(`${t('cps_gap_filled', 'Заполнено случайной цепочкой, чтобы в I1–I5 не было пропуска:')} ${fieldList(filled)}`, 'info');
  }
  return filled;
};

/** Последние своя поля после field, которые без него оставили бы пропуск (только без авто-пакетов). */
const dependentFields = (field) => {
  if (cfgState.extraCps || field === 'I1') return [];
  const index = CPS_FIELDS.indexOf(field);
  return CPS_FIELDS.slice(index + 1).filter((f) => cfgState.cpsChains[f]);
};

// ── Готовые варианты ─────────────────────────────────────────────────────────────────────────────────────

const setFieldsAuto = () => {
  for (const field of CPS_FIELDS) {
    cpsEditorState.custom[field] = false;
    cpsEditorState.text[field] = '';
    syncCfgChain(field);
  }
};

/** Вариант по текущему состоянию — для ссылки, истории и импорта. */
const presetFromState = () => {
  if (hasCustomCpsChains()) return 'manual';
  return cfgState.extraCps ? 'enhanced' : 'standard';
};

const applyPreset = (preset) => {
  cfgState.cpsPreset = preset;
  if (preset === 'standard' || preset === 'enhanced') {
    setFieldsAuto();
    cfgState.extraCps = preset === 'enhanced';
    cfgState.cpsCompat = 'all';
  } else if (preset === 'random') {
    setFieldsAuto();
    cfgState.extraCps = false;
    cfgState.cpsCompat = 'modern';
    for (const field of CPS_FIELDS.slice(1)) {
      cpsEditorState.custom[field] = true;
      cpsEditorState.text[field] = exampleChain(field, true);
      syncCfgChain(field);
    }
  }
  // 'manual' оставляет текущие поля как есть: редактор показывает то, что даст выбранный до этого вариант
  renderCpsEditor();
  updateParamChips();
};

/** Ставит вариант по состоянию (после ссылки или сброса), если посетитель не в ручном режиме. */
const syncCpsPresetFromState = () => {
  const derived = presetFromState();
  if (derived === 'manual' || cfgState.cpsPreset !== 'manual') cfgState.cpsPreset = derived;
  renderCpsEditor();
};

// ── Поля ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Что будет в поле без своей цепочки. */
const autoStatusText = (field) => {
  if (field === 'I1') {
    const protocol = cfgState.cpsProtocol === 'auto' ? 'Auto' : cfgState.cpsProtocol.toUpperCase();
    return `${t('cps_field_auto_i1', 'Авто: протокол CPS')} ${protocol}`;
  }
  return cfgState.extraCps
    ? t('cps_field_auto_cps5', 'Авто: шаблон генератора')
    : t('cps_field_off', 'Не отправляется');
};

/** Строка состояния в шапке поля. */
const fieldStatusText = (field) => {
  if (!cpsEditorState.custom[field]) return autoStatusText(field);
  if (!cpsEditorState.text[field].trim()) return t('cps_field_empty_custom', 'Своя: пусто');
  const parsed = parseField(field);
  if (!parsed.ok) return t('cps_field_invalid', 'Своя: есть ошибки');
  return `${t('cps_field_custom', 'Своя')} · ${formatBytes(parsed.bytes)}`;
};

/** Ошибки поля для подсветки и запроса: разбор, пустая своя цепочка. */
const fieldErrors = (field) => {
  if (!cpsEditorState.custom[field]) return [];
  if (!cpsEditorState.text[field].trim()) return [{ code: 'empty_chain' }];
  return parseField(field).errors;
};

/** Сколько байт свободно в пакете без сегмента skipIndex (предел 1472). */
const freeBytes = (segments, skipIndex = -1) => cpsChainLib.MAX_PACKET_BYTES
  - segments.reduce((n, s, i) => (i === skipIndex ? n : n + cpsChainLib.segmentBytes(s)), 0);

/** Размер, совместимость, ошибки и предупреждения под полем. */
const renderFieldMeta = (field, card) => {
  const meta = card.querySelector('.cps-field__meta');
  const errorsList = card.querySelector('.cps-field__errors');
  const status = card.querySelector('.cps-field__status');
  if (status) status.textContent = fieldStatusText(field);
  const errors = fieldErrors(field);
  card.classList.toggle('cps-field--invalid', errors.length > 0);
  if (!meta || !errorsList) return;
  meta.textContent = '';
  errorsList.textContent = '';
  const parsed = parseField(field);
  if (cpsEditorState.text[field].trim()) {
    meta.append(el('span', 'cps-field__size', `${formatBytes(parsed.bytes)} ${t('cps_meta_of', 'из')} ${cpsChainLib.MAX_PACKET_BYTES}`));
    if (parsed.runtimeBytes > 0) {
      meta.append(el('span', 'cps-field__runtime', `${t('cps_meta_runtime', 'меняются при каждом handshake:')} ${formatBytes(parsed.runtimeBytes)}`));
    }
    meta.append(parsed.needsModern
      ? el('span', 'tag tag--violet', t('cps_compat_badge_modern', 'клиенты 0.2.15+'))
      : el('span', 'tag tag--green', t('cps_compat_badge_all', 'все клиенты')));
  }
  const warn = (text) => errorsList.append(el('li', 'cps-field__warning', text));
  if (field === 'I1' && cpsEditorState.custom.I1) {
    warn(t('cps_warn_i1_replaces', 'Своя I1 заменяет протокол CPS с вкладки «DNS & CPS».'));
  }
  if (parsed.ok && parsed.segments.length && parsed.runtimeBytes === 0) {
    warn(t('cps_warn_static', 'В цепочке нет случайных блоков: пакет одинаковый в каждом handshake. Добавьте «Случайные байты».'));
  }
  if (parsed.bytes > cpsChainLib.MTU_1280_BYTES && parsed.bytes <= cpsChainLib.MAX_PACKET_BYTES) {
    warn(t('cps_warn_mtu', 'Больше 1252 байт: в сетях с MTU 1280 пакет может фрагментироваться.'));
  }
  for (const error of errors) errorsList.append(el('li', 'cps-field__error', cpsErrorText(error)));
};

const renderAllMeta = () => {
  CPS_FIELDS.forEach((name) => {
    const card = document.querySelector(`[data-cps-field="${name}"]`);
    if (card) renderFieldMeta(name, card);
  });
};

/** После правки поля: заполнить пропуски, обновить сводки и чипы. */
const afterFieldChange = (field, { rerender = false } = {}) => {
  syncCfgChain(field);
  const filled = fillGaps();
  if (rerender) renderField(field);
  filled.forEach(renderField);
  renderAllMeta();
  updateParamChips();
};

/** Записывает сегменты в текст поля (правка в блоках). */
const writeSegments = (field, segments) => {
  cpsEditorState.text[field] = cpsChainLib.serialize(segments);
};

/** Причина, по которой блок нельзя добавить ('' — можно). */
const paletteReason = (tag, segments) => {
  const size = tag === 't' ? cpsChainLib.TIMESTAMP_BYTES : 1;
  if (cpsChainLib.TAGS[tag].modernOnly && cfgState.cpsCompat === 'all') return t('cps_palette_modern_only', 'Доступно при совместимости «Новые клиенты»');
  if (tag === 't' && segments.some((s) => s.tag === 't')) return t('cps_palette_t_once', 'Время уже есть: в поле может быть только одно');
  if (freeBytes(segments) < size) return t('cps_palette_full', 'Пакет заполнен: больше 1472 байт нельзя');
  return '';
};

/** Пределы полей ввода и доступность палитры по текущим блокам — без перерисовки, фокус остаётся на месте. */
const refreshLimits = (list, palette, segments) => {
  list.querySelectorAll('.cps-block__input--n').forEach((input) => {
    input.max = String(Math.max(1, Math.min(cpsChainLib.MAX_N, freeBytes(segments, Number(input.dataset.index)))));
  });
  list.querySelectorAll('.cps-block__input--hex').forEach((input) => {
    input.maxLength = Math.max(2, freeBytes(segments, Number(input.dataset.index)) * 2);
  });
  palette.querySelectorAll('.cps-palette__btn').forEach((btn) => {
    const reason = paletteReason(btn.dataset.tag, segments);
    btn.disabled = Boolean(reason);
    btn.title = reason || blockHint(btn.dataset.tag);
  });
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
  const palette = el('div', 'cps-palette');
  segments.forEach((seg, index) => {
    const item = el('li', `cps-block cps-block--${seg.tag}`);
    item.title = blockHint(seg.tag);
    item.append(el('span', 'cps-block__type', blockLabel(seg.tag)));
    if (seg.tag === 'b') {
      const prefix = el('span', 'cps-block__prefix', '0x');
      const input = el('input', 'cps-block__input cps-block__input--hex');
      input.type = 'text';
      input.value = seg.hex;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.inputMode = 'text';
      // Не больше, чем помещается в пакет: 2 hex-цифры на байт
      input.dataset.index = String(index);
      input.setAttribute('aria-label', `${field} ${blockLabel('b')} ${index + 1}: hex`);
      input.addEventListener('input', () => {
        // Не больше, чем помещается в пакет вместе с остальными блоками: 2 hex-цифры на байт
        const allowed = Math.max(2, freeBytes(segments, index) * 2);
        const clean = input.value.replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, allowed);
        if (clean !== input.value) input.value = clean;
        // Пока печатают нечётное число цифр, в цепочку идёт с ведущим нулём — так же, как после выхода из поля
        seg.hex = clean.length % 2 ? `0${clean}` : clean;
        writeSegments(field, segments.map((s) => (s === seg && !seg.hex ? { tag: 'b', hex: '00' } : s)));
        afterFieldChange(field);
        refreshLimits(list, palette, segments);
      });
      // Нечётная длина и пустое поле исправляются при выходе: «a» → «0a», пусто → «00»
      input.addEventListener('blur', () => {
        const clean = input.value;
        const fixed = !clean ? '00' : clean.length % 2 ? `0${clean}` : clean;
        if (fixed !== clean) {
          input.value = fixed;
          seg.hex = fixed;
          writeSegments(field, segments);
          afterFieldChange(field);
        }
      });
      const randomBtn = iconButton(t('cps_block_b_random', 'Заполнить случайными байтами той же длины'), '⟳', () => {
        seg.hex = randomHex(Math.max(1, Math.floor(seg.hex.length / 2)));
        input.value = seg.hex;
        writeSegments(field, segments);
        afterFieldChange(field);
      });
      item.append(prefix, input, randomBtn);
    } else if (seg.tag === 't') {
      item.append(el('span', 'cps-block__fixed', formatBytes(cpsChainLib.TIMESTAMP_BYTES)));
    } else {
      const input = el('input', 'cps-block__input cps-block__input--n');
      input.type = 'number';
      input.min = '1';
      input.dataset.index = String(index);
      input.step = '1';
      input.inputMode = 'numeric';
      input.value = String(seg.n);
      input.setAttribute('aria-label', `${field} ${blockLabel(seg.tag)} ${index + 1}: ${t('cps_block_length', 'длина')}`);
      // Предел — в момент ввода: 1–1000 и не больше свободного места в пакете с учётом остальных блоков
      const clamp = () => {
        const limit = Math.max(1, Math.min(cpsChainLib.MAX_N, freeBytes(segments, index)));
        const n = Math.round(Number(input.value));
        return Number.isFinite(n) ? Math.min(limit, Math.max(1, n)) : seg.n;
      };
      input.addEventListener('input', () => {
        seg.n = clamp();
        writeSegments(field, segments);
        afterFieldChange(field);
        refreshLimits(list, palette, segments);
      });
      // Значение вне 1–max подтягивается к границе при выходе из поля
      input.addEventListener('blur', () => { input.value = String(seg.n); });
      item.append(input, el('span', 'cps-block__unit', seg.tag === 'r' ? t('cps_bytes_unit', 'Б') : t('cps_chars_unit', 'симв.')));
    }
    const actions = el('span', 'cps-block__actions');
    if (index > 0) {
      actions.append(iconButton(t('cps_block_left', 'Переместить левее'), '←', () => {
        [segments[index - 1], segments[index]] = [segments[index], segments[index - 1]];
        writeSegments(field, segments);
        afterFieldChange(field, { rerender: true });
      }));
    }
    if (index < segments.length - 1) {
      actions.append(iconButton(t('cps_block_right', 'Переместить правее'), '→', () => {
        [segments[index + 1], segments[index]] = [segments[index], segments[index + 1]];
        writeSegments(field, segments);
        afterFieldChange(field, { rerender: true });
      }));
    }
    actions.append(iconButton(t('cps_block_remove', 'Удалить блок'), '✕', () => {
      segments.splice(index, 1);
      writeSegments(field, segments);
      afterFieldChange(field, { rerender: true });
    }, 'cps-block__btn--remove'));
    item.append(actions);
    list.append(item);
  });

  palette.setAttribute('role', 'group');
  palette.setAttribute('aria-label', `${field}: ${t('cps_palette_aria', 'добавить блок')}`);
  for (const tag of CPS_BLOCK_ORDER) {
    const btn = el('button', 'btn btn--sm cps-palette__btn', `+ ${blockLabel(tag)}`);
    btn.type = 'button';
    btn.dataset.tag = tag;
    btn.addEventListener('click', () => {
      const free = freeBytes(segments);
      const seg = tag === 'b' ? { tag: 'b', hex: randomHex(Math.min(4, free)) }
        : tag === 't' ? { tag: 't' } : { tag, n: Math.min(CPS_BLOCK_DEFAULT_N[tag], free) };
      segments.push(seg);
      writeSegments(field, segments);
      afterFieldChange(field, { rerender: true });
    });
    palette.append(btn);
  }
  refreshLimits(list, palette, segments);
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
    afterFieldChange(field);
  });
  return [area];
};

/** Выключение своей цепочки: если без неё возникнет пропуск — вопрос, выключить ли и зависящие поля. */
const turnFieldAuto = (field, toggle) => {
  const dependents = dependentFields(field);
  const apply = (fields) => {
    for (const f of fields) {
      cpsEditorState.custom[f] = false;
      syncCfgChain(f);
      renderField(f);
    }
    renderAllMeta();
    updateParamChips();
  };
  if (!dependents.length) { apply([field]); return; }
  if (toggle) toggle.checked = true;
  askCpsConfirm({
    title: t('cps_confirm_gap_title', 'Выключить и следующие поля?'),
    text: t('cps_confirm_gap_text', 'Без {field} поля {fields} останутся с пропуском, а клиенты на amneziawg-go до 0.2.16 такой конфиг не примут. Выключить их тоже?')
      .replaceAll('{field}', field).replaceAll('{fields}', fieldList(dependents)),
    confirmLabel: t('cps_confirm_gap_ok', 'Выключить все'),
  }, () => apply([field, ...dependents]));
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
    if (!toggle.checked) { turnFieldAuto(field, toggle); return; }
    cpsEditorState.custom[field] = true;
    if (!cpsEditorState.text[field].trim()) cpsEditorState.text[field] = exampleChain(field);
    afterFieldChange(field, { rerender: true });
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
    const exampleBtn = el('button', 'btn btn--sm', t('cps_example_btn', 'Случайная цепочка'));
    exampleBtn.type = 'button';
    exampleBtn.title = t('cps_example_title', 'Заменить цепочку новой случайной');
    exampleBtn.addEventListener('click', () => {
      cpsEditorState.text[field] = exampleChain(field);
      afterFieldChange(field, { rerender: true });
    });
    const autoBtn = el('button', 'btn btn--sm btn--ghost', t('cps_auto_btn', 'Вернуть авто'));
    autoBtn.type = 'button';
    autoBtn.addEventListener('click', () => turnFieldAuto(field, null));
    tools.append(exampleBtn, autoBtn);
    body.append(tools);
  }
  renderFieldMeta(field, card);
};

// ── Совместимость ────────────────────────────────────────────────────────────────────────────────────────

/** Поля со своими цепочками, где есть <rd>/<rc>. */
const modernOnlyFields = () => CPS_FIELDS.filter((f) => cfgState.cpsChains[f]
  && cpsChainLib.parse(cfgState.cpsChains[f], 'modern').needsModern);

/** «Все клиенты» с <rd>/<rc> в цепочках: вопрос и замена на <r> той же длины; отмена оставляет «Новые клиенты». */
const chooseCompat = (compat) => {
  if (compat === cfgState.cpsCompat) return;
  const affected = compat === 'all' ? modernOnlyFields() : [];
  const apply = () => {
    for (const field of affected) {
      const parsed = cpsChainLib.parse(cfgState.cpsChains[field], 'modern');
      cpsEditorState.text[field] = cpsChainLib.serialize(parsed.segments
        .map((s) => (s.tag === 'rd' || s.tag === 'rc' ? { tag: 'r', n: s.n } : s)));
      syncCfgChain(field);
    }
    cfgState.cpsCompat = compat;
    renderCpsEditor();
    updateParamChips();
  };
  if (!affected.length) { apply(); return; }
  askCpsConfirm({
    title: t('cps_confirm_compat_title', 'Заменить цифры и буквы?'),
    text: t('cps_confirm_compat_text', 'В {fields} есть случайные цифры или буквы — их не понимают клиенты на amneziawg-go до 0.2.15. Заменить их случайными байтами той же длины?')
      .replaceAll('{fields}', fieldList(affected)),
    confirmLabel: t('cps_confirm_compat_ok', 'Заменить'),
  }, apply);
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

// ── Секция целиком ───────────────────────────────────────────────────────────────────────────────────────

const renderPresets = () => {
  document.querySelectorAll('[name="cpsPreset"]').forEach((radio) => {
    radio.checked = radio.value === cfgState.cpsPreset;
  });
  const manual = document.getElementById('cpsManual');
  if (manual) manual.hidden = cfgState.cpsPreset !== 'manual';
  const autoExtra = document.getElementById('cpsAutoExtra');
  if (autoExtra) autoExtra.checked = cfgState.extraCps;
  const legacy = document.getElementById('cpsLegacyNote');
  if (legacy) legacy.hidden = !isLegacyProfile();
  const reroll = document.getElementById('cpsPresetReroll');
  if (reroll) reroll.hidden = cfgState.cpsPreset !== 'random';
};

/** Перерисовывает всю секцию (язык, сброс, ссылка, история). */
const renderCpsEditor = () => {
  if (!cpsChainLib) return;
  renderPresets();
  renderCompat();
  CPS_FIELDS.forEach(renderField);
};

/**
 * Загружает цепочки: непустые становятся своими, остальные — авто; с цепочками — ручной режим.
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
  if (cpsChainLib && modernOnlyFields().length) cfgState.cpsCompat = 'modern';
  fillGaps();
  cfgState.cpsPreset = presetFromState();
  renderCpsEditor();
  updateParamChips();
};

const resetCpsEditor = () => {
  cfgState.cpsCompat = 'all';
  cfgState.cpsPreset = 'standard';
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
    const errors = fieldErrors(field);
    if (errors.length) return { hasCustom: true, body, error: { field, message: `${field}: ${cpsErrorText(errors[0])}` } };
    const text = cfgState.cpsChains[field];
    if (!text) continue;
    body[field.toLowerCase()] = cpsChainLib.parse(text, cfgState.cpsCompat).canonical;
  }
  const hasCustom = Object.keys(body).length > 0;
  const gap = hasCustom ? currentGap() : null;
  if (gap) {
    return { hasCustom, body, error: { field: gap.field, message: `${gap.field}: ${t('cps_err_gap', 'пропуск в I1–I5').replaceAll('{field}', gap.field).replaceAll('{missing}', gap.missing)}` } };
  }
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
  confirmReplaceCpsChains(() => {
    setCpsChains(chains);
    area.value = '';
    toast(`${t('cps_import_done', 'Загружено полей:')} ${count}`, 'success');
  });
};

const initCpsEditor = () => {
  if (!cpsChainLib || !document.getElementById('cpsEditorFields')) return;
  if (!CPS_PRESETS.includes(cfgState.cpsPreset)) cfgState.cpsPreset = presetFromState();
  document.querySelectorAll('[name="cpsPreset"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      // Готовый вариант, кроме ручного, заменяет свои цепочки — сначала вопрос; без ответа выбор не меняется
      if (radio.value === 'manual' || !hasCustomCpsChains()) { applyPreset(radio.value); return; }
      renderPresets();
      confirmReplaceCpsChains(() => applyPreset(radio.value));
    });
  });
  const reroll = document.getElementById('cpsPresetReroll');
  if (reroll) reroll.addEventListener('click', () => applyPreset('random'));
  document.querySelectorAll('[data-cps-compat]').forEach((btn) => {
    btn.addEventListener('click', () => chooseCompat(btn.dataset.cpsCompat));
  });
  const autoExtra = document.getElementById('cpsAutoExtra');
  if (autoExtra) {
    autoExtra.addEventListener('change', () => {
      // Без авто-пакетов поля после последнего своего уходят, а пропуски между своими заполняются
      cfgState.extraCps = autoExtra.checked;
      fillGaps();
      renderCpsEditor();
      updateParamChips();
    });
  }
  const resetAll = document.getElementById('cpsResetAll');
  if (resetAll) {
    resetAll.addEventListener('click', () => {
      if (!hasCustomCpsChains()) { applyPreset('standard'); return; }
      askCpsConfirm({
        title: t('cps_confirm_reset_title', 'Сбросить все цепочки?'),
        text: t('cps_confirm_reset_text', 'Свои цепочки будут удалены, генератор снова выберет пакеты сам (вариант «Стандарт»).'),
        confirmLabel: t('cps_confirm_reset_ok', 'Сбросить'),
      }, () => applyPreset('standard'));
    });
  }
  const confirmOk = document.getElementById('cpsConfirmOk');
  if (confirmOk) {
    confirmOk.addEventListener('click', () => {
      const action = cpsConfirmAction;
      closeCpsConfirm();
      if (action) action();
    });
  }
  // Закрытие диалога крестиком, «Отменой» или Esc — без действия
  const confirmModal = document.getElementById('cpsConfirmModal');
  if (confirmModal) {
    confirmModal.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', () => {
      cpsConfirmAction = null;
      renderCpsEditor();
    }));
  }
  const importBtn = document.getElementById('cpsImportBtn');
  if (importBtn) importBtn.addEventListener('click', importFromConf);
  const importArea = document.getElementById('cpsImportText');
  if (importArea) importArea.placeholder = t('cps_import_placeholder', 'Вставьте текст .conf или строки «I1 = …»');
  // Подписи «авто» зависят от протокола CPS с другой вкладки, заметка Legacy — от профиля
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target && (target.name === 'cpsProtocol' || target.name === 'awgProfile')) {
      renderPresets();
      renderAllMeta();
    }
  });
  renderCpsEditor();
};
