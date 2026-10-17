'use strict';
/**
 * OT+T — the front end's shell.
 *
 * OT+T (Onchain Telephone + Telegraph, ticker OTT) is a phone carrier that runs on a memecoin
 * launched on pump.fun (Solana). Members join by sending about $5 of OTT to Solana's burn address
 * once; every week, 80% of the pump.fun creator fees collected the week before becomes a data
 * budget split among members by holdings, capped, banked as dollars of credit and spent on eSIMs
 * from the network partner, paid for over a Blink Lightning wallet. This programme used to be two
 * routes (#/data, #/status) inside a bigger launchpad, whatever.fun; this file is what makes it a
 * site of its own. It hands each route module the `ctx` it expects: the DOM helper, Solana RPC,
 * the wallet flow, explorer links and the notice/tile/toast builders.
 *
 * No framework. Chain reads go to the browser endpoints in config/addresses.json (`browserRpcs`);
 * Solana's own public endpoint refuses web pages.
 */
(function () {
  const STATE = { cfg: null, account: null, route: '', appScreen: 'home' };
  let accountEpoch = 0;
  let solanaRpc = null;
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
  const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '—');

  // ============================================================================ chain reads
  /** One Solana JSON-RPC call over the browser endpoints, each tried in turn. */
  function rpc(method, params) {
    if (!solanaRpc) {
      const eps = (STATE.cfg && (STATE.cfg.browserRpcs || STATE.cfg.rpcs)) || [];
      if (!eps.length || !window.OTTSolana) return Promise.reject(new Error('no Solana RPC configured'));
      solanaRpc = window.OTTSolana.createRpc(eps, { timeoutMs: 10000, rounds: 2, pauseMs: 300 });
    }
    return solanaRpc(method, params);
  }
  const explorerBase = () => String((STATE.cfg && STATE.cfg.explorer) || 'https://solscan.io').replace(/\/$/, '');
  const explorer = {
    tx: (signature) => explorerBase() + '/tx/' + encodeURIComponent(signature),
    account: (address) => explorerBase() + '/account/' + encodeURIComponent(address),
    token: (mint) => explorerBase() + '/token/' + encodeURIComponent(mint),
  };
  const launchpad = (mint) => String((STATE.cfg && STATE.cfg.launchpad) || 'https://pump.fun').replace(/\/$/, '') + (mint ? '/coin/' + encodeURIComponent(mint) : '');

  // ============================================================================ wallet
  const walletAvailable = () => !!window.OTTWallet && window.OTTWallet.available();
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

  /**
   * Which wallet to connect. One installed wallet is used directly; several get a short list;
   * none get the wallet apps' own "open this page in my browser" links, which is how a phone
   * without a wallet extension reaches OT+T with a wallet attached.
   */
  function chooseWallet(source) {
    return new Promise((resolve) => {
      const wallets = window.OTTWallet ? window.OTTWallet.wallets() : [];
      let picked = null;
      const sheet = h('dialog', { class: 'om-dialog wallet-dialog', 'aria-labelledby': 'wallet-dialog-title' });
      const close = h('button', { type: 'button', class: 'om-icon-button', 'aria-label': 'Close', onclick: () => sheet.close() }, '×');
      const head = h('div', { class: 'om-dialog-head' }, h('h2', { id: 'wallet-dialog-title' }, wallets.length ? 'Choose a wallet' : 'Open OT+T in your wallet'), close);
      const body = wallets.length
        ? h('div', { class: 'wallet-choices' }, wallets.map((w) => h('button', { type: 'button', class: 'wallet-choice', onclick: () => { picked = w.name; sheet.close(); } },
          w.icon ? h('img', { src: w.icon, alt: '', width: '28', height: '28' }) : h('span', { class: 'wallet-choice-mark', 'aria-hidden': 'true' }, w.name.slice(0, 1)),
          h('span', {}, w.name))))
        : h('div', { class: 'om-guide-copy' },
          h('p', {}, 'OT+T works with Solana wallets such as Phantom and Solflare. On a phone, open this page inside your wallet app, then tap Connect wallet.'),
          h('div', { class: 'wallet-choices' },
            h('a', { class: 'om-button', href: window.OTTWallet ? window.OTTWallet.openIn('Phantom') : 'https://phantom.app/', rel: 'noopener' }, 'Open in Phantom'),
            h('a', { class: 'om-secondary-button', href: window.OTTWallet ? window.OTTWallet.openIn('Solflare') : 'https://solflare.com/', rel: 'noopener' }, 'Open in Solflare')),
          h('p', { class: 'om-muted' }, 'On a computer, install a Solana wallet extension such as ', h('a', { href: 'https://phantom.com/download', target: '_blank', rel: 'noopener noreferrer' }, 'Phantom'), ' and reload this page.'));
      sheet.append(head, body);
      sheet.addEventListener('close', () => {
        sheet.remove();
        resolve(picked);
        // Focus goes back once the caller has settled: until then the opener is still disabled,
        // and the masthead redraws its button, so a detached opener hands over to the new one.
        if (!picked) setTimeout(() => (source && source.isConnected ? source : $('wallet-slot')?.querySelector('button'))?.focus?.(), 0);
      }, { once: true });
      document.body.appendChild(sheet);
      if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
    });
  }

  async function connect(options, source) {
    if (!window.OTTWallet) { toast('Wallet unavailable', 'The wallet connector did not load. Reload this page and try again.', 'error'); return null; }
    let name = options && options.wallet;
    if (!name) {
      const wallets = window.OTTWallet.wallets();
      if (wallets.length === 1) name = wallets[0].name;
      else {
        name = await chooseWallet(source);
        if (!name) { paintWallet(); return null; }
      }
    }
    // Account changes and disconnects move the epoch; a second tap on Connect shares this same
    // wallet prompt (OTTWallet.connect), so it must not make this one look stale.
    const connectingEpoch = accountEpoch;
    const accounts = await window.OTTWallet.connect({ wallet: name });
    const account = accounts && accounts[0] || null;
    if (connectingEpoch !== accountEpoch) throw new Error('Your wallet changed while connecting. Check the connected account and try again.');
    setAccount(account);
    if (STATE.route === 'app') renderRoute();
    return STATE.account;
  }
  function paintWallet() {
    const slot = $('wallet-slot');
    if (!slot) return;
    clear(slot);
    if (!STATE.account) {
      const button = h('button', { class: 'btn btn-primary btn-sm', 'aria-label': 'Connect wallet', onclick: async () => {
        button.disabled = true; button.textContent = 'Connecting…';
        try { await connect(null, button); if (STATE.route === 'data' || STATE.route === 'app') renderRoute(); }
        catch (e) { toast('Wallet connection failed', e && e.message ? e.message : String(e), 'error'); paintWallet(); }
      } }, 'Connect wallet');
      slot.appendChild(button);
      return;
    }
    slot.appendChild(h('a', { class: 'wallet-addr', href: '#/data', 'aria-label': 'My data, wallet ' + STATE.account }, shortAddr(STATE.account)));
  }

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

  /** What every route module is handed. */
  function context(isCurrent, extra) {
    return Object.assign({
      h, rpc, notice, tile, toast, cfg: STATE.cfg, connect, explorer, launchpad,
      account: STATE.account, currentAccount: () => STATE.account, isCurrent,
    }, extra || {});
  }

  function renderHome(view, isCurrent) {
    const D = window.WhateverHome;
    if (!D || typeof D.render !== 'function') { view.appendChild(notice('The programme module has not loaded.', 'warn')); return; }
    D.render(view, context(isCurrent));
  }

  function renderStatus(view, isCurrent) {
    const S = window.WhateverStatus;
    if (!S || typeof S.render !== 'function') { view.appendChild(notice('The status module has not loaded.', 'warn')); return; }
    S.render(view, context(isCurrent));
  }

  function renderData(view, isCurrent) {
    const D = window.WhateverData;
    if (!D || typeof D.renderMyData !== 'function') { view.appendChild(notice('The data module has not loaded.', 'warn')); return; }
    D.renderMyData(view, context(isCurrent));
  }

  /**
   * The About route (#/about) — the one page this shell draws itself, because it is short and it
   * keeps no state. The only thing it reads is config/esim.json, for the handful of numbers that
   * would otherwise be typed here a second time and could drift from it. A missing figure drops
   * its phrase rather than inventing one.
   */
  async function renderAbout(view, isCurrent) {
    view.appendChild(h('div', { class: 'page-head' },
      h('div', { class: 'label' }, 'HOW THIS WORKS'),
      h('h1', {}, 'Burn once. Get connected.'),
      h('p', { class: 'page-lede' }, 'Burn about $5 of OTT once to become a member and claim your first eSIM. Collected trading fees then fund members’ weekly data.')));
    const body = h('div', {}, notice('Loading the programme details…', 'plain'));
    view.appendChild(body);

    let cfg = {};
    try {
      const res = await fetch('./config/esim.json', { cache: 'no-store' });
      cfg = res.ok ? await res.json() : {};
    } catch (e) { cfg = {}; }
    if (!isCurrent()) return;
    cfg = cfg || {};
    const S = window.OTTSolana;
    const member = cfg.membership && typeof cfg.membership === 'object' ? cfg.membership : {};
    const programmeLaunched = !!S && S.launchedConfig(cfg);
    const pct = (bps) => (Number.isFinite(Number(bps)) && Number(bps) > 0 ? (Number(bps) / 100) + '%' : null);

    // The same rule esim.js uses for what counts as a real package, so this page's catalogue line
    // can never disagree with the one the programme page itself shows.
    const packagesOf = (c) => (Array.isArray(c.packages) ? c.packages : []).filter((p) => p && p.code && Number(p.priceUsd) > 0 && Number(p.gb) > 0);
    const list = packagesOf(cfg);
    const places = new Set(list.map((p) => p.slug)).size;
    const sizes = Array.from(new Set(list.map((p) => Number(p.gb)))).sort((a, b) => a - b);
    const sizesText = sizes.length > 1 ? sizes.slice(0, -1).join(', ') + ' and ' + sizes[sizes.length - 1] : String(sizes[0] || '');
    const cheapest = list.length ? Math.min(...list.map((p) => Number(p.priceUsd))) : null;
    const catalogueText = list.length
      ? 'The catalogue covers ' + places + ' ' + (places === 1 ? 'place' : 'places') + ' with ' + sizesText + ' GB packages, starting at $' + cheapest.toFixed(2) + ' of data credit.'
      : 'The eSIM catalogue is not configured yet.';

    // Prose, not cards. A hairline between entries and a measure the eye can track do the work.
    const entry = (title, ...text) => h('section', { class: 'prose-entry' }, h('h2', { class: 'prose-title' }, title), h('p', { class: 'prose-body' }, ...text));
    const joinUsd = Number(member.burnUsd) > 0 ? '$' + Number(member.burnUsd).toFixed(0) : null;
    const w = member.welcome && typeof member.welcome === 'object' ? member.welcome : null;
    const welcomeText = w && [w.gb, w.days, w.maxUsd].every((v) => Number(v) > 0)
      ? 'any ' + Number(w.gb) + ' GB, ' + Number(w.days) + '-day plan costing up to $' + Number(w.maxUsd).toFixed(2) : 'a welcome eSIM';
    const cap = Number(member.capMultiple) > 0 ? Number(member.capMultiple) : null;
    const memberShare = pct(cfg.budgetBps);
    const reserveShare = Number(cfg.budgetBps) > 0 && Number(cfg.budgetBps) < 10000 ? (10000 - Number(cfg.budgetBps)) / 100 + '%' : null;

    clear(body);
    body.appendChild(h('div', { class: 'prose' },
      entry('One burn starts your membership',
        'OT+T stands for Onchain Telephone + Telegraph. To join, burn ' + (joinUsd ? 'about ' + joinUsd + ' of OTT' : 'the published amount of OTT') + ' once by sending it to Solana’s burn address, the incinerator, which nobody holds the key to. The app shows this week’s amount in OTT, builds the transaction and asks you to confirm. The amount is set once a week from OTT’s price, so joining costs about the same whatever the price does. Holding OTT or connecting a wallet alone won’t enrol you. Membership doesn’t expire, and there’s one per wallet.' + (programmeLaunched ? '' : ' Joining opens when OTT launches on pump.fun.')),
      entry('Your first eSIM',
        'Each member can claim one welcome eSIM: ' + welcomeText + '. The reserve pays for it, so it doesn’t use your weekly credit, and the claim doesn’t expire.'),
      entry('Trading fees keep the data pool going',
        'OTT trades on pump.fun, which pays the coin’s creator a fee on every trade: 0.30% before the coin graduates, then up to 0.95%, falling as the coin grows. OT+T’s treasury is that creator. '
        + (memberShare ? memberShare + ' of the fees collected each week becomes the next week’s member data budget. ' : 'A published share of the fees collected each week becomes the next week’s member data budget. ')
        + (reserveShare ? 'The other ' + reserveShare + ' stays in the pool as a reserve that pays for welcome eSIMs and payment costs. ' : '')
        + 'The OTT sent to join doesn’t pay for data; collected fees do, and unspent money stays in the pool.'),
      entry('A fair share of a funded pool',
        'Members share the weekly budget by the OTT they hold at the Monday snapshot' + (cap ? ', but no member gets more than ' + cap + '× the average share' : '') + '. What a capped member would have received above that goes to the other members. Non-members get no weekly credit, however much they hold. A new member’s weekly share starts at the next snapshot, and unused credit expires at the end of the week. If no fees were collected, there is no new data allocation.'),
      entry('Sending to the burn address is final',
        'Nobody holds the incinerator’s key, so OTT sent there can’t be returned or refunded. The app offers the send only while the pool’s reserve can pay for a welcome eSIM, and asks you to confirm first. If the eSIM is delayed, for example when many members join at once, your membership stays on-chain and you can claim it later without sending again. Membership doesn’t mean unlimited data: weekly credit depends on fees actually collected.'),
      entry('Make the money trail visible',
        'The status page shows the fees collected, the data budget, supplier spending and the pool balance. Joins, fee collections and the treasury’s transfers are Solana transactions anyone can check on the explorer. Off-chain supplier and payment-provider balances are labelled as reported figures.'),
      entry('An eSIM still needs a mobile network',
        'An external supplier provides the eSIM and mobile service. You will need a compatible, unlocked phone and coverage at your destination. OTT can make the funding and membership records verifiable; it cannot put the mobile network itself on-chain. The app preview demonstrates plan selection and setup using sample data, without an active eSIM.'),
      entry('What is available today',
        'You can explore the catalogue and sample app, connect a Solana wallet and review programme status. ' + (programmeLaunched ? 'Membership and weekly credit follow the rules above while purchases are switched on.' : 'OTT has not launched yet, so joining, weekly credit and purchases stay closed until it does.'))));
    body.appendChild(h('p', { class: 'prose-note' }, catalogueText));
  }

  function renderHolders(view, isCurrent) {
    const H = window.OTTHolders;
    if (!H || typeof H.render !== 'function') { view.appendChild(notice('The holders module has not loaded.', 'warn')); return; }
    H.render(view, context(isCurrent));
  }

  function renderApp(view, isCurrent) {
    const A = window.OTTMobileApp;
    if (!A || typeof A.render !== 'function') { view.appendChild(notice('The OTT app has not loaded. Reload this page to try again.', 'warn')); return; }
    A.render(view, context(isCurrent, { refresh: renderRoute, walletAvailable, disconnect }), STATE.appScreen);
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

    window.OTTClientConfig?.configure(await appSettings);
    function accountChanged(accs) {
      accountEpoch++;
      // Revoke signatures even when the wallet reports the same account again.
      window.WhateverData?.resetWallet?.();
      STATE.account = accs && accs[0] || null;
      paintWallet();
      if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
    }
    if (window.OTTWallet) {
      window.OTTWallet.on('accountsChanged', accountChanged);
      window.OTTWallet.on('disconnect', () => { if (STATE.account) accountChanged([]); });
    }

    const chain = $('foot-chain');
    if (chain && STATE.cfg.chain === 'solana') chain.textContent = 'Solana · pump.fun';
    const explorerLink = $('foot-explorer');
    if (explorerLink && STATE.cfg.explorer) explorerLink.href = STATE.cfg.explorer;
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
        const restoringEpoch = accountEpoch;
        const accs = await window.OTTWallet.restore();
        const selected = window.OTTWallet.state().accounts[0];
        if (restoringEpoch === accountEpoch && accs && accs.length && selected === accs[0]) {
          STATE.account = accs[0]; paintWallet();
          if (STATE.route === 'data' || STATE.route === 'app') renderRoute();
        }
      } catch { /* Browsing the app does not depend on restoring a wallet session. */ }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
