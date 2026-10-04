// public/static/ui-shell.js
// Визуальная оболочка страницы: модальные окна (общий каркас), вкладки, мобильное меню,
// аккордеоны шагов, выпадающие меню и тосты. Без доменной логики генератора — её держит script.js.
// API для script.js: window.UiShell.{openModal, closeModal, isOpen, selectTab, toast}.

'use strict';

(function initUiShell(globalScope) {
  const doc = globalScope.document;

  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  // ── Модальные окна ─────────────────────────────────────────────

  /** Стек открытых модалок: ESC и ловушка фокуса работают с верхней. */
  const stack = [];
  const openers = new Map();

  const getModal = (id) => doc.getElementById(id);
  const isOpen = (id) => stack.includes(id);

  const focusablesOf = (modal) => Array.from(modal.querySelectorAll(FOCUSABLE)).filter(isVisible);

  const syncScrollLock = () => {
    doc.documentElement.classList.toggle('is-modal-open', stack.length > 0);
  };

  const openModal = (id, opener) => {
    const modal = getModal(id);
    if (!modal) return;
    if (isOpen(id)) return;
    openers.set(id, opener || doc.activeElement);
    stack.push(id);
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    syncScrollLock();
    modal.dispatchEvent(new CustomEvent('modal:open', { bubbles: true }));
    // Фокус — на первый элемент тела, иначе на кнопку закрытия: заголовок с крестиком
    // остаётся предсказуемой точкой входа для клавиатуры и экранных дикторов.
    const preferred = modal.querySelector('[data-autofocus]') || modal.querySelector('.modal__close');
    const target = preferred && isVisible(preferred) ? preferred : focusablesOf(modal)[0];
    if (target) target.focus({ preventScroll: true });
  };

  const closeModal = (id) => {
    const modal = getModal(id);
    if (!modal || !isOpen(id)) return;
    stack.splice(stack.indexOf(id), 1);
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    syncScrollLock();
    modal.dispatchEvent(new CustomEvent('modal:close', { bubbles: true }));
    const opener = openers.get(id);
    openers.delete(id);
    if (opener && typeof opener.focus === 'function' && doc.contains(opener)) {
      opener.focus({ preventScroll: true });
    }
  };

  const topModalId = () => stack[stack.length - 1] || null;

  doc.addEventListener('keydown', (ev) => {
    const top = topModalId();
    if (!top) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeModal(top);
      return;
    }
    if (ev.key !== 'Tab') return;
    const items = focusablesOf(getModal(top));
    if (!items.length) {
      ev.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (ev.shiftKey && doc.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && doc.activeElement === last) {
      ev.preventDefault();
      first.focus();
    } else if (!getModal(top).contains(doc.activeElement)) {
      ev.preventDefault();
      first.focus();
    }
  });

  // Клик по затемнению закрывает окно; нажатие, начатое внутри окна, — нет (выделение текста).
  let pressStartedOnBackdrop = false;
  doc.addEventListener('mousedown', (ev) => {
    pressStartedOnBackdrop = ev.target.classList && ev.target.classList.contains('modal');
  });
  doc.addEventListener('click', (ev) => {
    const target = ev.target;
    if (target.classList && target.classList.contains('modal') && pressStartedOnBackdrop && isOpen(target.id)) {
      closeModal(target.id);
      return;
    }
    const closer = target.closest && target.closest('[data-close-modal]');
    if (closer) {
      const modal = closer.closest('.modal');
      if (modal) closeModal(modal.id);
      return;
    }
    const openerEl = target.closest && target.closest('[data-open-modal]');
    if (openerEl) {
      ev.preventDefault();
      const top = topModalId();
      // Ссылка из одного окна в другое заменяет текущее окно, а не громоздит их друг на друга.
      if (top && getModal(top).contains(openerEl)) closeModal(top);
      openModal(openerEl.getAttribute('data-open-modal'), openerEl);
    }
  });

  // ── Вкладки ────────────────────────────────────────────────────

  const selectTab = (tabId, { focus = false } = {}) => {
    const tab = doc.getElementById(tabId);
    if (!tab) return;
    const list = tab.closest('[role="tablist"]');
    if (!list) return;
    // Вкладки с общей панелью (.conf / vpn:// результата) только переключают выбор;
    // содержимое панели перерисовывает владелец по событию tabs:change.
    const sharedPanel = list.hasAttribute('data-shared-panel');
    list.querySelectorAll('[role="tab"]').forEach((other) => {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      const panel = doc.getElementById(other.getAttribute('aria-controls'));
      if (panel && !sharedPanel) panel.hidden = !selected;
    });
    if (focus) tab.focus();
    list.dispatchEvent(new CustomEvent('tabs:change', { bubbles: true, detail: { tabId } }));
  };

  doc.querySelectorAll('[role="tablist"]').forEach((list) => {
    list.addEventListener('click', (ev) => {
      const tab = ev.target.closest('[role="tab"]');
      if (tab && !tab.disabled) selectTab(tab.id);
    });
    list.addEventListener('keydown', (ev) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
      const tabs = Array.from(list.querySelectorAll('[role="tab"]:not([disabled])'));
      const index = tabs.indexOf(doc.activeElement);
      if (index < 0) return;
      ev.preventDefault();
      let next = index;
      if (ev.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (ev.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (ev.key === 'Home') next = 0;
      if (ev.key === 'End') next = tabs.length - 1;
      selectTab(tabs[next].id, { focus: true });
    });
  });

  // ── Мобильное меню ─────────────────────────────────────────────

  const header = doc.getElementById('siteHeader');
  const menuToggle = doc.getElementById('menuToggle');
  const setMenuOpen = (open) => {
    if (!header || !menuToggle) return;
    header.classList.toggle('is-menu-open', open);
    menuToggle.setAttribute('aria-expanded', String(open));
  };
  if (menuToggle) {
    menuToggle.addEventListener('click', () => setMenuOpen(!header.classList.contains('is-menu-open')));
    doc.addEventListener('click', (ev) => {
      if (!header.classList.contains('is-menu-open')) return;
      if (ev.target.closest('.site-nav__link') || !header.contains(ev.target)) setMenuOpen(false);
    });
    doc.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && header.classList.contains('is-menu-open') && !topModalId()) setMenuOpen(false);
    });
  }

  // ── Аккордеоны шагов (только мобильная раскладка) ───────────────

  const mobileQuery = globalScope.matchMedia ? globalScope.matchMedia('(max-width: 720px)') : null;
  const setStepCollapsed = (toggle, collapsed) => {
    const step = toggle.closest('.step');
    if (!step) return;
    step.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  doc.querySelectorAll('[data-step-toggle]').forEach((toggle) => {
    if (mobileQuery && mobileQuery.matches && toggle.hasAttribute('data-collapse-mobile')) setStepCollapsed(toggle, true);
    toggle.addEventListener('click', () => {
      setStepCollapsed(toggle, toggle.getAttribute('aria-expanded') === 'true');
    });
  });

  // ── Свёрнутая мобильная строка статуса ─────────────────────────

  const statusStrip = doc.getElementById('statusStrip');
  const statusPanel = doc.getElementById('statusPanel');
  if (statusStrip && statusPanel) {
    statusStrip.addEventListener('click', () => {
      const expanded = !statusPanel.classList.contains('is-expanded');
      statusPanel.classList.toggle('is-expanded', expanded);
      statusStrip.setAttribute('aria-expanded', String(expanded));
    });
  }

  // ── Выпадающие меню ────────────────────────────────────────────

  const closeMenu = (button) => {
    const list = doc.getElementById(button.getAttribute('aria-controls'));
    if (list) list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  const openMenus = () => Array.from(doc.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]'));

  doc.querySelectorAll('[aria-haspopup="menu"]').forEach((button) => {
    const list = doc.getElementById(button.getAttribute('aria-controls'));
    if (!list) return;
    button.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = button.getAttribute('aria-expanded') !== 'true';
      openMenus().forEach(closeMenu);
      list.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        const first = list.querySelector('[role="menuitem"]');
        if (first) first.focus();
      }
    });
    list.addEventListener('click', (ev) => {
      if (ev.target.closest('[role="menuitem"]')) closeMenu(button);
    });
    list.addEventListener('keydown', (ev) => {
      const items = Array.from(list.querySelectorAll('[role="menuitem"]'));
      const index = items.indexOf(doc.activeElement);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const step = ev.key === 'ArrowDown' ? 1 : -1;
        items[(index + step + items.length) % items.length].focus();
      } else if (ev.key === 'Escape') {
        ev.stopPropagation();
        closeMenu(button);
        button.focus();
      } else if (ev.key === 'Tab') {
        closeMenu(button);
      }
    });
  });
  doc.addEventListener('click', (ev) => {
    openMenus().forEach((button) => {
      const list = doc.getElementById(button.getAttribute('aria-controls'));
      if (!list || !list.contains(ev.target)) closeMenu(button);
    });
  });

  // ── Тост ───────────────────────────────────────────────────────

  let toastTimer = null;
  const toast = (text) => {
    let el = doc.getElementById('uiToast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'uiToast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      doc.body.appendChild(el);
    }
    el.textContent = '';
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon icon--sm');
    icon.setAttribute('aria-hidden', 'true');
    const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-check');
    icon.appendChild(use);
    const label = doc.createElement('span');
    label.textContent = text;
    el.append(icon, label);
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  };

  // ── Прямые ссылки на модалки (например, /#faq из выдачи) ─────────

  const openFromHash = () => {
    const hash = globalScope.location.hash;
    if (!hash) return;
    const trigger = Array.from(doc.querySelectorAll('[data-open-modal]')).find((el) => el.getAttribute('href') === hash);
    if (trigger) openModal(trigger.getAttribute('data-open-modal'), trigger);
  };
  openFromHash();
  globalScope.addEventListener('hashchange', openFromHash);

  globalScope.UiShell = { openModal, closeModal, isOpen, selectTab, toast };
})(window);
