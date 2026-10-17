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
  // The membership burn is a plain ERC-20 transfer to the burn address, and the proof the API
  // accepts is that transfer's own Transfer log, so these are the whole on-chain contract here.
  const TRANSFER_SELECTOR = '0xa9059cbb';  // transfer(address,uint256)
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';  // Transfer(address,address,uint256)
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  let selectedPackageCode = '';
  let myDataRender = 0;

  // ============================================================================ small helpers
  const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
  const word32 = (hex) => String(hex).replace(/^0x/i, '').toLowerCase().padStart(64, '0');
  /** The calldata for transfer(burnAddress, burnUnits): what the wallet is asked to send to the coin. */
  function burnCalldata(burnAddress, burnUnits) {
    if (!isAddress(burnAddress) || burnAddress.toLowerCase() === ZERO_ADDRESS) throw new Error('The burn address is not valid.');
    if (!/^\d{1,78}$/.test(String(burnUnits))) throw new Error('The burn amount is not valid.');
    const units = BigInt(String(burnUnits));
    if (units <= BigInt(0) || units >= BigInt(2) ** BigInt(256)) throw new Error('The burn amount is not valid.');
    return TRANSFER_SELECTOR + word32(burnAddress) + word32(units.toString(16));
  }
  /** Whether a catalogue package can be the welcome eSIM: the welcome size and term, at or under its price cap. */
  function welcomeEligible(pkg, welcome) {
    if (!pkg || !welcome || typeof welcome !== 'object') return false;
    const gb = Number(welcome.gb), days = Number(welcome.days), maxUsd = Number(welcome.maxUsd), price = Number(pkg.priceUsd);
    return [gb, days, maxUsd, price].every(Number.isFinite) && price > 0
      && Number(pkg.gb) === gb && Number(pkg.days) === days && price <= maxUsd;
  }
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
  const packageByCode = (cfg, code) => typeof code === 'string' && code
    ? packagesOf(cfg).find((p) => p.code === code || p.packageCode === code) || null : null;
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
  // A welcome claim's message names its plan and nothing else: a member has exactly one welcome
  // eSIM, so there is no slot to bind, and the API answers a repeat for the same plan with the
  // order it already placed.
  function signInMessage(address, want) {
    const heads = { redeem: ' — authorise a data redemption', welcome: ' — claim my welcome eSIM' };
    const head = MESSAGE_HEAD + (heads[want.action] || ' — show my eSIM codes');
    const lines = [head, 'Site: ' + location.host.toLowerCase(), 'Wallet: ' + address.toLowerCase()];
    if (want.action === 'redeem') {
      lines.push('Plan: ' + want.packageCode);
      lines.push('Slot: ' + want.n);
    }
    if (want.action === 'welcome') lines.push('Plan: ' + want.packageCode);
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
  // Only an unconfirmed submission's public slot/plan, in this page's memory.
  // No signature or installation details are saved, and this is never browser storage.
  const unconfirmedOrders = new Map();
  const submissionKey = (addr, week) => addr.toLowerCase() + ':' + week;
  const submissionSeen = (standing, attempt) => (standing.orders || []).some(order =>
    Number(order.n) === attempt.n && Number(order.week) === attempt.week);
  const readIsFresh = (addr) => !!(lastRead && lastRead.addr === addr && Date.now() - lastRead.at < SIGNIN_REUSE_MS);
  const walletAvailable = () => window.OTTWallet ? window.OTTWallet.available() : !!window.ethereum?.request;
  async function signIn(addr, want, ctx) {
    if (!isAddress(addr) || window.OTTWallet?.state().chain === 'solana') throw new Error('Holder credit and redemption require a Robinhood Chain OTT wallet.');
    // Validate the backend destination before asking the holder to sign anything.
    window.OTTClientConfig?.apiUrl('./api/redeem');
    const generation = walletGeneration;
    await window.OTTEnsureChain?.();
    if (generation !== walletGeneration) {
      // Switching networks refreshes the account and removes old private data.
      // Ask for a deliberate action on that refreshed screen before signing.
      const selected = window.OTTWallet?.state?.().accounts[0];
      if (ctx?.currentAccount?.()?.toLowerCase() === addr.toLowerCase()
        && (!window.OTTWallet || selected?.toLowerCase() === addr.toLowerCase())) {
        ctx.toast?.('Wallet connection updated', 'Review your refreshed account and try your action again.');
      }
      throw new Error('Your wallet connection changed. Review your refreshed account and try again.');
    }
    const w = want || { action: 'read' };
    if (w.action === 'read' && readIsFresh(addr)) return { message: lastRead.message, signature: lastRead.signature };
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
    if (!j.ok) {
      const error = new Error(j.error || 'redeem API refused (HTTP ' + res.status + ')');
      // Validation/auth/slot refusals happen before provider dispatch. A server or
      // gateway failure can follow a payment, so it must keep its unconfirmed state.
      const beforeDispatch = ['data redemption is not enabled yet', 'data config unavailable', 'package has no price', 'allowances unavailable', 'membership is not configured'];
      error.requestDeclined = [400, 401, 403, 409, 422].includes(res.status)
        || res.status === 503 && beforeDispatch.includes(j.error);
      throw error;
    }
    return j;
  }

  /** Only the live API knows what is still spendable. A ledger file cannot replace it. */
  async function loadAccount(address) {
    if (!isAddress(address)) throw new Error('Connect a wallet to load your account.');
    const standing = await api('GET', './api/redeem?address=' + address.toLowerCase());
    if (String(standing.address || '').toLowerCase() !== address.toLowerCase()) throw new Error('The account response belongs to another wallet.');
    const nowWeek = weekOf(Math.floor(Date.now() / 1000));
    const stale = standing.stale !== false || Number(standing.week) !== nowWeek || !Number.isFinite(Number(standing.weekEnd))
      || !(Number(standing.weekEnd) > Date.now() / 1000)
      || (standing.allowancesWeek !== undefined && Number(standing.allowancesWeek) !== nowWeek);
    const amount = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    return { address: standing.address, stale,
      week: Number(standing.week),
      remainingUsd: stale ? null : amount(standing.remainingUsd),
      allocatedUsd: stale ? null : amount(standing.allowanceUsd),
      usedUsd: stale ? null : amount(standing.redeemedUsd),
      weekEnd: stale ? null : Number(standing.weekEnd),
      orderCount: (standing.orders || []).length + (standing.history || []).length,
      membership: publicMembership(standing.membership, address),
      sims: (Array.isArray(standing.sims) ? standing.sims : []).slice(0, 200).filter(sim => sim && typeof sim.slug === 'string')
        .map(sim => ({ slug: sim.slug.slice(0, 80), iccid: typeof sim.iccid === 'string' ? sim.iccid.slice(0, 80) : '',
          createdAt: typeof sim.createdAt === 'string' ? sim.createdAt.slice(0, 40) : null })) };
  }

  /** The membership facts a summary screen may show: public figures and states, never an order's details. */
  function publicMembership(m, address) {
    if (!m || m.configured !== true) return { configured: false };
    const welcome = m.welcome && typeof m.welcome === 'object'
      ? { gb: Number(m.welcome.gb), days: Number(m.welcome.days), maxUsd: Number(m.welcome.maxUsd) } : null;
    return {
      configured: true,
      member: m.member === true || !!knownBurn(String(address || '').toLowerCase()),
      sharing: m.sharing === true,
      welcomeClaimed: !!m.welcomeOrder,
      enrolmentOpen: !!(m.enrolment && m.enrolment.open === true),
      reason: m.enrolment && typeof m.enrolment.reason === 'string' ? m.enrolment.reason.slice(0, 200) : '',
      burnTokens: /^\d{1,30}$/.test(String(m.burnTokens || '')) ? String(m.burnTokens) : '',
      capMultiple: Number.isFinite(Number(m.capMultiple)) && Number(m.capMultiple) > 0 ? Number(m.capMultiple) : null,
      welcome: welcome && [welcome.gb, welcome.days, welcome.maxUsd].every(Number.isFinite) ? welcome : null,
    };
  }

  // A burn this page has seen confirm, per wallet. The API's ledger lists a member only after the
  // indexer runs again, and the welcome claim can prove a newer burn with its transaction hash, so
  // the hash is kept: in memory, and in browser storage so a reload cannot invite a second burn.
  // It is public chain data. The API checks it on chain, and a hash it rejects is forgotten.
  const BURN_STORAGE = 'ott-membership-burn:';
  const confirmedBurns = new Map();
  // A burn sent but not yet confirmed. While one is outstanding the page offers a status check,
  // never a second burn.
  const pendingBurns = new Map();
  const isTxHash = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value || ''));
  function knownBurn(addr) {
    if (!isAddress(addr)) return null;
    if (confirmedBurns.has(addr)) return confirmedBurns.get(addr);
    try {
      const stored = window.localStorage && window.localStorage.getItem(BURN_STORAGE + addr);
      if (isTxHash(stored)) { confirmedBurns.set(addr, stored.toLowerCase()); return stored.toLowerCase(); }
    } catch (e) { /* Storage can be unavailable; memory still holds this page's own burns. */ }
    return null;
  }
  function rememberBurn(addr, hash) {
    if (!isAddress(addr) || !isTxHash(hash)) return;
    confirmedBurns.set(addr, hash.toLowerCase());
    try { window.localStorage && window.localStorage.setItem(BURN_STORAGE + addr, hash.toLowerCase()); } catch (e) { /* memory is enough */ }
  }
  function forgetBurn(addr) {
    confirmedBurns.delete(addr);
    try { window.localStorage && window.localStorage.removeItem(BURN_STORAGE + addr); } catch (e) { /* nothing stored */ }
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
        h('p', { class: 'hero-sub' }, 'Members who burn OTT once receive a share of a variable weekly data budget to redeem for available travel eSIMs.'),
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
        h('p', {}, 'The creator tax collected in the previous week sets the next week’s member data budget. A member wallet’s share follows its OTT balance at the Monday snapshot, capped at a multiple of the average member share.'),
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
      { title: 'Burn once to join',
        body: 'Burn OTT once from your wallet to become a member and claim a welcome eSIM. Holding alone does not earn weekly credit.' },
      { title: 'Receive weekly credit',
        body: 'Each Monday, last week’s creator tax on ' + carrier + '’s trades funds a variable data budget. A member’s share follows their balance at the weekly snapshot, capped at a multiple of the average member share.' },
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
      ['How is my weekly credit calculated?', 'The previous week’s creator tax funds a member data budget. A member wallet’s share follows its OTT balance at the weekly snapshot, and no member gets more than a capped multiple of the average share. Funding can change week to week.'],
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
    if (account && (!isAddress(account) || window.OTTWallet?.state().chain === 'solana')) {
      panel.appendChild(h('p', {}, 'Holder credit currently requires a Robinhood Chain OTT wallet. Solana wallet linking is not available yet.'),
        h('a', { class: 'btn btn-primary', href: '#/app' }, 'Open your account'));
      return;
    }

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

    if (standing && String(standing.address || '').toLowerCase() !== addr) {
      standing = null; apiError = 'The account response belongs to another wallet.';
    }

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
    if (standing) {
      const key = submissionKey(addr, Number(standing.week));
      const attempt = unconfirmedOrders.get(key);
      if (attempt && submissionSeen(standing, attempt)) unconfirmedOrders.delete(key);
    }

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

    // Membership is settled first. A holder who has not joined has no weekly credit, so they see
    // how to join rather than a $0.00 card and a row of zero tiles, which would read as a verdict
    // on the wallet. A deployment without a membership block keeps the old page.
    const membership = standing && standing.membership && standing.membership.configured === true ? standing.membership : null;
    const isMember = !!membership && (membership.member === true || !!knownBurn(addr));
    const showCredit = !membership || isMember;

    if (showCredit && panel.classList.contains('dashboard-panel')) {
      body.appendChild(h('div', { class: 'credit-summary' },
        h('div', {}, h('span', { class: 'credit-summary-label' }, 'REMAINING WEEKLY CREDIT'),
          h('strong', {}, stale ? 'Awaiting allocation' : (Number.isFinite(remainingUsd) ? fmtMoney(remainingUsd) : 'Unavailable')),
          h('p', {}, stale ? 'Last published allowance: ' + (Number.isFinite(allowanceUsd) ? fmtMoney(allowanceUsd) : 'unavailable') + '. This is not spendable current-week credit.' : 'For eSIM packages only. It cannot be withdrawn or carried over.'
            + (standing && standing.membership && standing.membership.configured === true && Number(standing.membership.capMultiple) > 0
              ? ' Members’ weekly credit follows their holdings, and no member gets more than ' + Number(standing.membership.capMultiple) + '× the average.' : ''))),
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
        + fmtMoney(standing.remainingUsd) + ' you have left this week. Some packages may be unavailable until the pool is funded. '
        + 'Check current availability before redeeming.', 'warn'));
    }

    // Membership comes before the holding: a member who burned every token still has a welcome
    // eSIM to claim, and a holder who has not joined is shown how to, not a weekly picker for
    // credit they cannot have.
    if (membership) body.appendChild(membershipSection(ctx, cfg, addr, standing, allow, panel));

    if (!Number.isFinite(tokens)) {
      body.appendChild(notice('Your holding and weekly credit are not available right now. Try again when the programme data is published.', 'warn'));
      if (standing) body.appendChild(simsSection(ctx, cfg, addr, standing, freshOrder, allow, panel));
      return;
    }
    if (!(tokens > 0)) {
      body.appendChild(notice(isMember ? 'This wallet held no OTT at the weekly snapshot, so it has no weekly share this week.'
        : membership ? 'This wallet holds no OTT. Joining burns ' + fmtTokens(Number(membership.burnTokens)) + ' OTT.'
          : 'This wallet holds no OTT, so it has no data this week.', 'plain'));
      if (!isMember) {
        body.appendChild(h('div', { class: 'data-actions' },
          h('a', { class: 'btn btn-primary', href: LAUNCHPAD_URL, target: '_blank', rel: 'noopener' }, 'Get OTT on whatever.fun')));
      }
      // A wallet that now holds nothing can still have an eSIM from a week it did — simsSection
      // shows it, and quietly shows nothing when there truly is none, the same hasAny guard always
      // gated this on.
      if (standing) body.appendChild(simsSection(ctx, cfg, addr, standing, freshOrder, allow, panel));
      return;
    }

    const tiles = dashboardTiles(ctx, cfg, { tokens, share, allowanceUsd, redeemedUsd, remainingUsd: stale ? NaN : remainingUsd, weekEnd: stale ? NaN : weekEnd,
      capMultiple: membership ? Number(membership.capMultiple) : NaN });
    const details = inApp() ? h('details', { class: 'data-account-details' },
      h('summary', {}, 'Credit and holdings details'), tiles) : tiles;
    if (showCredit && (!inApp() || !standing)) body.appendChild(details);

    if (!standing) {
      body.appendChild(notice('Redeeming, and this week’s past orders, need the redeem API, which could not be reached.', 'warn'));
      return;
    }

    // The SIM is the object: what this wallet already has, and what is queued on it, comes before
    // the picker that adds more — so a returning holder reads "here is your eSIM" before "buy more
    // data", not the other way around.
    // A non-member's join card already says what membership brings, so no empty-state notice here.
    if (showCredit && !((standing.orders || []).length + (standing.history || []).length + (standing.sims || []).length + (membership && membership.welcomeOrder ? 1 : 0))) {
      body.appendChild(notice(membership && isMember && !membership.welcomeOrder
        ? 'No eSIMs yet. Claim your free welcome eSIM above, or pick a destination and package below.'
        : 'No eSIMs yet. Pick a destination and package below when you have enough weekly credit.', 'plain'));
    }
    body.appendChild(simsSection(ctx, cfg, addr, standing, freshOrder, allow, panel));
    if (showCredit && inApp()) body.appendChild(details);
    if (stale) return;
    // Weekly credit is for members only; a holder who has not joined has none to spend.
    if (membership && !isMember) return;
    body.appendChild(redeemForm(ctx, cfg, addr, standing, allow, panel, freshOrder));
  }

  // ============================================================================ membership
  /**
   * Join once, claim a welcome eSIM, then share each week's budget. Joining burns `burnTokens` OTT:
   * an ordinary transfer from this wallet to the burn address. A member claims one welcome eSIM
   * that the reserve pays for, and from the next Monday snapshot shares the weekly budget by
   * holdings, with no member above `capMultiple`× the average.
   *
   * Everything here comes from the API's `membership` answer rather than the page's config, so the
   * coin, burn address and amount the wallet is asked to send are exactly what the API accepts as
   * proof. The burn can't be undone, so it is offered only while the API says enrolment is open,
   * only after an explicit confirmation, never while a burn from this page is still confirming,
   * and never once an earlier burn from this wallet is visible on chain.
   */
  const RECEIPT_POLL_MS = 1500;
  const RECEIPT_ATTEMPTS = 80;
  const BURN_SCAN_SPAN = 1000000;
  const BURN_SCAN_CHUNKS = 5;
  // A welcome claim sent without a confirmed answer: its plan, in this page's memory only. A retry
  // must name the same plan, which the API answers with the order it already placed.
  const unconfirmedWelcome = new Map();

  async function waitForReceipt(ctx, hash, alive) {
    for (let i = 0; i < RECEIPT_ATTEMPTS; i++) {
      let receipt = null;
      try { receipt = await ctx.rpc('eth_getTransactionReceipt', [hash]); } catch (e) { receipt = null; }
      if (!alive()) return null;
      if (receipt && typeof receipt === 'object' && receipt.blockNumber && receipt.status !== undefined) return receipt;
      await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
      if (!alive()) return null;
    }
    return null;
  }

  /**
   * One transaction newer than the ledger that already burned enough from this wallet, or null.
   * The ledger lists every member up to its own head block, so only the blocks after it need a
   * look, and a narrow filter answers a million blocks at a time. Any failure answers null: the
   * confirmation step still tells the holder not to burn twice.
   */
  async function findBurn(ctx, m, addr, allow) {
    const from = allow && String(allow.coin || '').toLowerCase() === String(m.coin).toLowerCase() ? Number(allow.block) : NaN;
    if (!Number.isSafeInteger(from) || from <= 0) return null;
    let head;
    try { head = Number(BigInt(await ctx.rpc('eth_blockNumber', []))); } catch (e) { return null; }
    if (!Number.isSafeInteger(head) || head <= from) return null;
    const units = BigInt(String(m.burnUnits));
    const topic = (a) => '0x' + word32(a);
    const totals = new Map();
    for (let lo = Math.max(from + 1, head - BURN_SCAN_SPAN * BURN_SCAN_CHUNKS + 1); lo <= head; lo += BURN_SCAN_SPAN) {
      const hi = Math.min(head, lo + BURN_SCAN_SPAN - 1);
      let logs;
      try {
        logs = await ctx.rpc('eth_getLogs', [{ address: m.coin, topics: [TRANSFER_TOPIC, topic(addr), [topic(m.burnAddress), topic(ZERO_ADDRESS)]],
          fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]);
      } catch (e) { return null; }
      for (const log of Array.isArray(logs) ? logs : []) {
        if (!log || log.removed || String(log.address || '').toLowerCase() !== String(m.coin).toLowerCase() || !isTxHash(log.transactionHash)) continue;
        let value;
        try { value = BigInt(log.data); } catch (e) { continue; }
        const tx = log.transactionHash.toLowerCase();
        const total = (totals.get(tx) || BigInt(0)) + value;
        totals.set(tx, total);
        if (total >= units) return tx;
      }
    }
    return null;
  }

  /**
   * The coin, burn address and amount the wallet is asked to send come from the API. A burn can't
   * be undone, so they must also agree with this site's own published config, and the amount with
   * the published ledger's decimals when that ledger is about the coin. Then one compromised host
   * cannot redirect a member's tokens. Returns why they disagree, or '' when they agree.
   */
  function publishedBurnMismatch(cfg, m, allow) {
    const published = cfg && cfg.membership;
    const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    const refuse = 'The burn details from the server don’t match this site’s published settings, so nothing was sent. Reload and try again.';
    if (!published || !same(cfg.coin, m.coin) || !same(published.burnAddress, m.burnAddress) || String(published.burnTokens || '') !== String(m.burnTokens || '')) return refuse;
    const decimals = Number(allow && allow.decimals);
    if (allow && same(allow.coin, m.coin) && Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 36) {
      if (!/^\d{1,30}$/.test(String(published.burnTokens)) || !/^\d{1,78}$/.test(String(m.burnUnits || ''))) return refuse;
      if (BigInt(String(published.burnTokens)) * BigInt(10) ** BigInt(decimals) !== BigInt(String(m.burnUnits))) return refuse;
    }
    return '';
  }

  function membershipSection(ctx, cfg, addr, standing, allow, panel) {
    const { h, notice } = ctx;
    const m = standing.membership;
    const app = inApp();
    const wrap = h('div', { class: 'data-membership' });
    const burnTokens = Number(m.burnTokens);
    const burnLabel = (Number.isFinite(burnTokens) ? fmtTokens(burnTokens) : String(m.burnTokens || '')) + ' OTT';
    const welcome = m.welcome || {};
    const welcomeText = Number(welcome.gb) + ' GB, ' + Number(welcome.days) + '-day plan up to ' + fmtPrice(Number(welcome.maxUsd));
    const cap = Number(m.capMultiple);
    const capText = cap > 0 ? 'no member gets more than ' + cap + '× the average share' : 'shares are capped';
    const shortAddress = addr.slice(0, 6) + '…' + addr.slice(-4);
    const walletRequest = (args) => (window.OTTWallet || window.ethereum).request(args);
    const stillHere = (generation) => panel.isConnected && (!ctx.isCurrent || ctx.isCurrent())
      && currentAccount(ctx)?.toLowerCase() === addr && generation === walletGeneration;
    // put() appends a state's parts and skips the empty slots. DOM append() would print a null as
    // the word "null"; h() already skips them.
    const put = (...nodes) => wrap.append(...nodes.flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false));
    // Every state shares one frame: a kicker, a status pill and a title. `tone` colours the pill,
    // and the state name lets the stylesheet change the card's rim.
    const frame = (state, kicker, pill, tone, title) => {
      wrap.className = 'data-membership data-membership--' + state;
      put(h('div', { class: 'data-membership-head' },
        h('span', { class: 'data-membership-kicker' }, kicker),
        pill ? h('span', { class: 'data-membership-pill data-membership-pill--' + tone },
          tone === 'busy' ? h('span', { class: 'data-membership-spinner', 'aria-hidden': 'true' }) : null, pill) : null),
      h('h3', { class: 'data-membership-title' }, title));
    };
    const shareLine = () => h('p', { class: 'data-membership-share' }, m.sharing === true
      ? 'You’re in this week’s split. Weekly credit follows the OTT you held at Monday’s snapshot, and ' + capText + '.'
      : 'Your weekly share starts at the next Monday snapshot. It follows the OTT you hold then, and ' + capText + '.');
    const say = (status, text, error) => { if (status.isConnected) { status.textContent = text; status.classList.toggle('err', !!error); } };

    function paint() {
      clear(wrap);
      const burn = knownBurn(addr);
      if (m.member === true || burn) {
        if (m.welcomeOrder) paintMember(); else paintWelcome(burn);
      } else if (pendingBurns.has(addr)) paintPending(pendingBurns.get(addr));
      else if (m.enrolment && m.enrolment.open === true) paintJoin();
      else paintClosed();
    }

    function paintClosed() {
      const reason = m.enrolment && typeof m.enrolment.reason === 'string' && m.enrolment.reason.trim() ? m.enrolment.reason.trim() : 'Try again later.';
      frame('closed', 'OT+T membership', 'Joining closed', 'muted', 'Join OT+T');
      put(h('p', { class: 'data-membership-lede' }, 'Members burn ' + burnLabel + ' once, claim a welcome eSIM and share each week’s data budget.'),
        h('p', { class: 'data-membership-closed', role: 'status' }, h('strong', {}, 'Joining is closed right now. '), reason));
    }

    function paintJoin(problem) {
      const join = h('button', { class: 'btn btn-primary', onclick: () => paintConfirm() }, 'Join: burn ' + burnLabel);
      join.disabled = !walletAvailable();
      frame('join', 'OT+T membership', 'Joining open', 'open', 'Join OT+T');
      put(h('p', { class: 'data-membership-lede' }, 'Burn ' + burnLabel + ' once to become a member. Membership includes:'),
        h('ul', { class: 'data-membership-list' },
          h('li', {}, h('strong', {}, 'A welcome eSIM: '), 'any ' + welcomeText + '. The reserve pays for it, so it doesn’t use weekly credit.'),
          h('li', {}, h('strong', {}, 'A weekly share of trading fees '), 'as data credit, from the next Monday snapshot. Shares follow the OTT you hold, and ' + capText + '.')),
        h('p', { class: 'data-membership-fine' }, 'The burn sends ' + burnLabel + ' from this wallet to the burn address. It can’t be undone or refunded.'),
        problem ? notice(problem, 'error') : null,
        h('div', { class: 'data-actions' }, join),
        walletAvailable() ? null : notice('Joining needs a wallet that can send a transaction.', 'plain'));
    }

    function paintConfirm() {
      clear(wrap);
      const status = h('p', { class: 'hint', role: 'status' }, '');
      const agree = h('input', { type: 'checkbox', id: 'f-burn-confirm' });
      const burn = h('button', { class: 'btn btn-primary', onclick: () => doBurn(status, [burn, cancel, agree]) }, 'Burn ' + burnLabel);
      const cancel = h('button', { class: 'btn btn-ghost', onclick: () => paint() }, 'Cancel');
      burn.disabled = true;
      agree.addEventListener('change', () => { burn.disabled = !agree.checked; });
      frame('confirm', 'Confirm the burn', 'Permanent', 'warn', 'Burn ' + burnLabel + '?');
      put(h('div', { class: 'data-burn-warning' },
          h('p', {}, 'This sends ' + burnLabel + ' from ' + shortAddress + ' to the burn address:', h('code', { class: 'data-burn-address' }, m.burnAddress)),
          h('p', { class: 'data-burn-final' }, h('strong', {}, 'Burned tokens are gone for good. This can’t be undone or refunded.')),
          h('p', {}, 'If this wallet has already burned, don’t burn again. Your membership appears after the next ledger update.')),
        h('label', { class: 'data-burn-agree', for: 'f-burn-confirm' }, agree, h('span', {}, 'I understand the burn is permanent and can’t be refunded.')),
        h('div', { class: 'data-actions' }, burn, cancel), status);
      agree.focus();
    }

    async function doBurn(status, controls) {
      const generation = walletGeneration;
      const lock = (on) => controls.forEach((control) => { if (control.isConnected) control.disabled = on; });
      lock(true);
      let sent = null;
      try {
        if (!walletAvailable()) throw new Error('No wallet found to send the burn.');
        if (window.OTTWallet?.state().chain === 'solana') throw new Error('Joining needs your Robinhood Chain OTT wallet.');
        if (!isAddress(m.coin)) throw new Error('The coin address is not available. Reload and try again.');
        const mismatch = publishedBurnMismatch(cfg, m, allow);
        if (mismatch) throw new Error(mismatch);
        const data = burnCalldata(m.burnAddress, m.burnUnits);
        say(status, 'Checking your wallet…');
        await window.OTTEnsureChain?.();
        if (generation !== walletGeneration) throw new Error('Your wallet connection changed. Review your refreshed account and try again.');
        if (!stillHere(generation)) return;
        const earlier = await findBurn(ctx, m, addr, allow);
        if (!stillHere(generation)) return;
        if (earlier) {
          rememberBurn(addr, earlier);
          ctx.toast?.('Membership found', 'This wallet has already burned ' + burnLabel + '. Claim your welcome eSIM.', 'success');
          repaintFrom(ctx, cfg, addr, allow, standing, panel);
          return;
        }
        const raw = await ctx.rpc('eth_call', [{ to: m.coin, data: SEL.balanceOf + word32(addr) }, 'latest']);
        if (!stillHere(generation)) return;
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(String(raw))) throw new Error('Your OTT balance could not be read. Try again in a moment.');
        const balance = BigInt(raw);
        const units = BigInt(String(m.burnUnits));
        if (balance < units) {
          const held = Number.isFinite(burnTokens) ? Number(balance) * burnTokens / Number(units) : NaN;
          say(status, 'This wallet holds ' + (Number.isFinite(held) ? fmtTokens(Math.floor(held * 100) / 100) + ' OTT' : 'less than ' + burnLabel) + '. Joining burns ' + burnLabel + '.', true);
          controls.slice(1).forEach((control) => { if (control.isConnected) control.disabled = false; });
          return;
        }
        say(status, 'Approve the burn in your wallet. It sends ' + burnLabel + ' to the burn address.');
        const hash = await walletRequest({ method: 'eth_sendTransaction', params: [{ from: addr, to: m.coin, data, value: '0x0' }] });
        if (!isTxHash(hash)) throw new Error('The wallet did not return a transaction hash. Check your wallet before trying again.');
        sent = hash.toLowerCase();
        // Recorded before anything else can fail, so this page never offers a second burn for it.
        pendingBurns.set(addr, sent);
        if (!stillHere(generation)) return;
        await settleBurn(sent, status);
      } catch (e) {
        if (!panel.isConnected || ctx.isCurrent && !ctx.isCurrent() || currentAccount(ctx)?.toLowerCase() !== addr) return;
        if (sent) { paintPending(sent, 'The burn was sent, but its status could not be checked. Don’t burn again: check its status in a moment.'); return; }
        const rejected = e && (e.code === 4001 || /reject|denied|cancel/i.test(errText(e)));
        say(status, rejected ? 'The burn wasn’t approved. Nothing was sent.' : 'Could not burn: ' + errText(e), true);
        lock(false);
        const agree = controls[2];
        const burn = controls[0];
        if (agree && burn && burn.isConnected) burn.disabled = !agree.checked;
      }
    }

    async function settleBurn(hash, status) {
      const generation = walletGeneration;
      say(status, 'Waiting for the burn to confirm on Robinhood Chain…');
      const receipt = await waitForReceipt(ctx, hash, () => stillHere(generation));
      if (!stillHere(generation)) return;
      if (!receipt) { paintPending(hash, 'The burn hasn’t confirmed yet. Don’t burn again: check its status in a moment.'); return; }
      pendingBurns.delete(addr);
      if (String(receipt.status).toLowerCase() !== '0x1') {
        clear(wrap);
        paintJoin('The burn transaction failed on chain, so no OTT was burned. You can try again.');
        return;
      }
      rememberBurn(addr, hash);
      ctx.toast?.('Membership confirmed', 'Your burn is on chain. Now claim your welcome eSIM.', 'success');
      repaintFrom(ctx, cfg, addr, allow, standing, panel);
    }

    function paintPending(hash, message) {
      clear(wrap);
      const status = h('p', { class: 'hint', role: 'status' }, message || 'Your burn was sent and is waiting to confirm. Don’t burn again.');
      const check = h('button', { class: 'btn btn-primary', onclick: async () => {
        check.disabled = true;
        try { await settleBurn(hash, status); } finally { if (check.isConnected) check.disabled = false; }
      } }, 'Check burn status');
      frame('pending', 'OT+T membership', 'Confirming', 'busy', 'Your burn is confirming');
      put(h('p', { class: 'data-burn-tx' }, 'Transaction ' + hash),
        h('div', { class: 'data-actions' }, check), status);
    }

    function paintMember() {
      unconfirmedWelcome.delete(addr);
      frame('member', 'OT+T membership', m.sharing === true ? 'In this week’s split' : 'Member', 'open', 'You’re a member');
      put(h('p', { class: 'data-membership-lede' }, m.welcomeOrder.pending ? 'Your welcome eSIM is being issued. It’s listed with your eSIMs below.' : 'Your welcome eSIM is listed with your eSIMs below.'),
        shareLine());
    }

    function paintWelcome(burnTx) {
      const eligible = packagesOf(cfg).filter((p) => welcomeEligible(p, m.welcome)).sort((a, b) => a.name.localeCompare(b.name));
      frame('welcome', 'Welcome eSIM', 'Member', 'open', 'Claim your welcome eSIM');
      put(h('p', { class: 'data-membership-lede' }, 'You’re a member. Pick any ' + welcomeText + '. The reserve pays for it, so it doesn’t use your weekly credit.'),
        shareLine());
      if (!eligible.length) { put(notice('No welcome plans are in the catalogue right now. Try again later.', 'warn')); return; }
      const select = h('select', { id: 'f-welcome-plan' }, eligible.map((p) => h('option', { value: p.code }, p.name + ' · ' + fmtPrice(p.priceUsd))));
      const pendingCode = unconfirmedWelcome.get(addr);
      if (pendingCode && eligible.some((p) => p.code === pendingCode)) select.value = pendingCode;
      else if (eligible.some((p) => p.code === selectedPackageCode)) select.value = selectedPackageCode;
      const btn = h('button', { class: 'btn btn-primary btn-block', onclick: () => doClaim() }, 'Claim');
      const hint = h('p', { class: 'hint', role: 'status' }, '');
      const result = h('div', {});
      // The order tracker only appears once a claim is under way; before that it would be a row of
      // empty steps under a card that already says what to do.
      let progress = app ? orderProgress(ctx, 0) : null;
      if (progress) progress.hidden = true;
      const picked = () => eligible.find((p) => p.code === select.value) || null;
      const paintButton = () => {
        const p = picked();
        btn.textContent = p ? 'Claim ' + p.name + ' · ' + (Number(p.gb) || 1) + ' GB — ' + fmtPrice(p.priceUsd) : 'Claim';
      };
      const setProgress = (phase, order) => {
        if (!app || !progress) return;
        const next = orderProgress(ctx, phase, order);
        next.hidden = phase === 0;
        progress.replaceWith(next);
        progress = next;
      };
      select.addEventListener('change', paintButton);
      paintButton();
      put(h('div', { class: 'field data-welcome-field' }, h('label', { for: 'f-welcome-plan' }, 'Welcome plan'), select), btn, hint, progress, result);
      if (!walletAvailable()) put(notice('Claiming needs a wallet that can sign a message.', 'plain'));
      if (pendingCode) paintRecovery();

      function paintRecovery() {
        clear(result);
        setProgress(2);
        btn.disabled = true;
        select.disabled = true;
        const status = h('p', { role: 'status' }, 'The claim result is unconfirmed. Your membership is safe. Check your eSIMs before trying again.');
        const check = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => paintMine(ctx, cfg, allow, panel) }, 'Check my eSIMs');
        const retry = h('button', { type: 'button', class: 'btn', onclick: () => doClaim() }, 'Retry same plan');
        result.appendChild(h('div', { class: 'notice warn data-order-recovery' }, status, h('div', { class: 'data-actions data-recovery-actions' }, check, retry)));
      }

      async function doClaim() {
        const pkg = picked();
        if (!pkg) return;
        if (!walletAvailable()) { hint.textContent = 'No wallet found to sign with.'; hint.classList.add('err'); return; }
        const generation = walletGeneration;
        btn.disabled = true;
        select.disabled = true;
        hint.textContent = ''; hint.classList.remove('err');
        clear(result);
        result.appendChild(notice('Approve the claim in your wallet — it names the plan and costs nothing to sign.', 'plain'));
        setProgress(1);
        let submitted = false;
        try {
          const { message, signature } = await signIn(addr, { action: 'welcome', packageCode: pkg.code }, ctx);
          if (!stillHere(generation)) return;
          clear(result);
          setProgress(2);
          result.appendChild(notice('Ordering your welcome eSIM… the reserve pays our network partner over Lightning; usually ten to twenty seconds.', 'plain'));
          submitted = true;
          unconfirmedWelcome.set(addr, pkg.code);
          const request = { address: addr, message, signature, welcome: true, packageCode: pkg.code };
          if (m.member !== true && burnTx) request.burnTx = burnTx;
          const out = await api('POST', './api/redeem', request);
          if (!out.order || ![pkg.code, pkg.packageCode].includes(out.order.packageCode)) throw new Error('The claim response could not be confirmed.');
          unconfirmedWelcome.delete(addr);
          if (!stillHere(generation)) return;
          ctx.toast?.(out.order.pending ? 'Welcome eSIM ordered' : 'Welcome eSIM ready', packageLabel(pkg), 'success');
          const fresh = Object.assign({}, standing, {
            membership: Object.assign({}, m, { member: true, welcomeOrder: out.order }),
            sims: out.sims || standing.sims || [],
          });
          repaintFrom(ctx, cfg, addr, allow, fresh, panel, Object.assign({ welcome: true }, out.order));
        } catch (e) {
          if (!panel.isConnected || ctx.isCurrent && !ctx.isCurrent() || currentAccount(ctx)?.toLowerCase() !== addr) return;
          const msg = errText(e);
          if (submitted && !e.requestDeclined) { paintRecovery(); return; }
          unconfirmedWelcome.delete(addr);
          setProgress(0);
          if (/already been claimed/i.test(msg)) {
            ctx.toast?.('Welcome eSIM already claimed', msg, 'error');
            paintMine(ctx, cfg, allow, panel);
            return;
          }
          if (/burn transaction|did not burn enough|to join first/i.test(msg) && m.member !== true) {
            forgetBurn(addr);
            ctx.toast?.('Membership not confirmed', msg, 'error');
            repaintFrom(ctx, cfg, addr, allow, standing, panel);
            return;
          }
          clear(result);
          result.appendChild(notice('Could not claim: ' + msg, 'error'));
          btn.disabled = false;
          select.disabled = false;
        }
      }
    }

    paint();
    return wrap;
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
        h('div', { class: 'dh-sub' }, 'Data credit, not cash. '
          + (d.capMultiple > 0 ? 'Follows your holdings, capped at ' + d.capMultiple + '× the average member share. ' : '')
          + (inGb(cfg, d.allowanceUsd) || 'Compare packages below.'))));

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
    const runKey = submissionKey(addr, Number(standing.week));
    let busy = !!unconfirmedOrders.get(runKey);
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
        ? 'The provider will top up a compatible eSIM for ' + name + ' where possible, or issue a new eSIM.'
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
      const attempt = unconfirmedOrders.get(runKey);
      const code = attempt?.packageCode || (preferred ? preferred.code : (here.length ? here[0].code : ''));
      if (busy) {
        packageInput.value = code;
        for (const control of sizes.children) { control.disabled = true; control.classList.toggle('active', control.dataset.code === code); }
        paintButton();
      } else selectSize(code);
    }
    placeSelect.addEventListener('change', paintSizes);
    const selected = packageByCode(cfg, selectedPackageCode);
    const pendingPackage = packageByCode(cfg, unconfirmedOrders.get(runKey)?.packageCode);
    if (pendingPackage || selected) placeSelect.value = (pendingPackage || selected).slug;
    paintSizes();
    if (busy) { placeSelect.disabled = true; paintRecovery(); }

    function paintRecovery(message = 'The order result is unconfirmed. Check the existing order before trying again.') {
      clear(result);
      setProgress(2, { unconfirmed: true });
      if (progress) {
        progress.dataset.phase = 'checking';
        progress.querySelector('[data-step="issuing"] span:last-child').textContent = 'Check order';
        progress.querySelector('.data-order-progress-note').textContent = 'Checking the existing order. No new purchase is being made.';
      }
      const status = h('p', { role: 'status' }, message);
      const check = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
        check.disabled = true;
        try {
          const fresh = await api('GET', './api/redeem?address=' + addr);
          if (!panel.isConnected || ctx.isCurrent && !ctx.isCurrent() || currentAccount(ctx)?.toLowerCase() !== addr) return;
          if (String(fresh.address || '').toLowerCase() !== addr) throw new Error('The account response belongs to another wallet.');
          const attempt = unconfirmedOrders.get(runKey);
          if (attempt && submissionSeen(fresh, attempt)) {
            unconfirmedOrders.delete(runKey);
            repaintFrom(ctx, cfg, addr, allow, fresh, panel);
            panel.querySelector('.data-reveal')?.focus();
            return;
          }
          status.textContent = 'No accepted order is visible yet. Check again in a moment. A retry keeps the same package and order; your wallet will approve it again.';
          const retry = h('button', { type: 'button', class: 'btn', onclick: () => doRedeem(true) }, 'Retry same order');
          retry.disabled = !attempt || attempt.week !== weekOf(Math.floor(Date.now() / 1000));
          result.querySelector('.data-recovery-actions').replaceChildren(check, retry);
        } catch {
          if (status.isConnected) status.textContent = 'The order status could not be checked. Keep this order and try the check again when your connection returns.';
        } finally { if (check.isConnected) check.disabled = false; }
      } }, 'Check existing order');
      result.appendChild(h('div', { class: 'notice warn data-order-recovery' }, status,
        h('div', { class: 'data-actions data-recovery-actions' }, check)));
    }

    async function doRedeem(retrySame = false) {
      if (busy && !retrySame) return;
      const pkg = picked();
      if (!pkg) return;
      const original = unconfirmedOrders.get(runKey);
      if (retrySame && (!original || original.packageCode !== pkg.code || original.week !== weekOf(Math.floor(Date.now() / 1000)))) return;
      if (!walletAvailable()) { hint.textContent = 'No wallet found to sign with.'; hint.classList.add('err'); return; }
      hint.textContent = ''; hint.classList.remove('err');
      busy = true;
      btn.disabled = true;
      placeSelect.disabled = true;
      for (const control of sizes.children) control.disabled = true;
      clear(result);
      // n names the slot this redeem means to fill — the count of orders the panel was painted
      // from — so a picture that has gone stale is refused rather than risking two eSIMs for one
      // balance. It is settled before the signature because the signature names it: what the
      // holder approves in their wallet is this plan, in this slot, and nothing else.
      const n = retrySame ? original.n : (standing.orders || []).length;
      let submitted = false;
      // A redemption always prompts — its signature is spent on this one order and never reused.
      result.appendChild(notice('Approve the order in your wallet — it names the plan and costs nothing to sign.', 'plain'));
      setProgress(1);
      try {
        const { message, signature } = await signIn(addr, { action: 'redeem', packageCode: pkg.code, n }, ctx);
        if (!panel.isConnected || ctx.isCurrent && !ctx.isCurrent() || currentAccount(ctx)?.toLowerCase() !== addr) return;
        clear(result);
        setProgress(2);
        result.appendChild(notice('Ordering your eSIM… the pool pays our network partner over Lightning and waits for the profile; usually ten to twenty seconds.', 'plain'));
        submitted = true;
        unconfirmedOrders.set(runKey, { week: Number(standing.week), n, packageCode: pkg.code });
        const out = await api('POST', './api/redeem', { address: addr, message, signature, packageCode: pkg.code, n });
        if (!out.order || out.order.packageCode !== pkg.code) throw new Error('The order response could not be confirmed.');
        unconfirmedOrders.delete(runKey);
        if (!panel.isConnected || ctx.isCurrent && !ctx.isCurrent() || currentAccount(ctx)?.toLowerCase() !== addr) return;
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
        if (!panel.isConnected || ctx.isCurrent && !ctx.isCurrent() || currentAccount(ctx)?.toLowerCase() !== addr) return;
        const msg = errText(e);
        if ((submitted && !e.requestDeclined) || (retrySame && !submitted)) {
          busy = true;
          paintRecovery(retrySame && !submitted ? 'The retry was not approved. The earlier order is still unconfirmed; check it before trying again.' : undefined);
          return;
        }
        unconfirmedOrders.delete(runKey);
        busy = false;
        placeSelect.disabled = false;
        for (const control of sizes.children) control.disabled = false;
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
    const welcomeOrder = welcomeBundleOf(standing);
    const hasAny = ((standing.orders || []).length + (standing.history || []).length + (standing.sims || []).length + (welcomeOrder ? 1 : 0)) > 0;
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
        const { message, signature } = await signIn(addr, undefined, ctx);
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
    if (inApp() && ([...standing.orders || [], ...standing.history || [], ...(welcomeOrder ? [welcomeOrder] : [])].some((order) => order.pending) || groups.some((group) => group.sim?.codes === true && !hasInstallDetails(group.sim)))) {
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
    const welcome = welcomeBundleOf(standing);
    const bundles = (standing.orders || []).map((o) => Object.assign({ fromHistory: false }, o))
      .concat((standing.history || []).map((o) => Object.assign({ fromHistory: true }, o)))
      .concat(welcome ? [welcome] : []);
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

  // The welcome order files under its eSIM like any bundle. It belongs to no week, so it is marked
  // rather than given one, and it is never history.
  function welcomeBundleOf(standing) {
    const order = standing && standing.membership && standing.membership.configured === true ? standing.membership.welcomeOrder : null;
    return order && typeof order === 'object' ? Object.assign({ fromHistory: false }, order, { welcome: true, week: null }) : null;
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

    // Prefer encoding the supplied activation code here. No remote image request is needed.
    let qrSrc = '';
    if (activation && window.WhateverQr) {
      try { qrSrc = window.WhateverQr.svg(activation); } catch (e) { qrSrc = ''; }
    }
    if (!qrSrc) qrSrc = safeInstallImage(sim.qrCodeUrl);
    const appleInstallUrl = safeInstallHref(sim.appleInstallUrl);
    const androidInstallUrl = safeInstallHref(sim.androidInstallUrl);
    const install = [
      appleInstallUrl ? h('a', { class: 'btn btn-sm', href: appleInstallUrl, target: '_blank', rel: 'noopener' }, 'Install on iPhone') : null,
      androidInstallUrl ? h('a', { class: 'btn btn-sm', href: androidInstallUrl, target: '_blank', rel: 'noopener' }, 'Install on Android') : null,
    ].filter(Boolean);
    let setup = null;
    const topup = inApp() && sim.slug && window.OTTMobileApp?.reviewDestination
      ? h('button', { class: 'btn btn-sm data-topup', onclick: event => window.OTTMobileApp.reviewDestination(ctx, cfg, sim.slug, event.currentTarget) }, 'Review more data for ' + placeName) : null;
    const allBundlesPending = bundles.length > 0 && bundles.every((order) => order.pending);
    if (inApp() && !allBundlesPending && hasInstallDetails(sim) && typeof window.OTTMobileApp?.openSetup === 'function') {
      setup = h('button', { class: 'btn btn-primary data-setup', onclick: () => window.OTTMobileApp.openSetup(ctx, sim, setup, placeName) }, 'Set up this eSIM');
    }

    return h('div', { class: 'card-quiet data-sim' + (mintedByFresh ? ' fresh' : '') },
      h('div', { class: 'data-sim-head' },
        h('span', { class: 'cc-sym' }, title),
        sim.iccid ? h('span', { class: 'small mono' }, 'ICCID ' + sim.iccid) : null),
      setup,
      topup,
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
        o.welcome ? h('span', { class: 'badge data-welcome-badge' }, 'WELCOME') : null,
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
    // Pure membership helpers, shared with tests that hold them to the API's own rules.
    burnCalldata, welcomeEligible, publishedBurnMismatch,
    resetWallet: () => { walletGeneration++; lastAccount = null; lastRead = null; },
    selectPackage: (code) => { selectedPackageCode = String(code || ''); },
    // Shared with site/status.js, the same way SEL already is, so the two files cannot silently
    // disagree about how a token amount, a share or a week is read.
    unitsFromDecimalStr, fmtTokens, fmtSharePct, weekOf, weekStartOf, weekEndOf,
  };
})();
