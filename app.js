'use strict';
/**
 * OT+T — the front end's shell.
 *
 * OT+T (Onchain Telephone + Telegraph, ticker OTT) is a phone carrier that runs on a memecoin: a
 * creator tax on every trade against the coin's bonding curve funds a treasury, and every week
 * last week's tax becomes that week's data budget — split among HOLDERS by their share of the
 * circulating supply, banked as dollars of credit, and spent on eSIMs from the network partner, paid for over
 * a Blink Lightning wallet. This programme
 * used to be two routes (#/data, #/status) inside a bigger launchpad, whatever.fun; this file is
 * what makes it a site of its own. site/esim.js and site/status.js are the same files that lived
 * there — this shell only hands them the `ctx` they already expected: the DOM helper, the RPC
 * rotation, the wallet flow, and the notice/tile/toast builders. Everything that belonged to the
 * launchpad and not to the programme — the menu, the launch form, the recent-launches table, the
 * 3D hero, the pairing-asset ticker — is left behind rather than carried over unused.
 *
 * No framework. The optional mobile connector has a locally built SDK. Chain reads use endpoints in
 * config/addresses.json, rotated because the official one rate-limits.
 */
(function () {
  const CHAIN_ID_HEX = '0x1237';           // 4663, Robinhood Chain

  const STATE = { cfg: null, account: null, route: '', appScreen: 'home', endpoint: 0 };
  let accountEpoch = 0;
  window.OTT_STATE = STATE;                // a harmless inspection hook

  // ============================================================================ DOM helpers
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const $ = (id) => document.getElementById(id);
  const UI = () => window.WhateverUI || null;         // the shared component kit, if it loaded
  const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '—');

  // ============================================================================ chain reads
  /**
   * Many eth_calls in one HTTP request, with the next endpoint in config/addresses.json's `rpcs`
   * tried on any failure. A call that fails every endpoint throws; esim.js and status.js each
   * decide for themselves whether a failed read costs the whole page or just one tile's dash.
   */
  async function rpcBatch(calls, attempt = 0) {
    if (!calls.length) return [];
    const eps = (STATE.cfg && STATE.cfg.rpcs) || [STATE.cfg && STATE.cfg.rpc].filter(Boolean);
    if (!eps.length) throw new Error('no rpc configured');
    const url = eps[STATE.endpoint++ % eps.length];
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }))),
      });
      const j = await res.json();
      if (!Array.isArray(j)) throw new Error((j && j.error && j.error.message) || 'batch refused');
      const out = new Array(calls.length).fill(null);
      for (const r of j) if (r && typeof r.id === 'number' && !r.error) out[r.id] = r.result;
      return out;
    } catch (e) {
      if (attempt >= eps.length) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return rpcBatch(calls, attempt + 1);
    }
  }

  async function rpc(method, params, attempt = 0) {
    const eps = (STATE.cfg && STATE.cfg.rpcs) || [STATE.cfg && STATE.cfg.rpc].filter(Boolean);
    if (!eps.length) throw new Error('no rpc configured');
    const url = eps[STATE.endpoint++ % eps.length];
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      // A transport failure is not an answer: try the next endpoint before giving up.
      if (attempt >= eps.length) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      return rpc(method, params, attempt + 1);
    }
  }
  const callRaw = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

  // ============================================================================ wallet
  const walletAvailable = () => window.OTTWallet ? window.OTTWallet.available() : !!window.ethereum?.request;
  const walletRequest = args => window.OTTWallet ? window.OTTWallet.request(args) : window.ethereum.request(args);
  function setAccount(account) {
    if (account !== STATE.account) window.WhateverData?.resetWallet?.();
    STATE.account = account || null;
    paintWallet();
  }
  async function disconnect() {
    accountEpoch++;
    window.WhateverData?.resetWallet?.();
    STATE.account = null;
    paintWallet();
    if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
    await window.OTTWallet?.disconnect?.();
  }
  async function connect(options) {
    if (!walletAvailable()) {
      toast('Connect your wallet', 'Open OTT in your wallet browser, or install a browser wallet to connect.');
      paintWallet();
      return null;
    }
    const accounts = window.OTTWallet ? await window.OTTWallet.connect(options) : await window.ethereum.request({ method: 'eth_requestAccounts' });
    const account = accounts && accounts[0] || null;
    if (!account) { setAccount(null); return null; }
    const connectingEpoch = accountEpoch;
    try { await ensureChain(); }
    catch (error) {
      // An account event has already selected (or revoked) the current wallet.
      // Do not disconnect that selection for a stale connection's network check.
      if (connectingEpoch === accountEpoch) await disconnect();
      throw error;
    }
    const selectedAccount = window.OTTWallet?.state?.().accounts[0];
    if (connectingEpoch !== accountEpoch || window.OTTWallet && (!selectedAccount || selectedAccount.toLowerCase() !== account.toLowerCase())) {
      throw new Error('Your wallet changed while connecting. Check the connected account and try again.');
    }
    setAccount(account);
    if (STATE.route === 'app') renderRoute();
    return STATE.account;
  }
  async function ensureChain() {
    try {
      const current = await walletRequest({ method: 'eth_chainId' });
      if (String(current).toLowerCase() === CHAIN_ID_HEX) return true;
      await walletRequest({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
      if (String(await walletRequest({ method: 'eth_chainId' })).toLowerCase() !== CHAIN_ID_HEX) throw new Error('Switch your wallet to Robinhood Chain and try again.');
      return true;
    } catch (e) {
      if (e && e.code === 4902) {
        if (!STATE.cfg || !STATE.cfg.rpc) throw new Error('Network settings are unavailable. Go online and try connecting again.');
        await walletRequest({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN_ID_HEX, chainName: 'Robinhood Chain',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [STATE.cfg.rpc], blockExplorerUrls: [STATE.cfg.explorer],
          }],
        });
        await walletRequest({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
        if (String(await walletRequest({ method: 'eth_chainId' })).toLowerCase() !== CHAIN_ID_HEX) throw new Error('Switch your wallet to Robinhood Chain and try again.');
        return true;
      }
      throw e;
    }
  }
  function paintWallet() {
    const slot = $('wallet-slot');
    if (!slot) return;
    clear(slot);
    if (!STATE.account) { slot.appendChild(h('button', { class: 'btn btn-primary btn-sm', onclick: async () => { const button = slot.querySelector('button'); button.disabled = true; button.textContent = 'Connecting…'; try { await connect(); if (STATE.route === 'data' || STATE.route === 'app') renderRoute(); } catch (e) { toast('Wallet connection failed', e && e.message ? e.message : String(e), 'error'); paintWallet(); } }, 'aria-label': 'Connect wallet' }, 'Connect wallet')); return; }
    slot.appendChild(h('a', { class: 'wallet-addr', href: '#/data', 'aria-label': 'My data, wallet ' + STATE.account }, shortAddr(STATE.account)));
  }
  window.OTTEnsureChain = ensureChain;

  function toast(title, body, kind) {
    const box = $('toasts');
    if (!box) return;
    const el = h('div', { class: 'toast ' + (kind || '') }, h('div', { class: 't-title' }, title), body ? h('div', {}, body) : null);
    box.appendChild(el);
    setTimeout(() => el.remove(), 9000);
    return el;
  }

  // ============================================================================ shared page furniture
  const notice = (text, kind) => h('div', { class: 'notice ' + (kind ? kind : '') }, text);

  function tile(label, value, sub, icon) {
    const u = UI();
    if (u && u.statTile) return u.statTile({ label, value, sub, icon });
    return h('div', { class: 'stat-tile' }, h('div', { class: 'st-label' }, label), h('div', { class: 'st-value' }, value), sub ? h('div', { class: 'st-sub' }, sub) : null);
  }

  // ============================================================================ routes
  const ROUTES = ['home', 'data', 'status', 'holders', 'about', 'app'];
  const APP_SCREENS = ['home', 'plans', 'esims', 'help'];
  // Full <title> strings, not just labels — the title bar says where you are. An empty or unknown
  // hash falls back to 'home', so TITLES.home also stands in whenever STATE.route somehow lands on
  // something this map does not name.
  const TITLES = {
    home: 'OT+T — a memecoin with a data plan',
    data: 'My data — OT+T',
    status: 'Status — OT+T',
    holders: 'Holders — OT+T',
    about: 'How this works — OT+T',
    app: 'OTT app — OT+T',
  };

  /**
   * The home route (#/) — OT+T's whole reason to exist. The programme used to be a second route
   * inside whatever.fun (#/data); here it is the front door, so window.WhateverData.render draws
   * exactly the page it always drew, just reached by a shorter hash. ctx is the one contract
   * site/esim.js was already written against, so nothing in that file changes for the move.
   */
  function renderHome(view, isCurrent) {
    const D = window.WhateverHome;
    if (!D || typeof D.render !== 'function') { view.appendChild(notice('The programme module has not loaded.', 'warn')); return; }
    D.render(view, {
      h, rpc, rpcBatch, callRaw, notice, tile, toast, cfg: STATE.cfg, connect,
      account: STATE.account, currentAccount: () => STATE.account, isCurrent,
    });
  }

  /**
   * The Status route (#/status) lives in site/status.js, wired the same way site/esim.js is: this
   * hands it the same ctx renderHome does, so the two route modules can never see a different
   * picture of the wallet, the RPC rotation or the DOM helper.
   */
  function renderStatus(view, isCurrent) {
    const S = window.WhateverStatus;
    if (!S || typeof S.render !== 'function') { view.appendChild(notice('The status module has not loaded.', 'warn')); return; }
    S.render(view, {
      h, rpc, rpcBatch, callRaw, notice, tile, toast, cfg: STATE.cfg, connect,
      account: STATE.account, currentAccount: () => STATE.account, isCurrent,
    });
  }

  function renderData(view, isCurrent) {
    const D = window.WhateverData;
    if (!D || typeof D.renderMyData !== 'function') { view.appendChild(notice('The data module has not loaded.', 'warn')); return; }
    D.renderMyData(view, {
      h, rpc, rpcBatch, callRaw, notice, tile, toast, cfg: STATE.cfg, connect,
      account: STATE.account, currentAccount: () => STATE.account, isCurrent,
    });
  }

  /**
   * The About route (#/about) — the one page this shell draws itself, because it is short and it
   * is not a route module the way esim.js and status.js are: it keeps no state and reads the chain
   * never. The only thing it reads is config/esim.json, and only for the handful of numbers that
   * would otherwise be typed here a second time and could drift from it — the tax and the
   * catalogue's own shape. A missing config is not an error here: the mechanism described below
   * is still true without a number attached to it, so a figure that cannot be read is named as
   * unconfigured rather than guessed at.
   */
  async function renderAbout(view, isCurrent) {
    view.appendChild(h('div', { class: 'page-head' },
      h('div', { class: 'label' }, 'HOW THIS WORKS'),
      h('h1', {}, 'How this works'),
      h('p', { class: 'page-lede' }, 'Where the data comes from, how your credit is calculated and the limits to keep in mind.')));
    const body = h('div', {}, notice('Loading the programme details…', 'plain'));
    view.appendChild(body);

    let cfg = {};
    try {
      const res = await fetch('./config/esim.json', { cache: 'no-store' });
      cfg = res.ok ? await res.json() : {};
    } catch (e) { cfg = {}; }
    if (!isCurrent()) return;
    cfg = cfg || {};
    const programmeLaunched = [cfg.coin, cfg.curve, cfg.treasury].every((a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '')));

    // A percentage read from the config, or null — never a made-up figure. The two sentences below
    // that use these read naturally either way.
    const pct = (bps) => (Number.isFinite(Number(bps)) && Number(bps) > 0 ? (Number(bps) / 100) + '%' : null);
    const taxPhrase = pct(cfg.taxBps) ? 'a ' + pct(cfg.taxBps) + ' creator tax' : 'a creator tax (the exact rate is not configured yet)';

    // The same rule esim.js uses for what counts as a real package, so this page's catalogue line
    // can never disagree with the one the programme page itself shows.
    const packagesOf = (c) => (Array.isArray(c.packages) ? c.packages : []).filter((p) => p && p.code && Number(p.priceUsd) > 0 && Number(p.gb) > 0);
    const list = packagesOf(cfg);
    const places = new Set(list.map((p) => p.slug)).size;
    const sizes = Array.from(new Set(list.map((p) => Number(p.gb)))).sort((a, b) => a - b);
    const sizesText = sizes.length > 1 ? sizes.slice(0, -1).join(', ') + ' and ' + sizes[sizes.length - 1] : String(sizes[0] || '');
    const cheapest = list.length ? Math.min(...list.map((p) => Number(p.priceUsd))) : null;
    const catalogueText = list.length
      ? 'The current catalogue covers ' + places + ' ' + (places === 1 ? 'place' : 'places') + '. Packages come in ' + sizesText + ' GB sizes and require at least $' + cheapest.toFixed(2) + ' in data credit.'
      : 'The eSIM catalogue is not configured yet.';

    // Prose, not cards. Five bordered boxes stacked down a page is the "cards on cards" habit every
    // carrier site avoids: a card is for one thing that needs lifting off the page, and an article
    // is not that. A hairline between entries and a measure the eye can actually track do the work.
    const entry = (title, ...text) => h('section', { class: 'prose-entry' }, h('h2', { class: 'prose-title' }, title), h('p', { class: 'prose-body' }, ...text));

    clear(body);
    body.appendChild(h('div', { class: 'prose' },
      entry('What OT+T is',
        'OT+T stands for Onchain Telephone + Telegraph. OTT is its memecoin, linking eligible holdings to mobile data. ' + (programmeLaunched ? 'The coin trades' : 'The coin has not launched. When active, it will trade') + ' on Robinhood Chain through a bonding curve, with ' + taxPhrase + ' on each trade. The collected tax goes into a treasury that pays for mobile data.'),
      entry('How weekly data credit works',
        'Each Monday, the previous week’s collected creator tax funds the new week’s data budget. Any reserve is held back first. Your eligible OTT balance is divided by the applicable circulating supply, then multiplied by that budget to calculate your credit. Credit is measured in dollars because data prices vary by country and package size. You can spend it on eSIM packages. Unused credit expires at the weekly reset, while a redeemed package follows its own validity rules.'),
      entry('What decides your share',
        'The weekly snapshot records OTT balances and determines which wallets are eligible. A trade itself does not earn data credit. Your allocation can change when your balance, the circulating supply or the funded budget changes. There is nothing to stake or claim in advance.'),
      entry('Current limits',
        'The current version supports USDG-paired coins before graduation. Once a coin graduates, trading moves from its bonding curve to a public pool. The current system does not track balances and creator tax from that pool, so it cannot calculate new weekly allocations from them. ETH-paired coins are also unsupported because their tax is collected in ETH and cannot currently be used to calculate the dollar budget.'),
      entry('What holding OTT gives you',
        'Eligible holders can receive data credit for the week already funded by collected tax. Credit can only be spent on eSIMs. It cannot be withdrawn as cash, paid out as another asset or carried into the next week. OTT is not equity, a dividend or a claim on the treasury. Buying it does not guarantee a fixed data allowance. Its price can fall to zero. Nothing on this site is financial advice.')));
    body.appendChild(h('p', { class: 'prose-note' }, catalogueText));
  }

  function renderHolders(view, isCurrent) {
    const H = window.OTTHolders;
    if (!H || typeof H.render !== 'function') { view.appendChild(notice('The holders module has not loaded.', 'warn')); return; }
    H.render(view, {
      h, rpc, rpcBatch, callRaw, notice, tile, toast, cfg: STATE.cfg, connect,
      account: STATE.account, currentAccount: () => STATE.account, isCurrent,
    });
  }

  function renderApp(view, isCurrent) {
    const A = window.OTTMobileApp;
    if (!A || typeof A.render !== 'function') { view.appendChild(notice('The OTT app has not loaded. Reload this page to try again.', 'warn')); return; }
    A.render(view, {
      h, rpc, rpcBatch, callRaw, notice, tile, toast, cfg: STATE.cfg, connect,
      account: STATE.account, currentAccount: () => STATE.account, isCurrent,
      refresh: renderRoute,
      walletAvailable, disconnect,
    }, STATE.appScreen);
  }

  const RENDERERS = { home: renderHome, data: renderData, status: renderStatus, holders: renderHolders, about: renderAbout, app: renderApp };
  let renderVersion = 0;

  function renderRoute() {
    const version = ++renderVersion;
    const renderedRoute = STATE.route, renderedScreen = STATE.appScreen;
    const isCurrent = () => {
      if (version !== renderVersion) return false;
      const sectionId = location.hash.slice(1);
      // Focus/section anchors do not navigate away from the current page.
      if (sectionId === 'view') return true;
      if (sectionId && !sectionId.startsWith('/') && renderedRoute === 'home' && document.getElementById(sectionId)) return true;
      // The hash changes before hashchange rerenders. Reject stale async work in that gap.
      const path = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
      const route = ROUTES.includes(path[0]) ? path[0] : 'home';
      const screen = route === 'app' && path.length <= 2 && APP_SCREENS.includes(path[1]) ? path[1] : 'home';
      return route === renderedRoute && (route !== 'app' || screen === renderedScreen);
    };
    window.OTTMobileApp?.dispose?.();
    const view = $('view');
    clear(view);
    view.scrollTop = 0;
    (RENDERERS[STATE.route] || renderHome)(view, isCurrent);
  }

  function navigate() {
    const sectionId = location.hash.slice(1);
    if (sectionId === 'view' && STATE.route) { $('view')?.focus(); return; }
    if (sectionId && !sectionId.startsWith('/') && STATE.route === 'home') {
      const target = document.getElementById(sectionId);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
    const path = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
    const raw = path[0];
    STATE.route = ROUTES.includes(raw) ? raw : 'home';
    STATE.appScreen = STATE.route === 'app' && path.length <= 2 && APP_SCREENS.includes(path[1]) ? path[1] : 'home';
    const appMode = STATE.route === 'app';
    document.body.classList.toggle('home-active', STATE.route === 'home');
    document.body.classList.toggle('ott-app-mode', appMode);
    const masthead = $('masthead'), footer = $('site-footer');
    if (masthead) masthead.hidden = appMode;
    if (footer) footer.hidden = appMode;
    $('nav')?.classList.remove('open');
    $('nav-toggle')?.setAttribute('aria-expanded', 'false');
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === STATE.route));
    document.title = TITLES[STATE.route] || TITLES.home;
    renderRoute();
    if (location.hash.startsWith('#/')) requestAnimationFrame(() => window.scrollTo(0, 0));
  }

  // ============================================================================ boot
  async function boot() {
    const appSettings = fetch('./config/app.json', { cache: 'no-store', signal: AbortSignal.timeout(7000) })
      .then(response => response.ok ? response.json() : {}).catch(() => ({}));
    try {
      STATE.cfg = await fetch('./config/addresses.json', { cache: 'no-store', signal: AbortSignal.timeout(7000) }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    } catch (e) {
      if (/^#\/?app(?:\/|\?|$)/.test(location.hash)) {
        // The installed shell can show offline help without caching or inventing live config.
        STATE.cfg = {};
      } else {
        const view = $('view');
        if (view) view.appendChild(notice('Could not load configuration. Serve this directory over HTTP rather than opening the file directly.', 'error'));
        return;
      }
    }

    const publicConfig = window.OTTClientConfig?.configure(await appSettings) || {};
    window.OTTWallet?.configure({ projectId: publicConfig.walletConnect?.projectId || '',
      chainId: STATE.cfg.chainId, rpc: STATE.cfg.rpc, explorer: STATE.cfg.explorer });
    function accountChanged(accs) {
      accountEpoch++;
      // Revoke signatures even when the provider reports the same account again.
      window.WhateverData?.resetWallet?.();
      STATE.account = accs && accs[0] || null;
      paintWallet();
      if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
    }
    if (window.OTTWallet) {
      window.OTTWallet.on('accountsChanged', accountChanged);
      window.OTTWallet.on('chainChanged', () => {
        window.WhateverData?.resetWallet?.();
        if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
      });
      window.OTTWallet.on('disconnect', () => { if (STATE.account) accountChanged([]); });
    }

    const chain = $('foot-chain');
    if (chain && Number(STATE.cfg.chainId) === 4663) chain.textContent = 'Robinhood Chain · ' + STATE.cfg.chainId;
    const toggle = $('nav-toggle'), nav = $('nav');
    if (toggle && nav) toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    if (nav) nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav && nav.classList.contains('open')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); } });

    paintWallet();
    window.addEventListener('hashchange', navigate);
    navigate();

    if (window.OTTWallet) {
      try {
        const accs = await window.OTTWallet.restore();
        if (accs && accs.length) {
          STATE.account = accs[0]; paintWallet();
          if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
        }
      } catch { /* Browsing the app does not depend on restoring a wallet session. */ }
    } else if (window.ethereum) {
      try {
        const accs = await window.ethereum.request({ method: 'eth_accounts' });
        if (accs && accs.length) { STATE.account = accs[0]; paintWallet(); if (STATE.route === 'data' || STATE.route === 'app') renderRoute(); }
      } catch { /* an unavailable wallet is not an error here */ }
      if (typeof window.ethereum.on === 'function') {
        window.ethereum.on('accountsChanged', (accs) => {
          accountEpoch++;
          window.WhateverData?.resetWallet?.();
          STATE.account = accs && accs[0] || null;
          paintWallet();
          if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
        });
        window.ethereum.on('chainChanged', () => location.reload());
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
