'use strict';
/** Public connection settings only. Provider credentials belong on the backend. */
(function () {
  let settings = { walletConnect: { projectId: '' }, apiBaseUrl: '' };
  let apiError = null;
  function configure(value) {
    settings = value && typeof value === 'object' ? value : {};
    apiError = null;
    try {
      if (settings.apiBaseUrl) {
        const url = new URL(settings.apiBaseUrl);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
        if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
        settings = Object.assign({}, settings, { apiBaseUrl: url.origin });
      }
    } catch (_) { apiError = new Error('OTT’s backend address is invalid. Ask the operator to check the app settings.'); }
    return settings;
  }
  function apiUrl(path) {
    if (apiError) throw apiError;
    if (!/^\.\/api\/(redeem|status|auth)(?:\?|$)/.test(path)) throw new Error('Unknown OTT API endpoint.');
    return settings.apiBaseUrl ? new URL(path.slice(1), settings.apiBaseUrl).href : path;
  }
  window.OTTClientConfig = { configure, apiUrl, get: () => settings };
})();
