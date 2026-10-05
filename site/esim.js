'use strict';
/**
 * OT+T's public story and holder account. The home route explains how a creator-tax-funded
 * weekly budget becomes wallet data credit, then presents the eSIM catalogue as its use.
 * My data reads the published allocation and redemption API, shows the actual spendable
 * dollar credit first, and keeps installation details behind wallet authorization.
 *
 * app.js supplies DOM, wallet, and routing helpers. This module reads configuration and
 * allowances only when either route opens; missing data is reported without blocking
 * the other routes. Redemption signatures and API calls remain confined to My data.
 */
(function () {
  const SEL = {
    balanceOfToken: '0xf59e38b7',         // balanceOfToken(address,address)  — fee escrow
    balanceOf: '0x70a08231',              // balanceOf(address)               — fee escrow (ETH), any ERC-20
    realQuoteReserve: '0x4f1f58fd',       // realQuoteReserve()               — curve
    graduationThreshold: '0x8b0bc501',    // graduationThreshold()            — curve
    graduated: '0xe7c2b772',              // graduated()                      — curve
    creatorTaxBps: '0xc1bb8901',          // creatorTaxBps()                  — curve
    creatorTaxBalance: '0xdb2bd533',      // creatorTaxBalance()              — curve
    getLaunchedToken: '0x3cf28b5a',       // getLaunchedToken(address)        — factory
  };
  const MESSAGE_HEAD = 'OT+T';
  const LAUNCHPAD_URL = 'https://whatever-fun.vercel.app/#/new';
  let selectedPackageCode = '';
  let myDataRender = 0;

  // ============================================================================ small helpers
  const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
  // The carrier brand, when the config carries one. Every string built from it falls back to the
  // pre-brand wording when this is null, so a fork that has not set cfg.brand renders exactly as
  // the page did before the brand existed.
  const brandOf = (cfg) => (cfg && cfg.brand) || null;
  // Money here is a treasury balance, not a price, so it always carries its cents: "$1,234.50"
  // reads as a balance and "$1,234.5" reads as a typo.
  const fmtMoney = (n) => (Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  // A price from the catalogue: "$0.62". Two decimals, like a shelf label.
  const fmtPrice = (n) => (Number.isFinite(n) ? '$' + n.toFixed(2) : '—');
  // A token balance, human-scaled: thousands separators, at most two decimals — the same tabular
  // treatment the design system gives any balance, never the raw base-unit integer a wallet
  // actually holds on chain.
  const fmtTokens = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');
  // A share of supply, with enough significant figures to mean something for a small holder: 0.15%
  // is fine at two decimals, but a wallet holding a sliver of the supply would round to "0.00%" at
  // that same precision and read as holding nothing. Three significant figures, placed adaptively.
  function fmtSharePct(share) {
    const s = Number(share);
    if (!Number.isFinite(s) || s < 0) return '—';
    if (s === 0) return '0%';
    const pct = s * 100;
    const digits = pct >= 100 ? 0 : Math.min(6, Math.max(0, 2 - Math.floor(Math.log10(pct))));
    return pct.toFixed(digits) + '%';
  }
  // tokens/circulating arrive as decimal strings of base units — too large to trust to a JS number
  // until BigInt has parsed them exactly — alongside a `decimals` figure. Converted to a human-scale
  // float only at the end, the same precision trade the chain-word units() below already makes.
  function unitsFromDecimalStr(s, decimals) {
    try { return Number(BigInt(String(s === null || s === undefined ? '0' : s))) / Math.pow(10, Number(decimals) || 0); }
    catch (e) { return NaN; }
  }
  // A short date — "Sep 15, 2026" — the one format every route in this programme uses for a week.
  function fmtDate(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const packagesOf = (cfg) => (Array.isArray(cfg.packages) ? cfg.packages : []).filter((p) => p && p.code && Number(p.priceUsd) > 0 && Number(p.gb) > 0);
  // A package's price per gigabyte — what actually makes one package a better deal than another,
  // now that a place sells more than one size. "Cheapest"/"dearest" mean cheapest and dearest BY
  // THIS, not by the sticker price: a 10 GB package can cost more dollars than a 1 GB one at the
  // same place and still be the cheaper way to buy a gigabyte.
  const perGb = (p) => Number(p.priceUsd) / (Number(p.gb) || 1);
  const cheapest = (cfg) => packagesOf(cfg).reduce((m, p) => (m && perGb(m) <= perGb(p) ? m : p), null);
  const dearest = (cfg) => packagesOf(cfg).reduce((m, p) => (m && perGb(m) >= perGb(p) ? m : p), null);
  // The cheapest package to just buy, in dollars — "from $0.99" is a shelf price a small holder can
  // actually afford, not a unit price nobody redeems at exactly.
  const packageByCode = (cfg, code) => packagesOf(cfg).find((p) => p.code === code || p.packageCode === code) || null;
  const packageLabel = (p) => p.name + ' · ' + (Number(p.gb) || 1) + ' GB · ' + (Number(p.days) || 7) + ' days';
  // Every place the catalogue sells, once each, in the order esim.json lists them — the same order
  // the picker's place <select> lists them in. `flag` is nadanada's own and empty for a region (a
  // region has no single flag); the plan picker and the coverage grid both use it as-is.
  function places(cfg) {
    const seen = new Set();
    const out = [];
    for (const p of packagesOf(cfg)) {
      if (seen.has(p.slug)) continue;
      seen.add(p.slug);
      out.push({ slug: p.slug, name: p.name, kind: p.kind, flag: p.flag || '' });
    }
    return out;
  }
  // The sizes on offer at one place, smallest first — what the plan grid and the redeem form both
  // build their size options from.
  const packagesAt = (cfg, slug) => packagesOf(cfg).filter((p) => p.slug === slug).sort((a, b) => (Number(a.gb) || 0) - (Number(b.gb) || 0));
  // "$12.40 is 20 GB in Germany, or 2 GB worldwide" — the one line that makes a dollar figure mean
  // something at an airport. Both figures are dollars ÷ a per-GB price, so the count is how many
  // gigabytes the balance actually buys, not how many packages of one fixed size it buys.
  function inGb(cfg, usd) {
    const lo = cheapest(cfg), hi = dearest(cfg);
    if (!Number.isFinite(usd) || !lo) return '';
    const a = Math.floor(usd / perGb(lo));
    if (!hi || hi === lo) return '≈ ' + a + ' GB (' + lo.name + ')';
    return '≈ ' + a + ' GB ' + lo.name + ' · ' + Math.floor(usd / perGb(hi)) + ' GB ' + hi.name;
  }
  // How many OTT a wallet would need to hold, THIS week, to cover one package — the honest
  // successor to "how much you'd have needed to trade": allowanceUsd(tokens) = (tokens ÷
  // circulating) × budgetUsd, solved for tokens. null before the week's budget or the circulating
  // supply is known (before launch, or a week with no tax yet), rather than a division that
  // quietly claims a $0 budget covers everything.
  function tokensToCover(allow, priceUsd) {
    if (!allow || !Number.isFinite(priceUsd)) return null;
    const budgetUsd = Number(allow.budgetUsd);
    const circulating = unitsFromDecimalStr(allow.circulating, allow.decimals);
    if (!(budgetUsd > 0) || !(circulating > 0)) return null;
    return priceUsd * circulating / budgetUsd;
  }
  // Week arithmetic — identical to scripts/allowances.js and site/api/redeem.js, so "this week"
  // never means a different Monday on two ends of the same wire. Weeks start Monday: ANCHOR is
  // Mon 5 Jan 1970 00:00 UTC.
  const WEEK_S = 604800;
  const ANCHOR = 345600;
  const weekOf = (unixSeconds) => Math.floor((unixSeconds - ANCHOR) / WEEK_S);
  const weekStartOf = (w) => ANCHOR + w * WEEK_S;
  const weekEndOf = (w) => weekStartOf(w) + WEEK_S;
  // "3d 14h" — days and hours, the way the founder asked for it, narrowing to minutes once under an
  // hour so the last stretch of a week does not read as "0h" and look broken.
  function fmtCountdown(weekEndSec) {
    const ms = Number(weekEndSec) * 1000 - Date.now();
    if (!Number.isFinite(ms)) return '—';
    if (ms <= 0) return 'any moment';
    const totalMin = Math.ceil(ms / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    if (days > 0) return days + 'd ' + hours + 'h';
    if (hours > 0) return hours + 'h ' + (totalMin % 60) + 'm';
    return totalMin + 'm';
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const errText = (e) => (e && e.message ? e.message : String(e)).slice(0, 200);
  const inApp = () => document.body.classList.contains('ott-app-mode');
  function safeInstallHref(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch (_) { return ''; }
  }

  function safeInstallImage(value) {
    return typeof value === 'string' && (/^data:image\/(png|jpeg|webp|svg\+xml)[;,]/i.test(value) || safeInstallHref(value)) ? value : '';
  }

  function hasInstallDetails(sim) {
    return !!sim && sim.codes === true && !!(sim.ac || sim.manualCode || safeInstallImage(sim.qrCodeUrl)
      || sim.smdpAddress && sim.matchingId || safeInstallHref(sim.appleInstallUrl) || safeInstallHref(sim.androidInstallUrl));
  }

  function orderProgress(ctx, phase, order, sim = order) {
    const labels = ['Select plan', 'Wallet approval', 'Provider issuing', 'Setup details'];
    const stages = ['select', 'wallet', 'issuing', 'setup'];
    const notes = ['Choose a package to begin.', 'Approve this order in your wallet.', 'The provider is issuing your data package.', 'Setup details available. Your phone still needs to add the eSIM.'];
    if (!hasInstallDetails(sim)) notes[3] = 'Package issued. Installation details haven’t been supplied yet. Refresh your eSIMs.';
    if (order?.toppedUp || order?.topupOf) notes[3] = 'Top-up issued. Your existing eSIM does not need another installation.';
    return ctx.h('div', { class: 'data-order-progress', role: 'status', 'aria-live': 'polite', 'aria-label': 'Order progress', 'data-phase': stages[phase] },
      ctx.h('ol', {}, labels.map((label, i) => ctx.h('li', { 'data-step': stages[i], 'aria-current': i === phase ? 'step' : null, class: i < phase ? 'complete' : '' },
        ctx.h('span', { 'aria-hidden': 'true' }, String(i + 1)), ctx.h('span', {}, label)))),
      ctx.h('p', { class: 'data-order-progress-note' }, notes[phase]));
  }

  // The bytes of a UTF-8 string as 0x-hex, which is what personal_sign wants in params[0]. A
  // wallet handed the plain string would sign it too, but some hex-decode anything that looks like
  // hex and sign the wrong bytes; the encoded form is unambiguous.
  function hexOfUtf8(text) {
    const bytes = new TextEncoder().encode(text);
    let out = '0x';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
  }

  // What the wallet is asked to sign, built here and nowhere else so this and /api/redeem cannot
  // drift. A redemption's message names the plan and the slot, so the signature authorises that one
  // order and nothing else — someone who talks a holder into signing it gets at most that single
  // eSIM, not the run of their week. It is also written to be read: a person squinting at their
  // wallet prompt should be able to tell what they are about to approve, and on whose site.
  function signInMessage(address, want) {
    const head = want.action === 'redeem' ? MESSAGE_HEAD + ' — authorise a data redemption' : MESSAGE_HEAD + ' — show my eSIM codes';
    const lines = [head, 'Site: ' + location.host.toLowerCase(), 'Wallet: ' + address.toLowerCase()];
    if (want.action === 'redeem') {
      lines.push('Plan: ' + want.packageCode);
      lines.push('Slot: ' + want.n);
    }
    lines.push('Issued: ' + Math.floor(Date.now() / 1000));
    return lines.join('\n');
  }

  // A read's signature proves who is asking and nothing more, so the last one is kept and reused
  // while it is fresh rather than prompting the wallet again for every "show my codes". The API's
  // own window is ten minutes; reusing within eight leaves margin for the request to land.
  //
  // A REDEMPTION's signature is never reused and never cached: it names the plan and the slot, so
  // it is spent the moment it is used. That costs a wallet prompt per order, which is the right
  // price for the one call that spends money.
  const SIGNIN_REUSE_MS = 8 * 60 * 1000;
  let lastRead = null; // { addr, message, signature, at }
  let walletGeneration = 0;
  const readIsFresh = (addr) => !!(lastRead && lastRead.addr === addr && Date.now() - lastRead.at < SIGNIN_REUSE_MS);
  const walletAvailable = () => window.OTTWallet ? window.OTTWallet.available() : !!window.ethereum?.request;
  async function signIn(addr, want) {
    // Validate the backend destination before asking the holder to sign anything.
    window.OTTClientConfig?.apiUrl('./api/redeem');
    await window.OTTEnsureChain?.();
    const w = want || { action: 'read' };
    if (w.action === 'read' && readIsFresh(addr)) return { message: lastRead.message, signature: lastRead.signature };
    const generation = walletGeneration;
    const message = signInMessage(addr, w);
    const signature = await (window.OTTWallet || window.ethereum).request({ method: 'personal_sign', params: [hexOfUtf8(message), addr] });
    if (generation !== walletGeneration) throw new Error('Your wallet changed while confirming. Reconnect and try again.');
    if (w.action === 'read') lastRead = { addr, message, signature, at: Date.now() };
    return { message, signature };
  }

  async function loadJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // The API answers JSON on every status it chooses itself; a non-JSON body means something in
  // front of it (a 404 from a static host, a gateway page) answered instead, and the status is the
  // only honest thing to say about that.
  async function api(method, path, body) {
    const generation = walletGeneration;
    const url = window.OTTClientConfig?.apiUrl(path) || path;
    const res = await fetch(url, {
      method, headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(body?.packageCode ? 65000 : 15000),
    });
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (body && generation !== walletGeneration) throw new Error('Your wallet changed. Reconnect to view this account.');
    if (!j) throw new Error('redeem API answered HTTP ' + res.status);
    if (!j.ok) throw new Error(j.error || 'redeem API refused (HTTP ' + res.status + ')');
    return j;
  }

  /** Only the live API knows what is still spendable. A ledger file cannot replace it. */
  async function loadAccount(address) {
    if (!isAddress(address)) throw new Error('Connect a wallet to load your account.');
    const standing = await api('GET', './api/redeem?address=' + address.toLowerCase());
    if (String(standing.address || '').toLowerCase() !== address.toLowerCase()) throw new Error('The account response belongs to another wallet.');
    const nowWeek = weekOf(Math.floor(Date.now() / 1000));
    const stale = standing.stale !== false || Number(standing.week) !== nowWeek || !(Number(standing.weekEnd) > Date.now() / 1000);
    const amount = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    return { address: standing.address, stale,
      remainingUsd: stale ? null : amount(standing.remainingUsd),
      allocatedUsd: stale ? null : amount(standing.allowanceUsd),
      usedUsd: stale ? null : amount(standing.redeemedUsd),
      weekEnd: stale ? null : Number(standing.weekEnd),
      orderCount: (standing.orders || []).length + (standing.history || []).length };
  }

  // ============================================================================ the page
  // Public story: proposition, funding, use, catalogue, account preview, and conditions.
  async function render(view, ctx) {
    const { h, notice } = ctx;
    let cfg;
    try { cfg = await loadJson('./config/esim.json'); }
    catch (e) {
      view.appendChild(bareSection(ctx, notice('The data programme is not configured yet (config/esim.json could not be read: ' + errText(e) + ').', 'warn')));
      return;
    }
    if (ctx.isCurrent && !ctx.isCurrent()) return;
    cfg = cfg || {};
    const launched = isAddress(cfg.coin) && isAddress(cfg.curve) && isAddress(cfg.treasury);
    view.appendChild(hero(ctx, cfg, launched));

    // The optional allowances file adds current-week context to the catalogue.
    let allow = null;
    try { allow = await loadJson('./data/allowances.json'); } catch (e) { allow = null; }
    if (ctx.isCurrent && !ctx.isCurrent()) return;

    view.appendChild(trustRow(ctx, cfg, launched));
    view.appendChild(howItWorks(ctx, cfg));
    view.appendChild(plansSection(ctx, cfg, allow, launched));
    view.appendChild(coverageSection(ctx, cfg));
    view.appendChild(accountPreview(ctx, launched));
    view.appendChild(faqSection(ctx));
    const sectionId = location.hash.slice(1);
    if (sectionId && !sectionId.startsWith('/') && document.getElementById(sectionId)) {
      requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ block: 'start' }));
    }
  }

  async function renderMyData(view, ctx) {
    const renderId = ++myDataRender;
    const isCurrent = () => renderId === myDataRender && (!ctx.isCurrent || ctx.isCurrent());
    const { h, notice } = ctx;
    view.appendChild(h('div', { class: 'page-head dashboard-head' },
      h('div', { class: 'label' }, 'YOUR CONNECTION'),
      h('h1', {}, 'My data'),
      h('p', { class: 'page-lede' }, 'Your weekly data credit, existing eSIMs and next redemption.')));
    let cfg;
    try { cfg = await loadJson('./config/esim.json'); }
    catch (e) { if (isCurrent()) view.appendChild(notice('The data programme could not be loaded: ' + errText(e), 'warn')); return; }
    if (!isCurrent()) return;
    if (!isAddress(cfg.coin) || !isAddress(cfg.curve) || !isAddress(cfg.treasury)) {
      view.appendChild(h('div', { class: 'card dashboard-empty' },
        h('span', { class: 'state-pill' }, 'PRELAUNCH'),
        h('h2', {}, 'Your data starts when OT+T launches.'),
        h('p', {}, 'The catalogue is available to explore, but there is no weekly credit or eSIM redemption yet.'),
        h('a', { class: 'btn btn-primary', href: '#/status' }, 'See programme status'),
        h('a', { class: 'btn btn-ghost', href: '#/' }, 'Explore destinations')));
      return;
    }
    let allow = null;
    try { allow = await loadJson('./data/allowances.json'); } catch (e) { /* The panel reports missing data. */ }
    if (!isCurrent()) return;
    const panel = h('div', { class: 'card data-mine dashboard-panel' });
    view.appendChild(panel);
    paintMine(ctx, cfg, allow, panel);
  }

  // Keep a missing-configuration notice within the regular content width.
  function bareSection(ctx, content) {
    return ctx.h('div', { class: 'section' }, ctx.h('div', { class: 'wrap' }, content));
  }

  // ============================================================================ 1. hero
  // The first-screen route diagram carries the funding and redemption sequence.
  function hero(ctx, cfg, launched) {
    const { h } = ctx;
    const primary = h('a', { class: 'btn btn-primary', href: '#how-it-works' }, 'Follow the signal');
    return h('div', { class: 'section hero' }, h('div', { class: 'wrap' },
      h('div', { class: 'hero-copy' },
        h('span', { class: 'state-pill' }, launched ? 'DATA PROGRAMME ACTIVE' : 'PRELAUNCH · CATALOGUE PREVIEW'),
        h('h1', { class: 'hero-title' }, 'A memecoin with a data plan.'),
        h('p', { class: 'hero-kicker' }, 'Last week’s creator tax. This week’s mobile data.'),
        h('p', { class: 'hero-sub' }, 'Eligible OTT holders receive a share of a variable weekly data budget to redeem for available travel eSIMs.'),
        h('div', { class: 'hero-actions' }, primary,
          h('a', { class: 'btn btn-ghost', href: '#plans' }, 'Explore destinations'),
          h('a', { class: 'hero-text-link', href: '#/data' }, 'My data ↗')),
        h('p', { class: 'hero-foot' }, launched ? 'Allocation depends on the weekly snapshot and collected fees.' : 'The coin has not launched. Weekly credit and redemption are not available yet.')),
      h('div', { class: 'hero-visual', role: 'img', 'aria-label': 'Signal route: creator tax funds a weekly data budget, which is divided among eligible wallets and redeemed for an eSIM package.' },
        h('div', { class: 'route-heading' }, h('span', {}, 'THE DATA ROUTE'), h('span', {}, 'OT+T / 01')),
        h('div', { class: 'signal-route' },
          [['01', 'Creator tax', 'Collected on trades'], ['02', 'Weekly budget', 'Previous week’s fees'], ['03', 'Wallet share', 'Monday snapshot'], ['04', 'eSIM package', 'Redeem data credit']].map(([n, title, sub], i) =>
            h('div', { class: 'route-station' + (i === 2 ? ' route-junction' : '') },
              h('span', { class: 'route-number' }, n),
              h('span', { class: 'route-node', 'aria-hidden': 'true' }, i === 2 ? '+' : ''),
              h('span', { class: 'route-text' }, h('strong', {}, title), h('small', {}, sub))))),
        h('div', { class: 'route-end' }, h('span', { 'aria-hidden': 'true' }, '+'), 'FEES INTO FIELDWORK'))));
  }

  // ============================================================================ funding mechanism
  function trustRow(ctx, cfg, launched) {
    const { h } = ctx;
    return h('section', { class: 'section mechanism', id: 'how-it-works' }, h('div', { class: 'wrap mechanism-grid' },
      h('div', { class: 'mechanism-intro' }, h('span', { class: 'label label--accent' }, 'THE CONNECTION'),
        h('h2', {}, 'A trade creates the tax. A snapshot sets the share.'),
        h('p', {}, 'The creator tax collected in the previous week sets the next week’s data budget. An eligible wallet gets a share based on its OTT balance at the Monday snapshot relative to circulating supply.'),
        h('a', { href: '#/about', class: 'text-arrow' }, 'Read the full rules ↗')),
      h('div', { class: 'mechanism-facts' },
        h('div', { class: 'mechanism-fact' }, h('span', {}, '01 / FUNDING'), h('strong', {}, 'Budget varies with trading.'), h('p', {}, 'Only collected creator tax funds the weekly credit.')),
        h('div', { class: 'mechanism-fact' }, h('span', {}, '02 / ELIGIBILITY'), h('strong', {}, 'The snapshot matters.'), h('p', {}, 'Buying OTT today does not establish eligibility for the current week.')),
        h('div', { class: 'mechanism-fact' }, h('span', {}, '03 / EXPIRY'), h('strong', {}, 'Use the week’s credit that week.'), h('p', {}, 'Unused credit expires. A redeemed package has separate validity rules.')),
        h('p', { class: 'mechanism-status' }, launched ? 'Check My data for your current allocation.' : 'Prelaunch: no weekly budget or holder credit has been published.'))));
  }

  // ============================================================================ 3. plans
  /**
   * The catalogue, presented as a product: pick a place, see its three sizes priced. Changing the
   * place repaints the grid; nothing here waits on a wallet or a chain read, because the catalogue
   * itself needs neither. The "Most data per dollar" badge is computed from each shown package's
   * own price-per-gigabyte, not pinned to a position — whichever of the three is actually the best
   * deal at this place gets it, and that is not always the same slot from one place to the next.
   * `allow` (data/allowances.json, read once in render()) is what lets the meta line say how much
   * OTT a wallet would need to hold to cover a package this week; before launch, or in a week with
   * no budget published yet, that figure is not computable, so the line falls back to the plain
   * coverage fact instead of guessing.
   */
  function plansSection(ctx, cfg, allow, launched) {
    const { h } = ctx;
    const plist = places(cfg);
    const regions = plist.filter((p) => p.kind === 'region');
    const countries = plist.filter((p) => p.kind === 'country');
    const optionLabel = (p) => (p.flag ? p.flag + ' ' : '') + p.name;
    const optionsFor = (list) => list.map((p) => h('option', { value: p.slug }, optionLabel(p)));
    const select = regions.length && countries.length
      ? h('select', { class: 'place-select', id: 'plan-place' },
          h('optgroup', { label: 'Regions' }, optionsFor(regions)),
          h('optgroup', { label: 'Countries' }, optionsFor(countries)))
      : h('select', { class: 'place-select', id: 'plan-place' }, optionsFor(plist));
    const grid = h('div', { class: 'plan-grid' });
    const search = h('input', { class: 'destination-search', id: 'destination-search', type: 'search', placeholder: 'Search a country or region', autocomplete: 'off' });
    const results = h('div', { class: 'destination-results', 'aria-live': 'polite' });
    const clearButton = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { search.value = ''; paintResults(); search.focus(); } }, 'Clear');
    function choose(slug) {
      select.value = slug;
      select.dispatchEvent(new Event('change'));
      search.value = '';
      paintResults();
      document.getElementById('plan-options').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    window.OTT_chooseDestination = choose;
    function paintResults() {
      clear(results);
      const query = search.value.trim().toLocaleLowerCase();
      if (!query) { results.hidden = true; return; }
      results.hidden = false;
      const matches = plist.filter((p) => p.name.toLocaleLowerCase().includes(query));
      if (!matches.length) { results.appendChild(h('p', { class: 'destination-empty' }, 'No matching place in the current catalogue. Try a country or region.')); return; }
      for (const p of matches) results.appendChild(h('button', { type: 'button', class: 'destination-result', onclick: () => choose(p.slug) },
        h('span', {}, (p.flag ? p.flag + ' ' : '') + p.name), h('small', {}, p.kind === 'region' ? 'Region' : 'Country')));
    }
    search.addEventListener('input', paintResults);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = plist.find((p) => p.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())); if (search.value.trim() && first) { e.preventDefault(); choose(first.slug); } } if (e.key === 'Escape') { search.value = ''; paintResults(); } });
    paintResults();

    function paint() {
      clear(grid);
      const here = packagesAt(cfg, select.value);
      if (!here.length) { grid.appendChild(h('p', { class: 'small' }, 'No packages are configured for this place yet.')); return; }
      const best = here.reduce((m, p) => (!m || perGb(p) < perGb(m) ? p : m), null);
      for (const p of here) {
        const need = tokensToCover(allow, p.priceUsd);
        // "Most data per dollar" only means something when there is a second size to lose to — a
        // place with a single size is not a deal, it is the only option, so it earns no badge.
        const featured = here.length > 1 && p === best;
        grid.appendChild(h('div', { class: 'plan-card' + (featured ? ' featured' : '') },
          featured ? h('div', { class: 'plan-badge' }, 'Most data per dollar') : null,
          h('div', { class: 'plan-destination' }, p.name + ' / ' + (p.kind === 'region' ? 'REGION' : 'COUNTRY')),
          h('h3', { class: 'plan-size' }, (Number(p.gb) || 1) + ' GB'),
          h('div', { class: 'plan-term' }, (Number(p.days) || 7) + ' days of data'),
          h('div', { class: 'plan-credit-label' }, 'USES DATA CREDIT'),
          h('div', { class: 'plan-price' }, fmtPrice(p.priceUsd)),
          h('div', { class: 'plan-meta' },
            h('span', {}, p.regions || p.name),
            need !== null ? h('span', {}, 'At this week’s budget, ≈ ' + fmtTokens(need) + ' OTT at snapshot') : null),
          h('a', { class: 'btn btn-sm plan-cta', href: launched ? '#/data' : '#/status', onclick: () => { selectedPackageCode = p.code; } }, launched ? 'Select this plan' : 'Check launch status')));
      }
    }
    select.addEventListener('change', paint);
    paint();

    return h('div', { class: 'section discovery', id: 'plans' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' },
        h('span', { class: 'label label--accent' }, 'THE DATA'),
        h('h2', {}, 'Put the credit to work.'),
        h('p', { class: 'section-lede' }, 'Search a destination and compare available eSIM packages. The figures are data credit required, not the cost of acquiring OTT.')),
      h('div', { class: 'search-shell' }, h('label', { for: 'destination-search' }, 'Find a destination'), h('div', { class: 'search-control' }, search, clearButton), results),
      h('div', { id: 'plan-options', class: 'plan-options' },
        h('div', { class: 'plan-picker' }, h('label', { for: 'plan-place' }, 'Compare plans for'), select),
        grid,
        h('p', { class: 'plan-disclaimer' }, launched ? 'Your weekly allocation depends on the snapshot and available funding. Package availability is confirmed at redemption.' : 'Catalogue preview. OT+T has not launched, so weekly credit and eSIM redemption are not available yet.'))));
  }

  // ============================================================================ 4. how it works
  /**
   * Three plain, specific steps — hold, accrue, redeem — with no marketing language. This is also
   * where the two facts that most need a straight sentence live: that the budget is funded by the
   * coin's own creator tax rather than a promise, and that unused data does not carry over. Both
   * are true regardless of brand, and the wording only differs from a fork with no brand configured
   * in whose name it uses for the curve.
   */
  function howItWorks(ctx, cfg) {
    const { h } = ctx;
    const brand = brandOf(cfg);
    const carrier = brand ? brand.name : 'the coin';
    const steps = [
      { title: 'Hold OTT',
        body: 'Keep any amount of OTT in your wallet. No trading, no staking, no claim to file — holding is the whole mechanism.' },
      { title: 'Receive weekly credit',
        body: 'Each Monday, last week’s creator tax on ' + carrier + '’s trades funds a variable data budget. Your share depends on your balance at the weekly snapshot and the circulating supply.' },
      { title: 'Redeem an eSIM and scan it',
        body: 'Choose a destination and package, then sign with your wallet to redeem. Unused weekly credit expires at the week’s end; a purchased package has its own validity period.' },
    ];
    return h('div', { class: 'section usage', id: 'using-it' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' }, h('span', { class: 'label label--accent' }, 'FROM CREDIT TO COVERAGE'), h('h2', {}, 'When the programme opens, here’s the route.')),
      h('div', { class: 'steps' }, steps.map((s, i) => h('div', { class: 'step' },
        h('div', { class: 'step-n' }, String(i + 1)),
        h('h3', { class: 'step-title' }, s.title),
        h('div', { class: 'step-body' }, s.body))))));
  }

  // ============================================================================ 5. coverage
  /** A collapsible catalogue list: every configured place once, with its cheapest entry. */
  function coverageSection(ctx, cfg) {
    const { h } = ctx;
    const plist = places(cfg);
    const items = plist.map((p) => {
      const cheap = packagesAt(cfg, p.slug).reduce((m, x) => (!m || x.priceUsd <= m.priceUsd ? x : m), null);
      return h('button', { type: 'button', class: 'cov-item', onclick: () => { if (window.OTT_chooseDestination) window.OTT_chooseDestination(p.slug); } },
        h('span', { class: 'cov-flag' }, p.flag),
        h('span', { class: 'cov-name' }, p.name),
        h('span', { class: 'cov-price' }, cheap ? 'from ' + fmtPrice(cheap.priceUsd) + ' credit' : '—'));
    });
    return h('div', { class: 'coverage-summary', id: 'coverage' }, h('div', { class: 'wrap' },
      h('details', { class: 'coverage-details' },
        h('summary', {}, 'View all ' + plist.length + ' destinations', h('span', {}, 'COUNTRIES + REGIONS')),
        h('div', { class: 'cov-grid' }, items))));
  }

  function accountPreview(ctx, launched) {
    const { h } = ctx;
    return h('section', { class: 'section account-preview' }, h('div', { class: 'wrap account-preview-grid' },
      h('div', { class: 'section-head' },
        h('span', { class: 'label label--accent' }, 'THE SERVICE STATEMENT'),
        h('h2', {}, 'See your share. Use what’s there.'),
        h('p', { class: 'section-lede' }, 'My data shows your actual weekly credit, its expiry, and the eSIMs attached to your wallet.'),
        h('a', { class: 'btn btn-primary', href: '#/data' }, launched ? 'Open My data' : 'Preview My data')),
      h('div', { class: 'statement-preview', 'aria-label': 'Layout preview of My data; no wallet balance is shown' },
        h('div', { class: 'statement-top' }, h('strong', {}, 'OT+T / MY DATA'), h('span', {}, 'LAYOUT PREVIEW')),
        h('div', { class: 'statement-value' }, h('span', {}, 'REMAINING WEEKLY CREDIT'), h('strong', {}, '—')),
        h('div', { class: 'statement-line' }, h('span', {}, 'EXPIRES'), h('strong', {}, 'After the weekly reset')),
        h('div', { class: 'statement-line' }, h('span', {}, 'YOUR eSIMs'), h('strong', {}, 'Shown after wallet connection')),
        h('p', {}, 'No account values are shown in this preview.'))));
  }

  function faqSection(ctx) {
    const { h } = ctx;
    const entries = [
      ['How is my weekly credit calculated?', 'The previous week’s creator tax funds a data budget. An eligible wallet’s share is based on its OTT balance at the weekly snapshot relative to the circulating supply. Funding and eligibility can change week to week.'],
      ['When does credit expire?', 'Unused credit expires at the end of the week it was published for. It does not roll over. A redeemed eSIM package has separate validity rules.'],
      ['Can I install the eSIM on my phone?', 'Your device must support eSIMs. Check your device and carrier settings before redeeming. After redemption, use the install link or scan the QR code on another screen.'],
      ['What if I already have an eSIM for a place?', 'A further package for the same place can be added to that eSIM. Packages run consecutively. The provider’s guidance on how long an unused package may wait before activation is unresolved, so do not assume a queued package can be stored indefinitely.'],
      ['What if credit or funding is insufficient?', 'You can choose a smaller package when your credit covers it and the data pool is funded. Otherwise, redemption remains unavailable until the relevant balance or funding changes.'],
    ];
    return h('div', { class: 'section alt faq-section' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' }, h('span', { class: 'label label--accent' }, 'GOOD TO KNOW'), h('h2', {}, 'Before you fly')),
      h('div', { class: 'faq-list' }, entries.map(([q, a]) => h('details', { class: 'faq-item' }, h('summary', {}, q), h('p', {}, a))))));
  }

  // ============================================================================ My data
  /**
   * The wallet's side of the page, and the one the founder asked for by name: how much OTT this
   * wallet holds, and how much data that buys this week. Two sources, most-sure first — /api/redeem
   * knows the full weekly standing, including what has already been redeemed, which nothing else
   * knows; data/allowances.json (`allow`, read once in render() and handed in) is the fallback for
   * the holding itself, so a wallet still sees what it holds even when the API cannot be reached.
   * Each is allowed to fail on its own, and staleness — the week published is not the current one —
   * is said plainly rather than shown as a zero that looks like a verdict.
   */
  async function paintMine(ctx, cfg, allow, panel) {
    const { h, notice } = ctx;
    const account = currentAccount(ctx);
    clear(panel);
    stopCountdown();
    panel.appendChild(h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Your data')));

    if (!account) {
      const hint = h('p', { class: 'hint' }, '');
      const btn = h('button', { class: 'btn btn-primary', onclick: async () => {
        btn.disabled = true;
        try {
          const acc = await ctx.connect();
          if (acc) { lastAccount = acc; paintMine(ctx, cfg, allow, panel); return; }
          hint.textContent = 'No wallet connected.';
        } catch (e) { hint.textContent = 'Could not connect: ' + errText(e); hint.classList.add('err'); }
        finally { btn.disabled = false; }
      } }, 'Connect wallet');
      btn.disabled = !walletAvailable();
      panel.appendChild(h('p', { class: 'small' }, walletAvailable()
        ? 'Connect a wallet to see its weekly credit and eSIMs. Eligibility depends on the weekly balance snapshot and the available budget.'
        : 'No browser wallet detected. Install a compatible wallet to see your weekly credit and eSIMs.'));
      panel.appendChild(h('div', { class: 'data-actions' }, btn));
      panel.appendChild(hint);
      return;
    }

    const addr = account.toLowerCase();
    panel.appendChild(h('p', { class: 'mono data-addr' }, addr));
    const body = h('div', {}, notice('Reading your balance…', 'plain'));
    panel.appendChild(body);

    let standing = null, apiError = null;
    try { standing = await api('GET', './api/redeem?address=' + addr); }
    catch (e) { apiError = errText(e); }

    if ((ctx.isCurrent && !ctx.isCurrent()) || currentAccount(ctx)?.toLowerCase() !== addr || !panel.isConnected) return;

    clear(body);
    const fileRow = allow && allow.wallets ? allow.wallets[addr] : null;
    paintWallet(ctx, cfg, addr, panel, body, { standing, apiError, allow, fileRow });
  }

  /**
   * standing (the API) and allow/fileRow (the indexer's own file) are merged here, standing
   * preferred wherever both know something — it is the only one of the two that knows what has
   * been redeemed. Staleness is believed from the API's own `stale` flag when it is there, and
   * otherwise worked out locally from the file's own week against the wall clock, using the same
   * week arithmetic every file in this programme uses.
   */
  function paintWallet(ctx, cfg, addr, panel, body, sources, freshOrder) {
    const { h, notice } = ctx;
    const { standing, apiError, allow, fileRow } = sources;

    if (!standing && !allow) {
      body.appendChild(notice('Could not read this wallet’s standing: ' + apiError, 'warn'));
      return;
    }

    const decimals = Number(standing && standing.decimals !== undefined && standing.decimals !== null ? standing.decimals : (allow && allow.decimals));
    const dec = Number.isFinite(decimals) ? decimals : 18;
    // Holdings, not spending power: the API reports tokens/share from whatever the file last said
    // even while that file is stale, so these are trusted from `standing` whenever it answered at
    // all — no staleness branch needed here.
    const tokensStr = standing && standing.tokens !== undefined && standing.tokens !== null ? standing.tokens : (fileRow && fileRow.tokens !== undefined ? fileRow.tokens : null);
    const tokens = tokensStr === null ? NaN : unitsFromDecimalStr(tokensStr, dec);
    const shareRaw = standing && standing.share !== undefined && standing.share !== null ? standing.share : (fileRow && fileRow.share);
    const share = shareRaw !== null && shareRaw !== undefined && Number.isFinite(Number(shareRaw)) ? Number(shareRaw) : NaN;
    const week = Number(standing && standing.week !== undefined && standing.week !== null ? standing.week : (allow && allow.week));
    const weekEnd = Number(standing && standing.weekEnd !== undefined && standing.weekEnd !== null ? standing.weekEnd : (allow && allow.weekEnd));
    const nowWeek = weekOf(Math.floor(Date.now() / 1000));
    const stale = standing && standing.stale !== undefined ? !!standing.stale : (Number.isFinite(week) ? week < nowWeek : false);
    // The week the numbers below actually describe: the API's own allowancesWeek when it told us
    // (the exact week the file it read was written for), falling back to this page's own
    // independent read of that file, and finally to "the week before this one" as the least-wrong
    // guess when neither source said.
    const publishedWeekRaw = standing && standing.allowancesWeek !== undefined && standing.allowancesWeek !== null ? standing.allowancesWeek
      : (allow && allow.week !== undefined && allow.week !== null ? allow.week : (Number.isFinite(week) ? week - 1 : NaN));
    const publishedWeek = Number(publishedWeekRaw);
    const publishedWeekEnd = Number.isFinite(publishedWeek) ? weekEndOf(publishedWeek) : NaN;
    // /api/redeem deliberately reports a zero allowance (and so a zero remaining) while a week is
    // stale — it is telling us it has not indexed this week yet, not that the wallet has nothing —
    // so the last real figure, from the indexer's own file, is shown instead of a zero that would
    // read as a verdict. Used/left are then recomputed from that same figure, so a stale week's
    // "left to spend" tile never disagrees with the "Data this week" headline sitting above it.
    const allowUsdRaw = (!stale && standing && standing.allowanceUsd !== undefined && standing.allowanceUsd !== null) ? standing.allowanceUsd
      : (fileRow && fileRow.allowanceUsd !== undefined && fileRow.allowanceUsd !== null ? fileRow.allowanceUsd
        : (standing ? standing.allowanceUsd : null));
    const allowanceUsd = allowUsdRaw !== null && allowUsdRaw !== undefined && Number.isFinite(Number(allowUsdRaw)) ? Number(allowUsdRaw) : NaN;
    const redeemedUsd = standing ? Number(standing.redeemedUsd) : null;
    const apiRemaining = standing && standing.remainingUsd !== null && standing.remainingUsd !== undefined
      ? Number(standing.remainingUsd) : NaN;
    const remainingUsd = standing
      ? (Number.isFinite(apiRemaining) ? apiRemaining
        : (Number.isFinite(allowanceUsd) && Number.isFinite(redeemedUsd) ? Math.max(0, allowanceUsd - redeemedUsd) : NaN))
      : null;

    if (apiError) body.appendChild(notice('Could not reach the redeem API: ' + apiError + '. Showing what the indexer last published; redeeming needs the API back.', 'warn'));

    if (stale) {
      body.appendChild(notice('This week’s allowance has not been published yet — the numbers below are from the week that ended '
        + (fmtDate(publishedWeekEnd) || 'last week') + '. A fresh file is written every half hour.', 'plain'));
    }

    if (panel.classList.contains('dashboard-panel')) {
      body.appendChild(h('div', { class: 'credit-summary' },
        h('div', {}, h('span', { class: 'credit-summary-label' }, 'REMAINING WEEKLY CREDIT'),
          h('strong', {}, stale ? 'Awaiting allocation' : (Number.isFinite(remainingUsd) ? fmtMoney(remainingUsd) : 'Unavailable')),
          h('p', {}, stale ? 'Last published allowance: ' + (Number.isFinite(allowanceUsd) ? fmtMoney(allowanceUsd) : 'unavailable') + '. This is not spendable current-week credit.' : 'For eSIM packages only. It cannot be withdrawn or carried over.')),
        h('div', { class: 'credit-summary-side' }, h('span', {}, 'EXPIRES'), h('b', {}, !stale && Number.isFinite(weekEnd) ? fmtDate(weekEnd) : 'Not published'))));
    }

    // An allowance is a claim on a pool, and the pool can be behind it — the week's budget comes
    // from tax collected on chain, which has no ceiling, while the money that actually pays for
    // eSIMs is moved across by a keeper once a day. A holder is owed the truth about that before
    // they press a button, not a failed order afterwards. `poolUsd` is up to half an hour old and
    // null when the treasury file could not be read, so this only ever speaks when it is sure.
    // Not Number(standing.poolUsd): the API sends null when the treasury file could not be read,
    // and Number(null) is 0 — which would turn "we cannot tell" into "the pool is empty" and warn
    // every holder on the strength of a file that simply was not there.
    const poolRaw = standing == null ? undefined : standing.poolUsd;
    const poolUsd = poolRaw === null || poolRaw === undefined ? NaN : Number(poolRaw);
    const shortfall = Number.isFinite(poolUsd) && standing && Number.isFinite(standing.remainingUsd)
      && standing.remainingUsd > 0 && poolUsd < standing.remainingUsd;
    if (shortfall) {
      body.appendChild(notice('The data pool holds ' + fmtMoney(poolUsd) + ' just now, less than the '
        + fmtMoney(standing.remainingUsd) + ' you have left this week. Smaller plans will go through; the pool is topped up '
        + 'from the treasury once a day, so the rest should clear shortly.', 'warn'));
    }

    if (!Number.isFinite(tokens)) {
      body.appendChild(notice('Your holding and weekly credit are not available right now. Try again when the programme data is published.', 'warn'));
      if (standing) body.appendChild(simsSection(ctx, cfg, addr, standing, freshOrder, allow, panel));
      return;
    }
    if (!(tokens > 0)) {
      body.appendChild(notice('This wallet holds no OTT, so it has no data this week.', 'plain'));
      body.appendChild(h('div', { class: 'data-actions' },
        h('a', { class: 'btn btn-primary', href: LAUNCHPAD_URL, target: '_blank', rel: 'noopener' }, 'Get OTT on whatever.fun')));
      // A wallet that now holds nothing can still have an eSIM from a week it did — simsSection
      // shows it, and quietly shows nothing when there truly is none, the same hasAny guard always
      // gated this on.
      if (standing) body.appendChild(simsSection(ctx, cfg, addr, standing, freshOrder, allow, panel));
      return;
    }

    body.appendChild(dashboardTiles(ctx, cfg, { tokens, share, allowanceUsd, redeemedUsd, remainingUsd: stale ? NaN : remainingUsd, weekEnd: stale ? NaN : weekEnd }));

    if (!standing) {
      body.appendChild(notice('Redeeming, and this week’s past orders, need the redeem API, which could not be reached.', 'warn'));
      return;
    }

    // The SIM is the object: what this wallet already has, and what is queued on it, comes before
    // the picker that adds more — so a returning holder reads "here is your eSIM" before "buy more
    // data", not the other way around.
    if (!((standing.orders || []).length + (standing.history || []).length + (standing.sims || []).length)) {
      body.appendChild(notice('No eSIMs yet. Pick a destination and package below when you have enough weekly credit.', 'plain'));
    }
    body.appendChild(simsSection(ctx, cfg, addr, standing, freshOrder, allow, panel));
    if (stale) return;
    body.appendChild(redeemForm(ctx, cfg, addr, standing, allow, panel, freshOrder));
  }

  // A live countdown reads at most one at a time on this single-page app, so one module-level timer
  // is all it takes; every repaint stops the previous one before it might start a new one, and the
  // interval itself gives up the moment its own tile is no longer on the page (a route change, or a
  // panel rebuilt for some other reason), so nothing here can outlive what it is updating.
  let countdownTimer = null;
  function stopCountdown() { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }

  /** Credit is the spendable unit. A catalogue-based GB equivalent remains secondary. */
  function dashboardTiles(ctx, cfg, d) {
    const { h } = ctx;
    const headline = h('div', { class: 'data-headline' },
      h('div', { class: 'dh-tile' },
        h('div', { class: 'dh-label' }, 'OTT at snapshot'),
        h('div', { class: 'dh-value' }, fmtTokens(d.tokens) + ' OTT'),
        h('div', { class: 'dh-sub' }, fmtSharePct(d.share) + ' of the circulating supply')),
      h('div', { class: 'dh-tile' },
        h('div', { class: 'dh-label' }, 'Weekly allocation'),
        h('div', { class: 'dh-value' }, Number.isFinite(d.allowanceUsd) ? fmtMoney(d.allowanceUsd) : '—'),
        h('div', { class: 'dh-sub' }, 'Data credit, not cash. ' + (inGb(cfg, d.allowanceUsd) || 'Compare packages below.'))));

    const supporting = h('div', { class: 'stat-grid data-tiles' },
      ctx.tile('Used this week', Number.isFinite(d.redeemedUsd) ? fmtMoney(d.redeemedUsd) : '—',
        Number.isFinite(d.redeemedUsd) ? 'Data credit redeemed' : 'Redeem API unavailable', 'coins'),
      ctx.tile('Left this week', Number.isFinite(d.remainingUsd) ? fmtMoney(d.remainingUsd) : '—',
        Number.isFinite(d.remainingUsd) ? 'Spendable on available eSIM packages' : 'Current spendable credit unavailable', 'arrows'),
      ctx.tile('Your share', fmtSharePct(d.share), 'of OTT’s circulating supply', 'shield'),
      liveCountdownTile(ctx, d.weekEnd));

    return h('div', {}, headline, supporting);
  }

  // The "Resets in" tile updates itself every 30 seconds without a full repaint — days-and-hours
  // granularity does not need anything finer, and this way the countdown is actually live rather
  // than frozen at whatever it read when the wallet connected.
  function liveCountdownTile(ctx, weekEndSec) {
    stopCountdown();
    const tile = ctx.tile('Resets in', fmtCountdown(weekEndSec), 'Unused weekly credit does not carry over to next week.', 'clock');
    const valueEl = tile.querySelector('.st-value, .u-tile-value');
    if (valueEl && Number.isFinite(Number(weekEndSec))) {
      countdownTimer = setInterval(() => {
        if (!document.body.contains(tile)) { stopCountdown(); return; }
        valueEl.textContent = fmtCountdown(weekEndSec);
      }, 30000);
    }
    return tile;
  }

  // A picker for which package: first the place, then the size sold at that place, then the one
  // button. The button says what the pick costs, and is disabled with a reason rather than hidden
  // when the balance is short, so a wallet can see how far off it is.
  function redeemForm(ctx, cfg, addr, standing, allow, panel, freshOrder) {
    const { h, notice } = ctx;
    const app = inApp();
    let busy = false;
    const progressOrder = freshOrder || [...standing.orders || [], ...standing.history || []].find((order) => order.pending);
    const progressSim = progressOrder && groupIntoSims(cfg, standing).find((group) => group.bundles.some((order) => order.transactionId === progressOrder.transactionId))?.sim;
    let progress = app ? orderProgress(ctx, progressOrder ? progressOrder.pending ? 2 : 3 : 0, progressOrder, progressSim) : null;
    const plist = places(cfg);
    const regions = plist.filter((p) => p.kind === 'region');
    const countries = plist.filter((p) => p.kind === 'country');
    const remaining = Number(standing.remainingUsd) || 0;
    // Every place this wallet already has a standing eSIM for — nadanada's own sims list, not a
    // guess from past orders, because it is the only thing that actually knows whether the next
    // claim for a place will queue on a profile already installed or mint a new one.
    const simSlugs = new Set((standing.sims || []).map((s) => s.slug).filter(Boolean));
    const optionsFor = (list) => list.map((p) => h('option', { value: p.slug }, p.name));
    // Two optgroups only when the catalogue actually has both kinds — a fork selling only regions,
    // say, gets a plain list rather than one empty group.
    const placeSelect = regions.length && countries.length
      ? h('select', { id: 'f-place' },
          h('optgroup', { label: 'Regions' }, optionsFor(regions)),
          h('optgroup', { label: 'Countries' }, optionsFor(countries)))
      : h('select', { id: 'f-place' }, optionsFor(plist));
    const sizes = h('div', { class: 'data-sizes' });
    const packageInput = h('input', { type: 'hidden', id: 'f-package' });
    // Says, before the click, whether this claim adds to an eSIM already in the holder's phone or
    // issues a new one — the thing item 3 most needs said plainly, right where the place is picked.
    const placeNote = h('p', { class: 'small' }, '');
    const hint = h('p', { class: 'hint' }, '');
    const btn = h('button', { class: 'btn btn-primary btn-block', onclick: () => doRedeem() }, 'Redeem');
    const result = h('div', {});
    const wrap = h('div', { class: 'data-redeem' },
      h('div', { class: 'divider' }),
      h('div', { class: 'label' }, simSlugs.size ? 'ADD DATA' : 'GET YOUR ESIM'),
      h('div', { class: 'field' }, h('label', { for: 'f-place' }, 'Place'), placeSelect),
      placeNote,
      sizes, packageInput,
      btn, hint, progress, result);
    if (!walletAvailable()) wrap.appendChild(notice('Redeeming needs a wallet that can sign a message.', 'plain'));

    function picked() { return packageByCode(cfg, packageInput.value); }
    function paintButton() {
      const p = picked();
      if (!p) { btn.textContent = 'Redeem'; btn.disabled = true; hint.textContent = 'No packages are configured.'; return; }
      btn.textContent = 'Redeem ' + p.name + ' · ' + (Number(p.gb) || 1) + ' GB — ' + fmtPrice(p.priceUsd);
      const short = remaining + 1e-9 < p.priceUsd;
      btn.disabled = short || busy;
      hint.textContent = short ? 'You have ' + fmtMoney(remaining) + ' left this week; this package costs ' + fmtPrice(p.priceUsd) + '.' : '';
      hint.classList.toggle('err', false);
    }
    function selectSize(code) {
      if (busy) return;
      packageInput.value = code;
      for (const el of sizes.children) el.classList.toggle('active', el.dataset.code === code);
      paintButton();
    }
    function paintPlaceNote() {
      const info = plist.find((p) => p.slug === placeSelect.value);
      const name = info ? info.name : 'this place';
      placeNote.textContent = simSlugs.has(placeSelect.value)
        ? 'Adds to your eSIM for ' + name + ' — nothing to install again.'
        : 'Issues a new eSIM for ' + name + ', ready to install.';
    }
    // Changing the place repaints the size row for that place and picks the smallest size, the
    // same as opening the picker for the first time does — and updates the note above so it never
    // names the place the size buttons no longer belong to.
    function paintSizes() {
      clear(sizes);
      paintPlaceNote();
      const here = packagesAt(cfg, placeSelect.value);
      for (const p of here) {
        sizes.appendChild(h('button', { type: 'button', class: 'btn btn-sm', 'data-code': p.code, onclick: () => selectSize(p.code) },
          (Number(p.gb) || 1) + ' GB · ' + (Number(p.days) || 7) + ' days — ' + fmtPrice(p.priceUsd)));
      }
      const preferred = here.find((p) => p.code === selectedPackageCode);
      selectSize(preferred ? preferred.code : (here.length ? here[0].code : ''));
    }
    placeSelect.addEventListener('change', paintSizes);
    const selected = packageByCode(cfg, selectedPackageCode);
    if (selected) placeSelect.value = selected.slug;
    paintSizes();

    async function doRedeem() {
      if (busy) return;
      const pkg = picked();
      if (!pkg) return;
      if (!walletAvailable()) { hint.textContent = 'No wallet found to sign with.'; hint.classList.add('err'); return; }
      hint.textContent = ''; hint.classList.remove('err');
      busy = true;
      btn.disabled = true;
      if (app) {
        placeSelect.disabled = true;
        for (const control of sizes.children) control.disabled = true;
      }
      clear(result);
      // n names the slot this redeem means to fill — the count of orders the panel was painted
      // from — so a picture that has gone stale is refused rather than risking two eSIMs for one
      // balance. It is settled before the signature because the signature names it: what the
      // holder approves in their wallet is this plan, in this slot, and nothing else.
      const n = (standing.orders || []).length;
      // A redemption always prompts — its signature is spent on this one order and never reused.
      result.appendChild(notice('Approve the order in your wallet — it names the plan and costs nothing to sign.', 'plain'));
      setProgress(1);
      try {
        const { message, signature } = await signIn(addr, { action: 'redeem', packageCode: pkg.code, n });
        clear(result);
        setProgress(2);
        result.appendChild(notice('Ordering your eSIM… the pool pays our network partner over Lightning and waits for the profile; usually ten to twenty seconds.', 'plain'));
        const out = await api('POST', './api/redeem', { address: addr, message, signature, packageCode: pkg.code, n });
        clear(result);
        // A preview of the eSIM this bundle just landed on — built the same way the repainted
        // panel below will build it, from `out.sims` (nadanada's fresher-than-`standing` picture) —
        // so there is something to look at for the second or two the fuller signed read below
        // takes, not just a toast.
        const previewed = Object.assign({}, standing, {
          orders: (standing.orders || []).concat([out.order]), sims: out.sims || standing.sims || [],
        });
        const previewGroup = groupIntoSims(cfg, previewed).find((g) => g.bundles.some((o) => o.transactionId === out.order.transactionId));
        if (previewGroup) result.appendChild(simCard(ctx, cfg, previewGroup, out.order));
        setProgress(out.order && out.order.pending ? 2 : 3, out.order, previewGroup?.sim);
        const issuedLabel = out.order?.toppedUp || out.order?.topupOf ? 'Top-up issued' : hasInstallDetails(previewGroup?.sim) ? 'Setup details available' : 'Package issued';
        if (typeof ctx.toast === 'function') ctx.toast(out.order && out.order.pending ? 'eSIM ordered' : app ? issuedLabel : 'eSIM ready', packageLabel(pkg), 'success');
        // A redemption signature authorizes that order only. Read codes use a separate signature.
        {
          const spent = Number(out.order && out.order.priceUsd) || pkg.priceUsd;
          const fallback = Object.assign({}, standing, {
            remainingUsd: out.remainingUsd,
            redeemedUsd: Math.round((Number(standing.redeemedUsd || 0) + spent) * 100) / 100,
            orders: (standing.orders || []).concat([out.order]),
            sims: out.sims || standing.sims || [],
          });
          repaintFrom(ctx, cfg, addr, allow, fallback, panel, out.order);
        }
      } catch (e) {
        const msg = errText(e);
        busy = false;
        if (app) {
          placeSelect.disabled = false;
          for (const control of sizes.children) control.disabled = false;
        }
        setProgress(0);
        // A stale picture of the wallet's own orders is the one failure worth recovering from
        // without being asked twice: the panel is about to be rebuilt from scratch, so the message
        // goes to a toast, which outlives that rebuild, rather than into the result block paintMine
        // is about to clear out from under it.
        if (/reload/i.test(msg)) {
          if (typeof ctx.toast === 'function') ctx.toast('Could not redeem', msg, 'error');
          paintMine(ctx, cfg, allow, panel);
          return;
        }
        clear(result);
        result.appendChild(notice('Could not redeem: ' + msg, 'error'));
        paintButton();
      }
    }
    function setProgress(phase, order, sim) {
      if (!app || !progress) return;
      const next = orderProgress(ctx, phase, order, sim);
      progress.replaceWith(next);
      progress = next;
    }
    return wrap;
  }

  // After a successful order, the whole wallet panel is rebuilt from the answer the API just gave
  // (`standing`, with the new order pinned at the top as `freshOrder`) — delegating straight to
  // paintWallet rather than keeping a second copy of the tile-building it already does. The GET is
  // not repeated: the API told us the remaining balance, and asking again only costs the provider a
  // walk it has just done.
  function repaintFrom(ctx, cfg, addr, allow, standing, panel, freshOrder) {
    const { h } = ctx;
    clear(panel);
    stopCountdown();
    panel.appendChild(h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Your data')));
    panel.appendChild(h('p', { class: 'mono data-addr' }, addr));
    const body = h('div', {});
    panel.appendChild(body);
    const fileRow = allow && allow.wallets ? allow.wallets[addr] : null;
    paintWallet(ctx, cfg, addr, panel, body, { standing, apiError: null, allow, fileRow }, freshOrder);
  }

  /**
   * Everything this wallet has queued onto an eSIM, one card per profile nadanada actually issued
   * it. A wallet gets one eSIM per PLACE it buys — not one eSIM full stop — because bundles on a
   * profile run consecutively: a Japan bundle queued behind an unused Europe one would be
   * unreachable until the Europe one ended, and the holder would land in Tokyo with data already
   * paid for and no way to use it. A second profile for a second place costs nothing (the SIM is
   * free; only data is billed) and always works on arrival, so buying two places is two SIMs, each
   * topped up on its own from then on. Almost every wallet has exactly one, because almost every
   * wallet keeps buying the same place.
   *
   * A GET, or any unsigned load, never carries a code — an activation code is a one-time thing, and
   * only the wallet that signs for it gets to see one — so every card here starts redacted; "Show my
   * eSIM codes" signs in once and repaints every SIM and every bundle on it from that one signed
   * answer, since the API already answers the whole standing, codes and all, in one signed call.
   * Nothing is shown here at all for a wallet that has never redeemed — the plan picker below is
   * the whole of that state, exactly as it always was.
   */
  function simsSection(ctx, cfg, addr, standing, freshOrder, allow, panel) {
    const { h } = ctx;
    const groups = groupIntoSims(cfg, standing);
    // The reveal button — and the section itself — only appear when there is something to reveal.
    // Offering to show codes to a wallet that has redeemed nothing is an invitation to sign a
    // message for an empty answer.
    const hasAny = ((standing.orders || []).length + (standing.history || []).length + (standing.sims || []).length) > 0;
    if (!hasAny) return h('div', {});

    const label = h('div', { class: 'label' }, groups.length > 1 ? 'YOUR ESIMS' : 'YOUR ESIM');
    const cards = h('div', {}, groups.map((g) => simCard(ctx, cfg, g, freshOrder)));

    const hint = h('p', { class: 'hint' }, '');
    // Only offer to reveal what is actually still hidden. A wallet that has just redeemed is
    // already holding its codes — the redeem answered with them — and a button offering to show
    // what is already on the screen reads as a second, different thing to press.
    const stillHidden = (gs) => gs.some((g) => !g.sim || !g.sim.codes);
    const btn = h('button', { class: 'btn btn-sm', onclick: async () => {
      if (!walletAvailable()) { hint.textContent = 'No wallet found to sign with.'; hint.classList.add('err'); return; }
      btn.disabled = true;
      hint.textContent = ''; hint.classList.remove('err');
      try {
        const { message, signature } = await signIn(addr);
        const out = await api('POST', './api/redeem', { address: addr, message, signature });
        const fresh = groupIntoSims(cfg, out);
        clear(cards);
        for (const g of fresh) cards.appendChild(simCard(ctx, cfg, g, freshOrder));
        label.textContent = fresh.length > 1 ? 'YOUR ESIMS' : 'YOUR ESIM';
        if (!stillHidden(fresh)) btn.remove();
      } catch (e) {
        hint.textContent = 'Could not read your codes: ' + errText(e);
        hint.classList.add('err');
      } finally { btn.disabled = false; }
    } }, 'Show my eSIM codes');

    const actions = h('div', { class: 'data-actions' }, hint);
    if (stillHidden(groups)) actions.insertBefore(btn, hint);
    if (inApp() && ([...standing.orders || [], ...standing.history || []].some((order) => order.pending) || groups.some((group) => group.sim?.codes === true && !hasInstallDetails(group.sim)))) {
      const refresh = h('button', { class: 'btn btn-sm', onclick: async () => {
        if (!panel?.isConnected || ctx.isCurrent && !ctx.isCurrent() || currentAccount(ctx)?.toLowerCase() !== addr) return;
        refresh.disabled = true;
        refresh.textContent = 'Refreshing…';
        try { await paintMine(ctx, cfg, allow, panel); }
        finally { refresh.disabled = false; refresh.textContent = 'Refresh eSIMs'; }
      } }, 'Refresh eSIMs');
      actions.insertBefore(refresh, hint);
    }
    return h('div', { class: 'data-sims' },
      h('div', { class: 'divider' }), label, cards, actions);
  }

  /**
   * This wallet's orders and history, filed under the eSIM each actually lives on. `standing.sims`
   * is nadanada's own list of profiles, and an order's `iccid` — or, before nadanada has finished
   * issuing it, `topupOf` — says which one a bundle belongs to; both are public even before a
   * signature reveals the codes, so grouping reads the same redacted or not. A provider with no
   * notion of a standing profile (site/api/_lib/providers/esimaccess.js, and any order fixture
   * written before this shape existed) sends `sims: []` and puts the full code on every order
   * instead; a completed order that names no top-up IS its own eSIM in that case, so `simFromOrder`
   * below builds the same card straight from the order's own fields — a fork or a test with no
   * per-profile provider still renders the one-eSIM-per-order shape it always did.
   */
  function groupIntoSims(cfg, standing) {
    const byIccid = new Map();
    const groups = (standing.sims || []).map((sim) => {
      const g = { sim, bundles: [] };
      if (sim.iccid) byIccid.set(sim.iccid, g);
      return g;
    });
    const bundles = (standing.orders || []).map((o) => Object.assign({ fromHistory: false }, o))
      .concat((standing.history || []).map((o) => Object.assign({ fromHistory: true }, o)));
    for (const o of bundles) {
      const key = o.iccid || o.topupOf || '';
      let g = key && byIccid.get(key);
      if (!g) { g = { sim: null, bundles: [] }; if (key) byIccid.set(key, g); groups.push(g); }
      // A bundle naming no top-up minted this profile, whether or not its code is visible right
      // now, so it is the one thing here allowed to stand in for a SIM this group has not seen yet.
      if (!g.sim && !o.toppedUp && !o.topupOf) g.sim = simFromOrder(o, placeOfOrder(cfg, o));
      g.bundles.push(o);
    }
    groups.sort((a, b) => (Date.parse((b.sim && b.sim.createdAt) || (b.bundles[0] && b.bundles[0].createdAt) || '') || 0)
      - (Date.parse((a.sim && a.sim.createdAt) || (a.bundles[0] && a.bundles[0].createdAt) || '') || 0));
    return groups;
  }

  // A SIM built from the order that minted it, for a provider (or a fixture) that never sent
  // `sims` at all — the same fields publicSim() would have carried, read off the order instead.
  function simFromOrder(o, slug) {
    return {
      iccid: o.iccid || '', slug: slug || '', createdAt: o.createdAt || null,
      qrCodeUrl: o.qrCodeUrl || '', ac: o.ac || '', manualCode: o.manualCode || '',
      smdpAddress: o.smdpAddress || '', matchingId: o.matchingId || '',
      appleInstallUrl: o.appleInstallUrl || '', androidInstallUrl: o.androidInstallUrl || '',
      codes: o.codes === true,
    };
  }

  // The place an order/bundle was bought for, read off its package — used both to file a bundle
  // under the right SIM and to title a SIM's own card.
  function placeOfOrder(cfg, o) {
    const p = packageByCode(cfg, o.packageCode);
    return p ? p.slug : '';
  }

  // The place a slug means, read off the same catalogue the plan picker uses, so a SIM card's
  // title is never a second copy of a place's name that could drift from the one on the plan grid.
  // A slug the catalogue no longer carries (a discontinued package) still gets a name: itself.
  function placeInfo(cfg, slug) {
    if (!slug) return null;
    return places(cfg).find((p) => p.slug === slug) || { slug, name: slug, kind: '', flag: '' };
  }

  // "Week of Sep 8, 2026" — for a history card, so it is clear which week paid for an eSIM that is
  // no longer this week's.
  function weekLabel(w) {
    return Number.isFinite(Number(w)) ? 'Week of ' + fmtDate(weekStartOf(Number(w))) : null;
  }

  /**
   * One eSIM: the QR the phone scans, the same activation code as text for the phones that would
   * rather be told than shown, the one-tap install links and the manual SM-DP+/matching-id pair
   * when nadanada sent them, and its ICCID — shown once, per item 1 of the brief, because
   * installing it is a one-time thing even though claiming against it is not. Underneath, every
   * bundle claimed onto it, this week's and previous weeks' together, newest first: what actually
   * changes week to week is not the SIM, only what is queued on it.
   *
   * `group.sim` is null only for a bundle nadanada could not be matched to any known profile — a
   * top-up whose own founding order sits outside the three weeks of history this page ever asks
   * for — and gets a plain notice instead of a card nobody can back with a real code.
   */
  function simCard(ctx, cfg, group, freshOrder) {
    const { h, notice } = ctx;
    // Unsigned metadata never grants permission to display installation details,
    // even if a malformed provider/API response accidentally includes fields.
    const sim = group.sim && group.sim.codes !== true ? Object.assign({}, group.sim, {
      qrCodeUrl: '', ac: '', manualCode: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '',
    }) : group.sim;
    const bundles = group.bundles.slice().sort(bundleNewestFirst);
    // The card itself only reads as "new" when the fresh claim minted it — a top-up onto an eSIM
    // already in the holder's phone does not get the same highlight; the bundle row below still
    // says which line is new either way.
    const mintedByFresh = !!freshOrder && !freshOrder.toppedUp && !freshOrder.topupOf
      && bundles.some((o) => o.transactionId === freshOrder.transactionId);
    const info = sim ? placeInfo(cfg, sim.slug) : placeInfo(cfg, bundles[0] ? placeOfOrder(cfg, bundles[0]) : '');
    const placeName = info ? info.name : 'eSIM';
    // The card's own heading carries the flag, the same way the plan picker's options do; running
    // prose below does not — a flag mid-sentence reads as an emoji text, not a carrier's own copy.
    const title = info && info.flag ? info.flag + ' ' + info.name : placeName;

    if (!sim) {
      return h('div', { class: 'card-quiet data-sim' },
        h('div', { class: 'data-sim-head' }, h('span', { class: 'cc-sym' }, title)),
        notice('Queued on an eSIM you already have — its code was shown when that eSIM was first issued.', 'plain'),
        h('div', { class: 'data-bundles' }, bundles.map((o) => bundleRow(ctx, cfg, o, freshOrder))));
    }

    const activation = sim.ac || sim.manualCode || '';
    const code = h('code', { class: 'mono data-ac' }, activation || '—');
    const copy = h('button', { class: 'btn btn-sm', onclick: async () => {
      try { await navigator.clipboard.writeText(activation); copy.textContent = 'Copied'; }
      catch (e) { copy.textContent = 'Select and copy'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    } }, 'Copy');

    // nadanada usually sends a picture of the QR; when it does not, the activation code alone is
    // enough to draw the same one here — a phone only ever reads the code, never the provider's PNG.
    let qrSrc = safeInstallImage(sim.qrCodeUrl);
    if (!qrSrc && activation && window.WhateverQr) {
      try { qrSrc = window.WhateverQr.svg(activation); } catch (e) { qrSrc = ''; }
    }
    const appleInstallUrl = safeInstallHref(sim.appleInstallUrl);
    const androidInstallUrl = safeInstallHref(sim.androidInstallUrl);
    const install = [
      appleInstallUrl ? h('a', { class: 'btn btn-sm', href: appleInstallUrl, target: '_blank', rel: 'noopener' }, 'Install on iPhone') : null,
      androidInstallUrl ? h('a', { class: 'btn btn-sm', href: androidInstallUrl, target: '_blank', rel: 'noopener' }, 'Install on Android') : null,
    ].filter(Boolean);
    let setup = null;
    const allBundlesPending = bundles.length > 0 && bundles.every((order) => order.pending);
    if (inApp() && !allBundlesPending && hasInstallDetails(sim) && typeof window.OTTMobileApp?.openSetup === 'function') {
      setup = h('button', { class: 'btn btn-primary data-setup', onclick: () => window.OTTMobileApp.openSetup(ctx, sim, setup, placeName) }, 'Set up this eSIM');
    }

    return h('div', { class: 'card-quiet data-sim' + (mintedByFresh ? ' fresh' : '') },
      h('div', { class: 'data-sim-head' },
        h('span', { class: 'cc-sym' }, title),
        sim.iccid ? h('span', { class: 'small mono' }, 'ICCID ' + sim.iccid) : null),
      setup,
      qrSrc ? h('img', { class: 'data-qr', src: qrSrc, alt: 'eSIM QR code for ' + placeName, width: '180', height: '180' }) : null,
      install.length ? h('div', { class: 'data-install' }, install) : null,
      h('div', { class: 'data-ac-row' }, code, copy),
      sim.smdpAddress ? h('p', { class: 'small' }, 'SM-DP+ ', h('span', { class: 'mono' }, sim.smdpAddress), ' · code ', h('span', { class: 'mono' }, sim.matchingId || '')) : null,
      // The one line the brief asked for instead of any amount of UI: bundles run in sequence, and
      // none of them start counting down until the phone is actually on network in this place.
      h('p', { class: 'small' }, 'Bundles on this eSIM queue one after another — the next starts only once the last one runs out, and none of them start counting down until your phone connects to a network in ' + placeName + '.'),
      h('div', { class: 'divider' }),
      h('div', { class: 'data-bundles' }, bundles.map((o) => bundleRow(ctx, cfg, o, freshOrder))));
  }

  /** One claimed bundle: the package, the GB, the place (all three read off packageLabel's own
   *  "name · GB · days"), when it was claimed, and — for a history entry — which week paid for it. */
  function bundleRow(ctx, cfg, o, freshOrder) {
    const { h, notice } = ctx;
    const pkg = packageByCode(cfg, o.packageCode);
    const isFresh = !!freshOrder && o.transactionId === freshOrder.transactionId;
    const when = o.createdAt ? new Date(o.createdAt) : null;

    // What "still working on it" means depends on the stage: the Lightning invoice can be sitting
    // unpaid, or paid and waiting on nadanada to issue it. o.note, when the pool left one, is why.
    let pendingText = null;
    if (o.pending) {
      pendingText = o.stage === 'invoiced' ? 'Paying the invoice… open this page again in a minute.'
        : o.stage === 'paid' ? 'Paid. Our network partner is issuing this bundle — open this page again in a minute.'
        : 'Ordered. The provider is still issuing this bundle — open this page again in a minute.';
      if (o.note) pendingText += ' (' + o.note + ')';
    }

    return h('div', { class: 'data-bundle' },
      h('div', { class: 'data-bundle-head' },
        isFresh ? h('span', { class: 'badge badge-hold' }, 'NEW') : null,
        h('span', { class: 'cc-sym' }, pkg ? packageLabel(pkg) : (o.packageCode || 'eSIM')),
        Number.isFinite(Number(o.priceUsd)) ? h('span', { class: 'small' }, fmtPrice(Number(o.priceUsd))) : null,
        h('span', { class: 'small' },
          when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null,
          o.fromHistory && weekLabel(o.week) ? ' · ' + weekLabel(o.week) : null)),
      pendingText ? notice(pendingText, 'plain') : null);
  }

  // Newest claim first, the same ordering the old per-week lists used — the one at the top of the
  // queue is the one most recently added to it, not the one that will run next.
  function bundleNewestFirst(a, b) {
    const ta = Date.parse(a.createdAt || '') || 0, tb = Date.parse(b.createdAt || '') || 0;
    if (tb !== ta) return tb - ta;
    return ((Number(b.week) || 0) - (Number(a.week) || 0)) || ((Number(b.n) || 0) - (Number(a.n) || 0));
  }

  // The wallet may connect after this route has started rendering (app.js asks the wallet for its
  // accounts after the first paint), so the address is re-read whenever it matters, through the
  // getter app.js provides, and remembered when this page's own button connected it.
  let lastAccount = null;
  function currentAccount(ctx) {
    if (typeof ctx.currentAccount === 'function') return ctx.currentAccount() || null;
    return lastAccount || ctx.account || null;
  }

  window.WhateverData = {
    render, renderMyData, SEL, signInMessage, hexOfUtf8, loadAccount,
    resetWallet: () => { walletGeneration++; lastAccount = null; lastRead = null; },
    selectPackage: (code) => { selectedPackageCode = String(code || ''); },
    // Shared with site/status.js, the same way SEL already is, so the two files cannot silently
    // disagree about how a token amount, a share or a week is read.
    unitsFromDecimalStr, fmtTokens, fmtSharePct, weekOf, weekStartOf, weekEndOf,
  };
})();
