'use strict';
/** Installation belongs to an explicit app visit and a user gesture. No wallet state is stored. */
(function () {
  const scriptUrl = document.currentScript && document.currentScript.src;
  const base = new URL('./', scriptUrl || location.href);
  const standalone = window.matchMedia('(display-mode: standalone)');
  let promptEvent = null;
  let registration = null;
  let registering = null;
  let wasInstalled = false;
  let prompting = false;

  function ios() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function capability() {
    const apple = ios();
    return {
      supported: window.isSecureContext && 'serviceWorker' in navigator,
      installed: wasInstalled || standalone.matches || navigator.standalone === true,
      canPrompt: !!promptEvent && !prompting,
      instructions: apple
        ? 'Open this page in Safari. Tap Share, then Add to Home Screen.'
        : 'Open your browser menu and choose Install app or Add to home screen.',
      platform: apple ? 'ios' : 'browser',
      registered: !!registration,
      online: navigator.onLine,
      updateAvailable: !!(registration && registration.waiting),
    };
  }

  function changed() {
    window.dispatchEvent(new CustomEvent('ott:pwa', { detail: capability() }));
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    promptEvent = event;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    wasInstalled = true;
    promptEvent = null;
    changed();
  });
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  if (standalone.addEventListener) standalone.addEventListener('change', changed);

  function register() {
    if (!capability().supported) return Promise.resolve(null);
    if (registering) return registering;
    registering = navigator.serviceWorker.register(new URL('sw.js', base).href, {
      scope: base.pathname,
      updateViaCache: 'none',
    }).then((result) => {
      registration = result;
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (worker) worker.addEventListener('statechange', changed);
      });
      changed();
      return registration;
    }).catch(() => {
      registering = null;
      changed();
      return null;
    });
    return registering;
  }

  async function install() {
    const state = capability();
    if (state.installed) return { outcome: 'installed', instructions: state.instructions };
    if (!promptEvent || prompting) return { outcome: 'manual', instructions: state.instructions };
    const event = promptEvent;
    promptEvent = null;
    prompting = true;
    changed();
    try {
      // Called directly from the install button; do not put an asynchronous task before prompt().
      const immediateChoice = await event.prompt();
      const choice = await (event.userChoice || immediateChoice);
      return { outcome: choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed', instructions: state.instructions };
    } catch (_) {
      return { outcome: 'unavailable', instructions: state.instructions };
    } finally {
      prompting = false;
      changed();
    }
  }

  window.OTTPwa = {
    register,
    install,
    capability,
    subscribe(listener) {
      const handler = (event) => listener(event.detail);
      window.addEventListener('ott:pwa', handler);
      return () => window.removeEventListener('ott:pwa', handler);
    },
  };
})();
