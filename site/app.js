'use strict';
/**
 * OT+T — the front end's shell.
 *
 * OT+T (Onchain Telephone + Telegraph, ticker OTT) is a phone carrier that runs on a memecoin: a
 * 10% creator tax on every trade against the coin's bonding curve funds a treasury, and every
 * trade pays the TRADER — not the holder — a rebate of what they traded, banked as dollars of data
 * credit and spent on eSIMs from nadanada, paid for over a Blink Lightning wallet. This programme
 * used to be two routes (#/data, #/status) inside a bigger launchpad, whatever.fun; this file is
 * what makes it a site of its own. site/esim.js and site/status.js are the same files that lived
 * there — this shell only hands them the `ctx` they already expected: the DOM helper, the RPC
 * rotation, the wallet flow, and the notice/tile/toast builders. Everything that belonged to the
 * launchpad and not to the programme — the menu, the launch form, the recent-launches table, the
 * 3D hero, the pairing-asset ticker — is left behind rather than carried over unused.
 *
 * No build step, no framework, no dependencies. Chain reads are eth_call against the endpoints in
 * config/addresses.json, rotated because the official one rate-limits.
 */
(function () {
  const CHAIN_ID_HEX = '0x1237';           // 4663, Robinhood Chain

  const STATE = { cfg: null, account: null, route: '', endpoint: 0 };
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
  async function connect() {
    if (!window.ethereum) { toast('No wallet found', 'Install a browser wallet to trade or redeem.'); return null; }
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    STATE.account = accounts && accounts[0];
    await ensureChain();
    paintWallet();
    return STATE.account;
  }
  async function ensureChain() {
    try {
      const current = await window.ethereum.request({ method: 'eth_chainId' });
      if (current === CHAIN_ID_HEX) return true;
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
      return true;
    } catch (e) {
      if (e && e.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN_ID_HEX, chainName: 'Robinhood Chain',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [STATE.cfg.rpc], blockExplorerUrls: [STATE.cfg.explorer],
          }],
        });
        return true;
      }
      throw e;
    }
  }
  function paintWallet() {
    const slot = $('wallet-slot');
    if (!slot) return;
    clear(slot);
    if (!STATE.account) { slot.appendChild(h('button', { class: 'btn btn-primary btn-sm', onclick: connect }, 'Connect wallet')); return; }
    slot.appendChild(h('span', { class: 'wallet-addr' }, shortAddr(STATE.account)));
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
  const ROUTES = ['home', 'status', 'about'];
  // Full <title> strings, not just labels — the title bar says where you are. An empty or unknown
  // hash falls back to 'home', so TITLES.home also stands in whenever STATE.route somehow lands on
  // something this map does not name.
  const TITLES = {
    home: 'OT+T — trade the coin, fly with data',
    status: 'Status — OT+T',
    about: 'How this works — OT+T',
  };

  /**
   * The home route (#/) — OT+T's whole reason to exist. The programme used to be a second route
   * inside whatever.fun (#/data); here it is the front door, so window.WhateverData.render draws
   * exactly the page it always drew, just reached by a shorter hash. ctx is the one contract
   * site/esim.js was already written against, so nothing in that file changes for the move.
   */
  function renderHome(view) {
    const D = window.WhateverData;
    if (!D || typeof D.render !== 'function') { view.appendChild(notice('The programme module has not loaded.', 'warn')); return; }
    D.render(view, {
      h, rpc, rpcBatch, callRaw, notice, tile, toast, cfg: STATE.cfg, connect,
      account: STATE.account, currentAccount: () => STATE.account,
    });
  }

  /**
   * The Status route (#/status) lives in site/status.js, wired the same way site/esim.js is: this
   * hands it the same ctx renderHome does, so the two route modules can never see a different
   * picture of the wallet, the RPC rotation or the DOM helper.
   */
  function renderStatus(view) {
    const S = window.WhateverStatus;
    if (!S || typeof S.render !== 'function') { view.appendChild(notice('The status module has not loaded.', 'warn')); return; }
    S.render(view, {
      h, rpc, rpcBatch, callRaw, notice, tile, toast, cfg: STATE.cfg, connect,
      account: STATE.account, currentAccount: () => STATE.account,
    });
  }

  /**
   * The About route (#/about) — the one page this shell draws itself, because it is short and it
   * is not a route module the way esim.js and status.js are: it keeps no state and reads the chain
   * never. The only thing it reads is config/esim.json, and only for the handful of numbers that
   * would otherwise be typed here a second time and could drift from it — the tax, the rebate, and
   * the catalogue's own shape. A missing config is not an error here: the mechanism described below
   * is still true without a number attached to it, so a figure that cannot be read is named as
   * unconfigured rather than guessed at.
   */
  async function renderAbout(view) {
    view.appendChild(h('div', { class: 'page-head' },
      h('div', { class: 'label' }, 'HOW THIS WORKS'),
      h('h1', {}, 'How this works'),
      h('p', { class: 'page-lede' }, 'What OT+T actually is, how a trade turns into a gigabyte, and what this first version deliberately leaves out.')));
    const body = h('div', {}, notice('Reading the numbers…', 'plain'));
    view.appendChild(body);

    let cfg = {};
    try {
      const res = await fetch('./config/esim.json', { cache: 'no-store' });
      cfg = res.ok ? await res.json() : {};
    } catch (e) { cfg = {}; }
    cfg = cfg || {};

    // A percentage read from the config, or null — never a made-up figure. The two sentences below
    // that use these read naturally either way.
    const pct = (bps) => (Number.isFinite(Number(bps)) && Number(bps) > 0 ? (Number(bps) / 100) + '%' : null);
    const taxPhrase = pct(cfg.taxBps) ? 'a ' + pct(cfg.taxBps) + ' creator tax' : 'a creator tax (the exact rate is not configured yet)';
    const rebatePhrase = pct(cfg.rebateBps) ? 'a rebate of ' + pct(cfg.rebateBps) : 'a rebate (the exact rate is not configured yet)';

    // The same rule esim.js uses for what counts as a real package, so this page's catalogue line
    // can never disagree with the one the programme page itself shows.
    const packagesOf = (c) => (Array.isArray(c.packages) ? c.packages : []).filter((p) => p && p.code && Number(p.priceUsd) > 0 && Number(p.gb) > 0);
    const list = packagesOf(cfg);
    const places = new Set(list.map((p) => p.slug)).size;
    const sizes = Array.from(new Set(list.map((p) => Number(p.gb)))).sort((a, b) => a - b);
    const sizesText = sizes.length > 1 ? sizes.slice(0, -1).join(', ') + ' and ' + sizes[sizes.length - 1] : String(sizes[0] || '');
    const cheapest = list.length ? Math.min(...list.map((p) => Number(p.priceUsd))) : null;
    const catalogueText = list.length
      ? places + ' places, ' + sizesText + ' GB packages, from $' + cheapest.toFixed(2) + ' — read live from config/esim.json.'
      : 'The eSIM catalogue is not configured yet.';

    const card = (title, ...text) => h('div', { class: 'card' }, h('h3', { class: 'card-title' }, title), h('p', { class: 'small', style: 'margin-top:8px' }, ...text));

    clear(body);
    body.appendChild(h('div', { class: 'stack' },
      card('What OT+T is',
        'OT+T (Onchain Telephone + Telegraph, ticker OTT) is a phone carrier that runs on a memecoin. The coin trades on Robinhood Chain against a bonding curve, and its contract carries ' + taxPhrase + ' on every trade. That tax is the whole of the carrier’s revenue: it funds a treasury, and the treasury’s only job is buying mobile data.'),
      card('How a trade becomes a gigabyte',
        'Every buy or sell against the curve, in USDG, pays the trader — not the holder — ' + rebatePhrase + ' of what they traded, banked as dollars of data credit rather than a fixed number of gigabytes, because a gigabyte’s price depends on where you spend it and how much of it you buy at once. scripts/allowances.js watches the curve’s USDG transfers and keeps a running balance per wallet in site/data/allowances.json; /api/redeem is what turns that balance into an eSIM from nadanada. The tax side runs on its own: a keeper sweeps it out of the curve’s fee escrow, converts it to sats, and keeps a Blink Lightning wallet funded — that wallet is what actually pays nadanada for every eSIM ordered. No person sits in either loop.'),
      card('Why the trader, and not the holder',
        'The tax is paid by trading, in either direction, so the rebate goes to whoever paid it. Buy and hold, and you earn once, on the way in; buy and sell repeatedly, and you earn again on every pass, because every trade paid tax. Nothing here rewards sitting still — it rewards using the market the tax is funded by.'),
      card('What v1 deliberately leaves out',
        'Two limits are fixed for now, and both are named on the programme page itself rather than hidden. Only pre-graduation trades count: the indexer watches the bonding curve’s own escrow, and once a coin graduates to a public pool, its volume stops being counted here. And only a USDG-paired coin counts at all — rebates are computed from USDG Transfer events between a wallet and the curve, and a coin paired to native ETH produces none of those, so it would earn nothing under v1.'),
      card('The coin is the receipt',
        'OTT is a bonding-curve memecoin, not equity and not a claim on the treasury. What it is a receipt for is the right to trade against the curve and be paid back for it. Holding it and never trading again is just a bet on its price, the same bet holding any memecoin is — and a memecoin can go to zero. Nothing on this site is financial advice.')));
    body.appendChild(h('p', { class: 'small', style: 'margin-top:14px' }, catalogueText));
  }

  const RENDERERS = { home: renderHome, status: renderStatus, about: renderAbout };

  function renderRoute() {
    const view = $('view');
    clear(view);
    view.scrollTop = 0;
    (RENDERERS[STATE.route] || renderHome)(view);
  }

  function navigate() {
    const raw = location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0];
    STATE.route = ROUTES.includes(raw) ? raw : 'home';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === STATE.route));
    document.title = TITLES[STATE.route] || TITLES.home;
    renderRoute();
  }

  // ============================================================================ boot
  async function boot() {
    try {
      STATE.cfg = await fetch('./config/addresses.json', { cache: 'no-store' }).then((r) => r.json());
    } catch (e) {
      const view = $('view');
      if (view) view.appendChild(notice('Could not load configuration. Serve this directory over HTTP rather than opening the file directly.', 'error'));
      return;
    }

    const chain = $('foot-chain');
    if (chain) chain.textContent = 'Robinhood Chain · ' + STATE.cfg.chainId;
    const toggle = $('nav-toggle'), nav = $('nav');
    if (toggle && nav) toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    if (nav) nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => nav.classList.remove('open')));

    paintWallet();
    window.addEventListener('hashchange', navigate);
    navigate();

    if (window.ethereum) {
      try {
        const accs = await window.ethereum.request({ method: 'eth_accounts' });
        if (accs && accs.length) { STATE.account = accs[0]; paintWallet(); }
      } catch { /* an unavailable wallet is not an error here */ }
      if (typeof window.ethereum.on === 'function') {
        window.ethereum.on('accountsChanged', (accs) => { STATE.account = accs && accs[0]; paintWallet(); });
        window.ethereum.on('chainChanged', () => location.reload());
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
