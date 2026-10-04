// e2e/lib/cdp.js
// Минимальный клиент Chrome DevTools Protocol на встроенном WebSocket Node 22.
// Одно соединение с браузером, вкладки — плоские сессии (Target.attachToTarget flatten).
'use strict';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param {string} wsUrl — ws://127.0.0.1:<port>/devtools/browser/<id>
 * @returns {Promise<{ send: Function, on: Function, off: Function, close: Function }>}
 */
const connect = async (wsUrl) => {
  if (typeof WebSocket !== 'function') throw new Error('Node 22+ with a global WebSocket is required');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
  });

  let lastId = 0;
  const pending = new Map();
  const listeners = new Set();
  let closed = false;

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) listeners.forEach((fn) => fn(msg));
  });
  ws.addEventListener('close', () => {
    closed = true;
    pending.forEach(({ reject, method, timer }) => {
      clearTimeout(timer);
      reject(new Error(`${method}: connection closed`));
    });
    pending.clear();
  });

  /** Команда CDP; sessionId — команда для конкретной вкладки. */
  const send = (method, params = {}, sessionId = undefined, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    if (closed) return Promise.reject(new Error(`${method}: connection closed`));
    lastId += 1;
    const id = lastId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, method, timer });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  };

  return {
    send,
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    close: () => {
      if (!closed) ws.close();
    },
  };
};

module.exports = { connect };
