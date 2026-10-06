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
  const accountChain = () => window.OTTWallet?.state().chain || (STATE.account ? 'evm' : null);
  const sameAccount = (left, right) => accountChain() === 'solana' ? left === right : left?.toLowerCase() === right?.toLowerCase();
  function setAccount(account) {
    if (account !== STATE.account) {
      window.WhateverData?.resetWallet?.();
      void window.OTTSolanaLogin?.reset();
    }
    STATE.account = account || null;
    paintWallet();
  }
  async function disconnect() {
    accountEpoch++;
    window.WhateverData?.resetWallet?.();
    const revoked = window.OTTSolanaLogin?.reset();
    STATE.account = null;
    paintWallet();
    if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
    await window.OTTWallet?.disconnect?.();
    await revoked;
  }
  async function connect(options) {
    const solana = options?.transport === 'solana';
    if (!solana && !walletAvailable()) {
      toast('Connect your wallet', 'Open OTT in your wallet browser, or install a browser wallet to connect.');
      paintWallet();
      return null;
    }
    const accounts = window.OTTWallet ? await window.OTTWallet.connect(options) : await window.ethereum.request({ method: 'eth_requestAccounts' });
    const account = accounts && accounts[0] || null;
    if (!account) { setAccount(null); return null; }
    const connectingEpoch = accountEpoch;
    try { if (!solana) await ensureChain(); }
    catch (error) {
      // An account event has already selected (or revoked) the current wallet.
      // Do not disconnect that selection for a stale connection's network check.
      if (connectingEpoch === accountEpoch) await disconnect();
      throw error;
    }
    const selectedAccount = window.OTTWallet?.state?.().accounts[0];
    if (connectingEpoch !== accountEpoch || window.OTTWallet && (!selectedAccount || !sameAccount(selectedAccount, account))) {
      throw new Error('Your wallet changed while connecting. Check the connected account and try again.');
    }
    setAccount(account);
    if (solana) {
      try {
        await window.OTTSolanaLogin.login(account, () => connectingEpoch === accountEpoch && STATE.account === account);
        toast('Signed in with Solana', 'Your wallet ownership is verified. Holder credit currently requires a Robinhood Chain OTT wallet.');
      } catch (error) {
        if (STATE.route === 'app' || STATE.route === 'data') renderRoute();
        throw error;
      }
    }
    if (STATE.route === 'app') renderRoute();
    return STATE.account;
  }
  async function ensureChain() {
    if (accountChain() === 'solana') throw new Error('Holder credit and redemption require a Robinhood Chain OTT wallet.');
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
    if (accountChain() === 'solana') {
      view.appendChild(h('div', { class: 'page-head' }, h('h1', {}, 'Your Solana account'),
        h('p', { class: 'page-lede' }, 'Holder credit currently requires a Robinhood Chain OTT wallet.'),
        h('a', { class: 'btn btn-primary', href: '#/app' }, 'Open your account')));
      return;
    }
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
      h('h1', {}, 'Burn once. Get connected.'),
      h('p', { class: 'page-lede' }, 'The planned membership: burn OTT to enrol and receive your first eSIM. Collected trading fees then fund members’ ongoing data.')));
    const body = h('div', {}, notice('Loading the programme details…', 'plain'));
    view.appendChild(body);

    let cfg = {};
    try {
      const res = await fetch('./config/esim.json', { cache: 'no-store' });
      cfg = res.ok ? await res.json() : {};
    } catch (e) { cfg = {}; }
    if (!isCurrent()) return;
    cfg = cfg || {};
    const programmeLaunched = [cfg.coin, cfg.curve, cfg.treasury].every((a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '')) && !/^0x0{40}$/i.test(String(a)));

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
      ? 'The sample catalogue covers ' + places + ' ' + (places === 1 ? 'place' : 'places') + ' with ' + sizesText + ' GB packages, starting at $' + cheapest.toFixed(2) + ' in example data credit. Catalogue prices do not set the membership burn amount or guarantee an allowance.'
      : 'The eSIM catalogue is not configured yet.';

    // Prose, not cards. Five bordered boxes stacked down a page is the "cards on cards" habit every
    // carrier site avoids: a card is for one thing that needs lifting off the page, and an article
    // is not that. A hairline between entries and a measure the eye can actually track do the work.
    const entry = (title, ...text) => h('section', { class: 'prose-entry' }, h('h2', { class: 'prose-title' }, title), h('p', { class: 'prose-body' }, ...text));

    clear(body);
    body.appendChild(h('div', { class: 'prose' },
      entry('One burn starts your membership',
        'OT+T stands for Onchain Telephone + Telegraph. The planned entry is simple: choose your first eSIM, review the membership terms, then approve a one-time OTT burn to enrol. Holding OTT or connecting a wallet alone will not enrol you. There is no additional burn for each data top-up. Membership enrolment is not open yet.'),
      entry('Trading fees keep the data pool going',
        'Collected trading fees will fund a shared data pool for enrolled members. The burn removes tokens; it does not pay the mobile supplier. Actual collected fees pay for the data. The portion reserved for data and the operating reserve must be published before enrolment opens. Unspent money stays in the pool, including funds reserved to back any outstanding member balances.'),
      entry('A fair share of a funded pool',
        'An equal-member split is the proposed starting point: funded data budget divided by eligible memberships. That formula is an illustration, not a final allocation rule. The membership rules will define who is eligible, how multiple memberships are treated and whether unused balances accumulate or expire. The available allowance changes with collected fees, supplier prices and membership numbers. If there is no funded budget, there is no new data allocation.'),
      entry('Before you approve anything',
        'The exact burn amount, initial eSIM package, membership duration, fee allocation percentage and balance rules are still to be decided. They will appear together before approval. Burn once does not mean unlimited data or a guaranteed allowance forever. Each data package will show its own coverage, size, activation rules and expiry.'),
      entry('Make the money trail visible',
        'The planned public dashboard will show fees received, money allocated to data, supplier spending, reserves and eligible memberships, with timestamps and transaction links. On-chain records can verify burns and transfers. Off-chain supplier and payment-provider balances must be labelled as reported figures. Public burn enrolment will wait for contract review and a real funded eSIM test.'),
      entry('Protect the first connection',
        'The proposed protection is refundable enrolment escrow until the first eSIM is issued, followed by a finalised burn. A timeout would provide a refund route. This escrow, its issuance verification and recovery rules are not implemented yet. They need to be built and reviewed before users can enrol. Any later failed top-up needs a clear retry or recovery path without another burn.'),
      entry('An eSIM still needs a mobile network',
        'An external supplier provides the eSIM and mobile service. You will need a compatible, unlocked phone and coverage at your destination. OTT can make the funding and membership records verifiable; it cannot put the mobile network itself on-chain. The app preview demonstrates plan selection and setup using sample data, without an active eSIM.'),
      entry('What is available today',
        'You can explore the catalogue and sample app, sign in with a supported wallet and review programme status. Burn membership and its protections are planned. The existing test system still uses a weekly holding-based allocation; it is not the proposed membership rule. ' + (programmeLaunched ? 'The current test configuration uses' : 'The token contracts are not configured for launch. The test design uses') + ' Robinhood Chain bonding-curve fees with ' + taxPhrase + '. Purchases remain paused while the funded supplier and phone test is completed.')));
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
      walletAvailable, disconnect, accountChain,
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
      void window.OTTSolanaLogin?.reset();
      STATE.account = accs && accs[0] || null;
      paintWallet();
      if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
    }
    if (window.OTTWallet) {
      window.OTTWallet.on('accountsChanged', accountChanged);
      window.OTTWallet.on('chainChanged', () => {
        window.WhateverData?.resetWallet?.();
        void window.OTTSolanaLogin?.reset();
        if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
      });
      window.OTTWallet.on('disconnect', () => { if (STATE.account) accountChanged([]); });
    }
    window.OTTSolanaLogin?.onChange(() => {
      paintWallet();
      if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
    });

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
        const selected = window.OTTWallet.state().accounts[0];
        if (accs && accs.length && selected && sameAccount(selected, accs[0])) {
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
