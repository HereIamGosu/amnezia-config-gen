// public/static/common.js
//
// Общие помощники интерфейса без доменной логики: телеметрия (window.ProductTelemetry), обёртки
// над UiShell (openModal, toast), копирование в буфер, иконки, экранирование HTML, превью конфига
// с маской PrivateKey, разбор JSON-ответа API, debounce и скачивание файла.
//
// Классический скрипт (defer), не модуль: верхнеуровневые const/let/функции всех скриптов генератора
// живут в одной глобальной лексической области. Порядок загрузки — в public/index.html:
// i18n.js → common.js → status.js → result.js → settings.js → settings-link.js → history.js →
// script.js. При загрузке файл вызывает только своё и уже загруженное;
// остальное — из обработчиков после DOMContentLoaded. /* global */ — что файл берёт у других,
// /* exported */ — что отдаёт им (проверяют ESLint и __tests__/frontend-scripts.test.js).

/* global t -- i18n.js */
/* exported
   telemetry, uiShell, openModal, toast, copyText, makeIcon, renderConfigHtml, renderVpnLinkHtml, previewConfigText,
   openPreviewModal, parseJsonResponse, debounce, downloadFile */

const telemetry = window.ProductTelemetry || {
  classifyGenerationError: () => 'unknown',
  durationMs: () => 0,
  trackEvent: () => false,
};

// ─────────────────────────────────────────────────────────────
// Модальные окна (каркас, ловушка фокуса и ESC — в ui-shell.js)
// ─────────────────────────────────────────────────────────────

const uiShell = window.UiShell || null;

/** Открывает модальное окно по id; после закрытия фокус вернётся на opener. */
const openModal = (id, opener) => {
  if (uiShell) {
    uiShell.openModal(id, opener);
    return;
  }
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
};

const toast = (text, kind) => {
  if (uiShell) uiShell.toast(text, kind);
};

/** Копирует текст в буфер; без Clipboard API (http, старые браузеры) — через выделение. */
const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
};

const makeIcon = (id, cls = 'icon') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  return svg;
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Превью конфига: PrivateKey маскируется только на экране ──

const SECRET_MASK = '••••••••••••••••';

/** HTML конфига с подсветкой секций; значение PrivateKey заменено маской. Всё экранировано. */
const renderConfigHtml = (configText) => configText.split(/\r?\n/).map((line) => {
  if (/^\s*\[[^\]]+\]\s*$/.test(line)) return `<span class="c-section">${escapeHtml(line)}</span>`;
  if (/^\s*#/.test(line)) return `<span class="c-comment">${escapeHtml(line)}</span>`;
  const m = /^(\s*)([A-Za-z0-9]+)(\s*=\s*)(.*)$/.exec(line);
  if (!m) return escapeHtml(line);
  const value = /^privatekey$/i.test(m[2])
    ? `<span class="c-mask">${SECRET_MASK}</span>`
    : escapeHtml(m[4]);
  return `${escapeHtml(m[1])}<span class="c-key">${escapeHtml(m[2])}</span>${escapeHtml(m[3])}${value}`;
}).join('\n');

/** vpn://-ссылка кодирует весь конфиг вместе с ключом: на экране — только начало. */
const renderVpnLinkHtml = (link) => `${escapeHtml(link.slice(0, 28))}<span class="c-mask">${SECRET_MASK}</span>`;

let previewConfigText = '';

/** Открывает предпросмотр конфига: на экране ключ скрыт, «Копировать» отдаёт полный текст. */
const openPreviewModal = (decodedConfig, filename, opener) => {
  previewConfigText = decodedConfig;
  const code = document.getElementById('configPreviewCode');
  if (code) code.innerHTML = renderConfigHtml(decodedConfig);
  const name = document.getElementById('previewFileName');
  if (name && filename) name.textContent = filename;
  openModal('configPreviewModal', opener);
};

/**
 * @param {Response} response
 * @returns {Promise<Record<string, unknown>>}
 */
const parseJsonResponse = async (response) => {
  const raw = await response.text();
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new Error(t('err_empty_response', 'Пустой ответ сервера.'));
  }
  const lower = trimmed.slice(0, 64).toLowerCase();
  if (
    trimmed.startsWith('<')
    || lower.includes('<!doctype')
    || lower.includes('<html')
  ) {
    throw new Error(t('err_html_response', 'Сервер вернул HTML вместо JSON (нет API). Запустите vercel dev или откройте задеплоенный сайт.'));
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(t('err_not_json', 'Ответ не похож на JSON. Проверьте доступность API.'));
  }
};

const debounce = (fn, delayMs) => {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, delayMs);
  };
};

const downloadFile = (content, filename) => {
  // application/octet-stream avoids mobile browsers appending .txt to .conf (text/plain triggers that).
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
};
