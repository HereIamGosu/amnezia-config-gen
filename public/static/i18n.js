// public/static/i18n.js
//
// Локализация интерфейса: язык страницы задаёт адрес (/ — ru, /en — en), словарь /locales/<lang>.json,
// применение data-i18n* (applyTranslations, setI18nText), переключатель языка и передача результата
// и прокрутки на страницу другого языка (sessionStorage, LANG_HANDOFF_*).
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → settings-link.js → history.js →
// script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global uiShell -- common.js */
/* global renderHeroStatus -- status.js */
/* global
   lastResultSummary:writable, renderResultExplanation, lastCompatibility:writable, renderCompatibilityCard,
   currentResult:writable, renderResultSuccess -- result.js */
/* global updateCidrCounter, cfgState, ROUTE_MODES, updateParamChips -- settings.js */
/* global renderHistoryPanel -- history.js */
/* exported _i18n, t, setI18nText, initI18n, restoreLangHandoff, switchLang */

// Языковые версии страницы; язык текущей задан атрибутом <html lang> (en/index.html генерируется).
const LANG_PATHS = { ru: '/', en: '/en' };
const isKnownLang = (lang) => Object.prototype.hasOwnProperty.call(LANG_PATHS, lang);
const PAGE_LANG = document.documentElement.lang === 'en' ? 'en' : 'ru';

const _i18n = { locale: PAGE_LANG, strings: {} };

/** Возвращает переведённую строку или fallback (если перевод не загружен). */
const t = (key, fallback) => _i18n.strings[key] !== undefined ? _i18n.strings[key] : (fallback !== undefined ? fallback : key);

/** Обходит все элементы с data-i18n-* и применяет переводы. */
const applyTranslations = () => {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const val = _i18n.strings[key];
    if (val !== undefined) el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    const val = _i18n.strings[key];
    if (val !== undefined) el.innerHTML = val;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    const val = _i18n.strings[key];
    if (val !== undefined) el.title = val;
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria-label');
    const val = _i18n.strings[key];
    if (val !== undefined) el.setAttribute('aria-label', val);
  });
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => {
    const key = el.getAttribute('data-i18n-alt');
    const val = _i18n.strings[key];
    if (val !== undefined) el.setAttribute('alt', val);
  });
};

/**
 * Адрес словаря с версией ассетов страницы (?v= у её скриптов из static/, release:check держит его равным
 * версии пакета). После релиза адрес новый, и браузер не берёт из кэша словарь прошлой версии, где нет
 * новых ключей: без версии он показывал имена ключей вместо текстов.
 */
const localeRequestUrl = (lang) => {
  const script = document.querySelector('script[src*="static/"][src*="?v="]');
  const match = script && /[?&]v=([^&#]+)/.exec(script.getAttribute('src'));
  return `/locales/${lang}.json${match ? `?v=${encodeURIComponent(match[1])}` : ''}`;
};

/**
 * Загружает словарь для заданного языка и применяет переводы.
 * Fallback: если файл недоступен (offline), оставляем HTML-текст нетронутым.
 */
const loadLocale = async (lang) => {
  try {
    const res = await fetch(localeRequestUrl(lang));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _i18n.strings = await res.json();
    _i18n.locale = lang;
    applyTranslations();
    // data-i18n дал счётчику только заготовку: перерисовываем его на текущем языке с реальным числом
    updateCidrCounter(cfgState.routeMode === ROUTE_MODES.FULL ? 0 : cfgState.cidrCount4);
    if (lastResultSummary) renderResultExplanation(lastResultSummary);
    if (lastCompatibility) renderCompatibilityCard(lastCompatibility);
    // Тексты, которые строит JS (статус, чипы, результат, история), — на языке словаря
    renderHeroStatus();
    updateParamChips();
    if (currentResult) renderResultSuccess();
    renderHistoryPanel();
  } catch {
    // В офлайн-режиме или при 404 оставляем исходный HTML-текст (русский)
  }
  // Обновляем состояние кнопок переключателя
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('lang-btn--active', btn.dataset.lang === _i18n.locale);
  });
};

/** Текст с ключом перевода: applyTranslations() перерисует его при смене языка. */
const setI18nText = (el, key, fallback) => {
  if (!el) return;
  el.dataset.i18n = key;
  el.textContent = t(key, fallback);
};

const readSavedLang = () => {
  try {
    const saved = localStorage.getItem('lang');
    return isKnownLang(saved) ? saved : null;
  } catch {
    return null;
  }
};

const navigateToLang = (lang) => {
  window.location.assign(LANG_PATHS[lang] + window.location.search + window.location.hash);
};

/**
 * Инициализирует i18n. Язык задаёт адрес страницы (/ — ru, /en — en), а не язык браузера:
 * поисковый робот всегда видит язык адреса. Явный выбор посетителя из localStorage
 * переводит его на адрес нужного языка. Вызывается один раз при DOMContentLoaded.
 */
const initI18n = () => {
  const saved = readSavedLang();
  if (saved && saved !== PAGE_LANG) {
    navigateToLang(saved);
    return;
  }
  loadLocale(PAGE_LANG);
};

// Смена языка — переход на другой адрес. Чтобы посетитель не терял только что полученный результат
// и место на странице, их передаёт sessionStorage этой вкладки: запись читается один раз и сразу
// удаляется, устаревшая (дольше минуты) игнорируется.
const LANG_HANDOFF_KEY = 'awg_lang_handoff';
const LANG_HANDOFF_TTL_MS = 60_000;

const saveLangHandoff = (lang) => {
  try {
    const panel = document.getElementById('resultPanel');
    const withResult = !!(currentResult && panel && !panel.hidden && panel.dataset.view === 'success');
    sessionStorage.setItem(LANG_HANDOFF_KEY, JSON.stringify({
      to: lang,
      at: Date.now(),
      scrollY: Math.round(window.scrollY),
      // Положение панели результата в окне: после перехода она встанет туда же, даже если высота блоков выше другая
      resultTop: withResult ? Math.round(panel.getBoundingClientRect().top) : null,
      result: withResult ? currentResult : null,
      summary: withResult ? lastResultSummary : null,
      compatibility: withResult ? lastCompatibility : null,
    }));
  } catch {
    // Без sessionStorage язык просто сменится с начала страницы
  }
};

const takeLangHandoff = () => {
  try {
    const raw = sessionStorage.getItem(LANG_HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(LANG_HANDOFF_KEY);
    const data = JSON.parse(raw);
    if (!data || data.to !== PAGE_LANG || !(Date.now() - data.at < LANG_HANDOFF_TTL_MS)) return null;
    return data;
  } catch {
    return null;
  }
};

/** Восстанавливает результат и прокрутку, сохранённые перед сменой языка. */
const restoreLangHandoff = () => {
  const data = takeLangHandoff();
  if (!data) return;
  const result = data.result;
  const hasResult = !!(result && Array.isArray(result.variants) && result.variants.length
    && result.variants.every((v) => v && typeof v.decodedConfig === 'string'));
  if (hasResult) {
    lastResultSummary = data.summary || null;
    lastCompatibility = data.compatibility || null;
    if (lastResultSummary) renderResultExplanation(lastResultSummary);
    renderCompatibilityCard(lastCompatibility);
    currentResult = {
      ...result,
      active: Number.isInteger(result.active) && result.variants[result.active] ? result.active : 0,
      tab: result.tab === 'link' ? 'link' : 'conf',
    };
    renderResultSuccess();
    if (uiShell) uiShell.selectTab(currentResult.tab === 'link' ? 'resultTabLink' : 'resultTabConf');
  }
  const scrollBack = () => {
    const panel = document.getElementById('resultPanel');
    const top = hasResult && panel && Number.isFinite(data.resultTop)
      ? window.scrollY + panel.getBoundingClientRect().top - data.resultTop
      : data.scrollY;
    if (Number.isFinite(top)) window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  };
  scrollBack();
  // Шрифты и картинки могут ещё догрузиться и поменять высоту блоков выше — выравниваем ещё раз,
  // если посетитель за это время сам не прокрутил страницу
  const settledAt = window.scrollY;
  window.addEventListener('load', () => {
    if (Math.abs(window.scrollY - settledAt) < 2) scrollBack();
  }, { once: true });
};

/** Переключает язык: сохраняет выбор и открывает адрес выбранного языка. */
const switchLang = (lang) => {
  if (!isKnownLang(lang)) return;
  try {
    localStorage.setItem('lang', lang);
  } catch {
    // Без localStorage выбор просто не запомнится
  }
  if (lang === PAGE_LANG) {
    loadLocale(lang);
    return;
  }
  saveLangHandoff(lang);
  navigateToLang(lang);
};
