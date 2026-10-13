/**
 * CPS-цепочки AmneziaWG для полей I1–I5: разбор, проверка совместимости, канонический вид.
 *
 * Один код для браузера (window.CpsChain, редактор во вкладке «Дополнительно») и сервера
 * (require из api/warp.js), чтобы интерфейс и /api/warp одинаково понимали, что допустимо.
 * Правила — пересечение парсеров amneziawg-go (docs/research/cps-runtime-tags-audit.md):
 *   <b 0x…>  — фиксированные байты (hex, чётная длина, префикс строчный 0x);
 *   <r N>    — N случайных байт, клиент генерирует при каждой отправке;
 *   <rd N>   — N случайных цифр ASCII;  <rc N> — N случайных латинских букв;
 *   <t>      — время unix (4 байта в v0.2.16+, 8 в v0.2.13–v0.2.15), не больше одного на поле.
 * N в 1..1000 (лимит v0.2.13–v0.2.15). <rd>/<rc> есть только с v0.2.15: уровень совместимости
 * 'all' (все клиенты с I1–I5, от v0.2.13) их не пропускает, 'modern' пропускает.
 * Теги d/ds/dz работают с данными пакета, а I-пакеты уходят без данных; c/wt удалены в v0.2.16.
 */
(function initCpsChain(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CpsChain = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const FIELDS = Object.freeze(['I1', 'I2', 'I3', 'I4', 'I5']);
  const COMPAT_LEVELS = Object.freeze(['all', 'modern']);
  const MAX_N = 1000;
  /** Больше не уходит одной UDP-датаграммой без фрагментации при MTU 1500 (1500 − 20 IPv4 − 8 UDP). */
  const MAX_PACKET_BYTES = 1472;
  /** Выше — фрагментация в сетях с MTU 1280 (1280 − 28). */
  const MTU_1280_BYTES = 1252;
  const MAX_TEXT_LENGTH = 4096;
  /** Ширина <t> в amneziawg-go v0.2.16+ (в v0.2.13–v0.2.15 — 8 байт). */
  const TIMESTAMP_BYTES = 4;

  /** Теги, которые предлагает редактор, в порядке палитры. */
  const TAGS = Object.freeze({
    b: Object.freeze({ runtime: false, modernOnly: false }),
    r: Object.freeze({ runtime: true, modernOnly: false }),
    rd: Object.freeze({ runtime: true, modernOnly: true }),
    rc: Object.freeze({ runtime: true, modernOnly: true }),
    t: Object.freeze({ runtime: true, modernOnly: false }),
  });
  const NOT_APPLICABLE = Object.freeze(['d', 'ds', 'dz', 'c', 'wt', 'wr']);

  /** Русские тексты ошибок: их отдаёт сервер и берёт интерфейс, если в словаре нет ключа cps_err_<code>. */
  const MESSAGES_RU = Object.freeze({
    too_long_text: 'цепочка длиннее 4096 символов',
    outside_text: 'текст вне тегов: всё содержимое должно быть внутри <…>',
    unclosed: 'тег не закрыт символом >',
    empty_tag: 'пустой тег <>',
    tag_case: 'имя тега пишется строчными буквами',
    unknown_tag: 'неизвестный тег',
    not_applicable: 'тег не работает в полях I1–I5',
    modern_only: 'теги <rd> и <rc> понимают только клиенты на amneziawg-go 0.2.15 и новее',
    b_hex: '<b> ждёт байты в виде 0x и чётного числа hex-цифр',
    n_range: 'длина должна быть целым числом от 1 до 1000',
    t_param: '<t> пишется без параметра',
    t_twice: 'в одном поле может быть только один <t>',
    too_large: 'пакет больше 1472 байт',
  });

  const isCompat = (level) => COMPAT_LEVELS.includes(level);

  /** Байт в сегменте. */
  const segmentBytes = (seg) => {
    if (seg.tag === 'b') return seg.hex.length / 2;
    if (seg.tag === 't') return TIMESTAMP_BYTES;
    return seg.n;
  };

  /** Канонический текст одного сегмента. */
  const segmentText = (seg) => {
    if (seg.tag === 'b') return `<b 0x${seg.hex}>`;
    if (seg.tag === 't') return '<t>';
    return `<${seg.tag} ${seg.n}>`;
  };

  const serialize = (segments) => segments.map(segmentText).join('');

  /**
   * Разбирает цепочку. Сегменты возвращаются даже при ошибках (для подсветки в редакторе);
   * ok = нет ошибок для выбранного уровня совместимости.
   * @param {string} text
   * @param {'all'|'modern'} [compat]
   */
  const parse = (text, compat = 'all') => {
    const level = isCompat(compat) ? compat : 'all';
    const source = String(text ?? '');
    const errors = [];
    const segments = [];
    const push = (code, extra = {}) => errors.push({ code, ...extra });

    if (source.length > MAX_TEXT_LENGTH) push('too_long_text');

    let i = 0;
    while (i < source.length) {
      const open = source.indexOf('<', i);
      const between = source.slice(i, open === -1 ? source.length : open);
      if (between.trim() !== '') push('outside_text', { at: i });
      if (open === -1) break;
      const close = source.indexOf('>', open + 1);
      const nextOpen = source.indexOf('<', open + 1);
      if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
        push('unclosed', { at: open });
        i = nextOpen === -1 ? source.length : nextOpen;
        continue;
      }
      const inner = source.slice(open + 1, close).trim();
      i = close + 1;
      if (inner === '') { push('empty_tag', { at: open }); continue; }
      const [rawName, ...rest] = inner.split(/\s+/);
      const param = rest.join(' ');
      const name = rawName;
      if (!/^[a-z]+$/.test(name) && TAGS[name.toLowerCase()]) { push('tag_case', { at: open, tag: name }); continue; }
      if (NOT_APPLICABLE.includes(name)) { push('not_applicable', { at: open, tag: name }); continue; }
      if (!TAGS[name]) { push('unknown_tag', { at: open, tag: name }); continue; }

      if (name === 'b') {
        const m = /^0x([0-9a-fA-F]+)$/.exec(param);
        if (!m || m[1].length % 2 !== 0) { push('b_hex', { at: open, tag: 'b' }); continue; }
        segments.push({ tag: 'b', hex: m[1].toLowerCase() });
      } else if (name === 't') {
        if (param !== '') { push('t_param', { at: open, tag: 't' }); continue; }
        segments.push({ tag: 't' });
      } else {
        const n = /^[0-9]+$/.test(param) ? Number(param) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > MAX_N) { push('n_range', { at: open, tag: name }); continue; }
        segments.push({ tag: name, n });
      }
    }

    if (segments.filter((s) => s.tag === 't').length > 1) push('t_twice', { tag: 't' });
    const needsModern = segments.some((s) => TAGS[s.tag].modernOnly);
    if (needsModern && level === 'all') push('modern_only');
    const bytes = segments.reduce((n, s) => n + segmentBytes(s), 0);
    if (bytes > MAX_PACKET_BYTES) push('too_large');
    const fixedBytes = segments.filter((s) => s.tag === 'b').reduce((n, s) => n + segmentBytes(s), 0);

    return {
      ok: errors.length === 0,
      errors,
      segments,
      bytes,
      fixedBytes,
      runtimeBytes: bytes - fixedBytes,
      needsModern,
      canonical: serialize(segments),
    };
  };

  /** Текст ошибки по-русски (для сервера и как запасной текст интерфейса). */
  const describeError = (error) => {
    const base = MESSAGES_RU[error.code] || error.code;
    return error.tag && ['unknown_tag', 'not_applicable', 'tag_case'].includes(error.code)
      ? `${base}: <${error.tag}>` : base;
  };

  /**
   * Пропуск в I1–I5: amneziawg-go v0.2.13–v0.2.15 требуют номера пакетов подряд с 1 (TagJunkPacketGenerators.Validate,
   * «junk packet index should be consecutive») и отвергают весь конфиг; с v0.2.16 пропуски допустимы.
   * @param {Record<string, boolean>} present  какие поля будут в конфиге
   * @returns {{ field: string, missing: string } | null}  первое поле после пропуска
   */
  const findGap = (present) => {
    for (let i = 1; i < FIELDS.length; i += 1) {
      if (present[FIELDS[i]] && !present[FIELDS[i - 1]]) return { field: FIELDS[i], missing: FIELDS[i - 1] };
    }
    return null;
  };

  const describeGap = (gap) => `поле ${gap.field} задано, а ${gap.missing} — нет: клиенты на amneziawg-go до 0.2.16 отвергают пропуски в I1–I5`;

  /** Поля I1–I5 из текста .conf (секция [Interface]); пустых полей в результате нет. */
  const extractFromConf = (confText) => {
    const out = {};
    let section = '';
    for (const raw of String(confText ?? '').split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^\[(\w+)\]$/.exec(line);
      if (header) { section = header[1].toLowerCase(); continue; }
      const kv = /^(I[1-5])\s*=\s*(.+)$/.exec(line);
      if (kv && (section === 'interface' || section === '')) out[kv[1]] = kv[2].trim();
    }
    return out;
  };

  return Object.freeze({
    FIELDS,
    COMPAT_LEVELS,
    TAGS,
    MAX_N,
    MAX_PACKET_BYTES,
    MTU_1280_BYTES,
    MAX_TEXT_LENGTH,
    TIMESTAMP_BYTES,
    MESSAGES_RU,
    parse,
    serialize,
    segmentBytes,
    segmentText,
    describeError,
    findGap,
    describeGap,
    extractFromConf,
    isCompat,
  });
}));
