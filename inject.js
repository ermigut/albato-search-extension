/**
 * inject.js — runs in PAGE context.
 * Captures Authorization header from apps API requests (if Bearer token is used).
 * Falls back gracefully if auth is cookie-based (no header needed).
 */
(function () {
  'use strict';

  if (window.__albato_injected__) return;
  window.__albato_injected__ = true;

  const TARGET = /\/api\/builder\/apps\b/;

  function capture(headers) {
    window.dispatchEvent(new CustomEvent('__albato_auth__', { detail: { headers } }));
  }

  // Intercept SPA navigation (history.pushState)
  const _push = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    const result = _push(state, title, url);
    window.dispatchEvent(new CustomEvent('__albato_nav__'));
    return result;
  };

  // Wrap fetch
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    if (TARGET.test(url)) {
      const h = {};
      const src = (init?.headers) || (input?.headers) || {};
      if (src instanceof Headers) src.forEach((v, k) => { h[k] = v; });
      else if (Array.isArray(src)) src.forEach(([k, v]) => { h[k] = v; });
      else Object.assign(h, src);
      capture(h);
    }
    return _fetch(input, init);
  };

  // Wrap XHR
  const _open = XMLHttpRequest.prototype.open;
  const _setHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (m, url, ...rest) {
    this.__url__ = url;
    this.__hdrs__ = {};
    return _open.call(this, m, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__hdrs__) this.__hdrs__[k] = v;
    return _setHeader.call(this, k, v);
  };
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    if (this.__url__ && TARGET.test(this.__url__)) capture(this.__hdrs__ || {});
    return _send.call(this, ...a);
  };
})();
