/**
 * Yandex.Metrika: загрузчик tag.js и инициализация счётчика.
 *
 * Раньше этот код стоял inline-скриптом в <head>; вынесен в файл, чтобы Content-Security-Policy
 * обходился без script-src 'unsafe-inline'. Логика — официальный сниппет Метрики без изменений:
 * очередь ym(...) до загрузки tag.js, защита от повторной вставки tag.js, те же параметры
 * счётчика 99328227 и та же цель infoLink. Подключается с defer первым из скриптов страницы,
 * поэтому ym уже определён, когда выполняются analytics.js и script.js.
 * <noscript>-пиксель остаётся в HTML.
 */
(function initYandexMetrika(m, e, t, r, i) {
  m[i] = m[i] || function ymQueue() {
    (m[i].a = m[i].a || []).push(arguments);
  };
  m[i].l = 1 * new Date();
  for (let j = 0; j < document.scripts.length; j++) {
    if (document.scripts[j].src === r) {
      return;
    }
  }
  const k = e.createElement(t);
  const a = e.getElementsByTagName(t)[0];
  k.async = 1;
  k.src = r;
  a.parentNode.insertBefore(k, a);
}(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym'));

window.ym(99328227, 'init', {
  clickmap: true,
  trackLinks: true,
  accurateTrackBounce: true,
  webvisor: false,
});
window.ym(99328227, 'reachGoal', 'infoLink');

// Очередь Vercel Web Analytics (window.va): прежний inline-стаб сохранён как есть, чтобы
// вызовы va(...) не падали, если скрипт аналитики Vercel подключат на форке.
window.va = window.va || function vaQueue() {
  (window.vaq = window.vaq || []).push(arguments);
};
