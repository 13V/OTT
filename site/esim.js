'use strict';
/**
 * OT+T — the home route (#/): a carrier landing page, not a config dump.
 *
 * One coin on Pons carries a creator tax, and that tax goes to a treasury. What the treasury buys
 * with it is mobile data: every week, the tax the coin collected LAST week becomes THIS week's data
 * budget, and a wallet's allowance is its share of the circulating supply times that budget —
 * allowanceUsd = (tokens ÷ circulating) × budgetUsd — banked as dollars of data credit and spent on
 * eSIMs from nadanada, in 1, 5 or 10 GB sizes across a few dozen places, paid for over Lightning.
 * Holding is the whole mechanism: there is no claim to file and no trade to make. The allowance
 * expires at the end of the week it was published for — use it or lose it, which is what keeps the
 * promise affordable, since the pool never owes more than one week of tax it has already collected.
 * A gigabyte's price depends on where you buy it and how much of it you buy at once — a 10 GB
 * package is a far better per-gigabyte deal than a 1 GB one — so credit is banked in dollars rather
 * than gigabytes, and the page says so instead of hiding it in a unit. The accounting is done off
 * chain by scripts/allowances.js, which writes site/data/allowances.json once a week's tax is
 * known; the handing out of a profile is done by /api/redeem, because it costs money and needs a
 * secret. This file is the page between the two.
 *
 * The page reads top to bottom the way a carrier's does: a hero with the offer, a row of checkable
 * facts, the plan catalogue with a place picker (the actual product), how holding turns into an
 * eSIM, the full coverage list, the visitor's own wallet — what it holds and what that buys this
 * week, which is the one screen a holder actually lives on — and last, as supporting detail rather
 * than the headline, the programme's own chain numbers. Every section but the wallet panel and the
 * live numbers reads from config/esim.json alone, so the page is not empty before the coin launches;
 * only the wallet panel and the chain numbers need a launched coin.
 *
 * It is a route module in the same sense site/launch.js is a signing module: app.js owns the
 * router, the RPC rotation, the wallet flow and the DOM helper, and hands them in as `ctx` — so
 * nothing here is a second copy of something app.js already does, and the file can be read on its
 * own. It exposes exactly one global, window.WhateverData, with one method: render(view, ctx). A
 * second global, window.WhateverQr (site/qr.js), draws the activation QR for the rare eSIM whose
 * qrCodeUrl came back empty; this file calls it defensively and does not depend on it being loaded.
 *
 * Everything this page needs is loaded when the page is opened and never at boot — config/esim.json
 * and data/allowances.json are both allowed to be missing, and a missing file here must cost this
 * route its numbers and no other route anything. Every failure path is a notice in the page; the
 * only thing that throws is a bug.
 *
 * v1 is deliberately narrow: pre-graduation only, and USDG-paired only. The tax the budget is built
 * from is read off the curve's own fee escrow in USDG; a coin paired to native ETH collects its tax
 * in ETH instead, so v1 cannot price a dollar budget from it, and the page says so rather than
 * guessing. Once a coin graduates, trading moves off the curve entirely, so no further tax accrues
 * against it — a graduated coin's holders keep whatever budget is already funded, and nothing after.
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
  const MESSAGE_HEAD = 'OT+T data';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const USDG_DECIMALS = 6;
  const LAUNCHPAD_URL = 'https://whatever-fun.vercel.app/#/new';

  // ============================================================================ small helpers
  const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
  // The carrier brand, when the config carries one. Every string built from it falls back to the
  // pre-brand wording when this is null, so a fork that has not set cfg.brand renders exactly as
  // the page did before the brand existed.
  const brandOf = (cfg) => (cfg && cfg.brand) || null;
  const pad = (hex) => String(hex).replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '—');
  // Money here is a treasury balance, not a price, so it always carries its cents: "$1,234.50"
  // reads as a balance and "$1,234.5" reads as a typo.
  const fmtMoney = (n) => (Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  // Gigabytes are banked as fractions and redeemed as wholes, so a balance shows two decimals and
  // the number of packages it buys is the integer part.
  const fmtGb = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' GB' : '—');
  const fmtPct = (bps) => (Number.isFinite(bps) ? (bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%' : '—');
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
  const cheapestEntry = (cfg) => packagesOf(cfg).reduce((m, p) => (m && m.priceUsd <= p.priceUsd ? m : p), null);
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
  // "1, 5 and 10 GB" (or "…or 10 GB" mid-sentence) — the sizes actually in the catalogue, joined
  // the way a sentence would rather than assumed, so a catalogue with a fourth size still reads
  // right without this file changing.
  function gbSizesText(cfg, joiner) {
    const sizes = Array.from(new Set(packagesOf(cfg).map((p) => Number(p.gb)).filter((n) => n > 0))).sort((a, b) => a - b);
    if (!sizes.length) return '';
    if (sizes.length === 1) return String(sizes[0]);
    return sizes.slice(0, -1).join(', ') + ' ' + joiner + ' ' + sizes[sizes.length - 1];
  }
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
  const units = (big, decimals) => Number(big) / Math.pow(10, decimals);
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const errText = (e) => (e && e.message ? e.message : String(e)).slice(0, 200);

  // The bytes of a UTF-8 string as 0x-hex, which is what personal_sign wants in params[0]. A
  // wallet handed the plain string would sign it too, but some hex-decode anything that looks like
  // hex and sign the wrong bytes; the encoded form is unambiguous.
  function hexOfUtf8(text) {
    const bytes = new TextEncoder().encode(text);
    let out = '0x';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
  }

  // The sign-in line /api/redeem checks, built here and nowhere else so the two cannot drift: the
  // header, the lowercase address, and the moment, each on its own line.
  const signInMessage = (address) => MESSAGE_HEAD + '\n' + address.toLowerCase() + '\n' + Math.floor(Date.now() / 1000);

  // A signed call proves who is asking, and one signature can stand for several of them in a row —
  // a redeem and the read that follows it, or a later "show my codes" — so the last one made is
  // kept here and reused while it is still fresh, rather than asking the wallet to sign again for
  // every call that needs one. The API's own window is ten minutes; reusing within eight leaves
  // margin for the request itself to land before it expires.
  const SIGNIN_REUSE_MS = 8 * 60 * 1000;
  let lastSignIn = null; // { addr, message, signature, at }
  const signInIsFresh = (addr) => !!(lastSignIn && lastSignIn.addr === addr && Date.now() - lastSignIn.at < SIGNIN_REUSE_MS);
  async function signIn(addr) {
    if (signInIsFresh(addr)) return { message: lastSignIn.message, signature: lastSignIn.signature };
    const message = signInMessage(addr);
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [hexOfUtf8(message), addr] });
    lastSignIn = { addr, message, signature, at: Date.now() };
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
    const res = await fetch(path, {
      method, headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
    });
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!j) throw new Error('redeem API answered HTTP ' + res.status);
    if (!j.ok) throw new Error(j.error || 'redeem API refused (HTTP ' + res.status + ')');
    return j;
  }

  // ============================================================================ chain reads
  /**
   * Everything the page shows from the chain, in one batch where app.js offers one and one call
   * each where it does not. A read that fails is null and its tile shows a dash; a page that
   * cannot show the treasury can still show the rules and the wallet's own balance.
   */
  async function readChain(ctx, cfg) {
    const usdg = ((ctx.cfg && ctx.cfg.usdg) || cfg.pair || '').toLowerCase();
    const escrow = ctx.cfg && ctx.cfg.pons && ctx.cfg.pons.feeEscrow;
    const calls = [
      { key: 'treasury', to: escrow, data: SEL.balanceOfToken + pad(cfg.treasury) + pad(usdg) },
      { key: 'raised', to: cfg.curve, data: SEL.realQuoteReserve },
      { key: 'threshold', to: cfg.curve, data: SEL.graduationThreshold },
      { key: 'graduated', to: cfg.curve, data: SEL.graduated },
      { key: 'taxBps', to: cfg.curve, data: SEL.creatorTaxBps },
      { key: 'taxHeld', to: cfg.curve, data: SEL.creatorTaxBalance },
    ].filter((c) => isAddress(c.to));
    let answers;
    if (typeof ctx.rpcBatch === 'function') {
      answers = await ctx.rpcBatch(calls.map((c) => ({ method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] })));
    } else {
      answers = await Promise.all(calls.map((c) => ctx.callRaw(c.to, c.data).catch(() => null)));
    }
    const out = {};
    calls.forEach((c, i) => {
      const hex = answers[i];
      out[c.key] = hex && hex.length >= 66 ? word(hex, 0) : null;
    });
    return {
      treasuryUsd: out.treasury === null || out.treasury === undefined ? null : units(out.treasury, USDG_DECIMALS),
      raisedUsd: out.raised == null ? null : units(out.raised, USDG_DECIMALS),
      thresholdUsd: out.threshold == null ? null : units(out.threshold, USDG_DECIMALS),
      graduated: out.graduated == null ? null : out.graduated !== 0n,
      taxBps: out.taxBps == null ? null : Number(out.taxBps),
      taxHeldUsd: out.taxHeld == null ? null : units(out.taxHeld, USDG_DECIMALS),
    };
  }

  // ============================================================================ the page
  /**
   * Seven bands, top to bottom: hero, trust row, plans (the catalogue, with a place picker), how it
   * works, coverage, the visitor's own wallet, and last the programme's own chain numbers. Every
   * band up through coverage reads config/esim.json alone, so it renders in full before the coin
   * has launched — which is the state this page will actually be seen in first. Only the wallet
   * panel and the live numbers need a launched coin, and both are skipped for one honest card when
   * it has not.
   */
  async function render(view, ctx) {
    const { h, notice } = ctx;
    // `refresh.mine` is set once the wallet panel exists, below, so the hero's "Connect wallet"
    // button (shown when no wallet is available yet) can repaint it after a successful connect
    // without this file keeping a second copy of the wallet flow or reloading the page.
    const refresh = { mine: null };
    view.appendChild(hero(ctx, refresh));

    let cfg;
    try { cfg = await loadJson('./config/esim.json'); }
    catch (e) {
      view.appendChild(bareSection(ctx, notice('The data programme is not configured yet (config/esim.json could not be read: ' + errText(e) + ').', 'warn')));
      return;
    }
    cfg = cfg || {};
    const launched = isAddress(cfg.coin) && isAddress(cfg.curve) && isAddress(cfg.treasury);

    // This week's budget and the circulating supply, read once and handed to whichever band can
    // use them — the plan cards' "OTT to cover this" line needs them just as much as the wallet
    // panel does, and a missing or not-yet-published file costs both the same way: the figure that
    // needed it is left out rather than guessed at.
    let allow = null;
    try { allow = await loadJson('./data/allowances.json'); } catch (e) { allow = null; }

    // These three read config/esim.json (and, for the plan cards' meta line, the allowances file)
    // alone, so they render the same whether or not a coin has launched — which matters, because
    // "not launched" is the state a first-time visitor sees.
    view.appendChild(trustRow(ctx, cfg));
    view.appendChild(plansSection(ctx, cfg, allow));
    view.appendChild(howItWorks(ctx, cfg));
    view.appendChild(coverageSection(ctx, cfg));

    if (!launched) {
      view.appendChild(bareSection(ctx, notLaunched(ctx, cfg)));
      return;
    }

    const mine = h('div', { class: 'card data-mine' });
    view.appendChild(h('div', { class: 'section', id: 'your-data' }, h('div', { class: 'wrap' }, mine)));
    refresh.mine = () => paintMine(ctx, cfg, allow, mine);
    // The wallet panel and the treasury numbers do not wait for each other: a slow RPC should not
    // hold up a balance that comes from a static file, and vice versa.
    refresh.mine();

    const numbers = h('div', { class: 'col' }, notice('Reading the chain…', 'plain'));
    view.appendChild(h('div', { class: 'section', id: 'programme' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' }, h('h2', {}, 'The programme’s numbers')),
      numbers)));
    await paintNumbers(ctx, cfg, numbers);
  }

  // A section with no header of its own — used for the two single-card fallbacks (config missing,
  // not launched) so they still sit in the page's .section/.wrap rhythm instead of floating flush
  // against the viewport edge.
  function bareSection(ctx, content) {
    return ctx.h('div', { class: 'section' }, ctx.h('div', { class: 'wrap' }, content));
  }

  // ============================================================================ 1. hero
  /**
   * One headline (the offer, not the mechanism — the how belongs further down), one sub-line, and
   * two actions: the primary one either jumps to the plans a visitor with a wallet is here for, or
   * offers to connect one for a visitor who has none yet, so connecting from the hero is not a dead
   * end — `refresh.mine` (set once the wallet panel below exists) repaints it with the freshly
   * connected address instead of leaving the page to say "Connect a wallet" under a wallet that is
   * now connected.
   */
  function hero(ctx, refresh) {
    const { h } = ctx;
    const hasWallet = !!window.ethereum;
    const primary = hasWallet
      ? h('a', { class: 'btn btn-primary', href: '#plans' }, 'See the plans')
      : h('button', { class: 'btn btn-primary', onclick: async () => {
          const acc = await ctx.connect();
          if (acc && refresh.mine) refresh.mine();
          const target = document.getElementById('your-data');
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } }, 'Connect wallet');
    return h('div', { class: 'section hero' }, h('div', { class: 'wrap' },
      h('div', { class: 'hero-copy' },
        h('h1', { class: 'hero-title' }, 'Mobile data in 28 places, just for holding OTT.'),
        h('p', { class: 'hero-sub' }, 'Your share of OTT becomes a data allowance every week — spend it on an eSIM before it resets.'),
        h('div', { class: 'hero-actions' }, primary,
          h('a', { class: 'btn btn-ghost', href: '#how-it-works' }, 'How it works')))));
  }

  // ============================================================================ 2. trust row
  /**
   * Four or five short, checkable claims — not a slogan. Two are read straight off the catalogue
   * (so they can never overstate it), and the rest describe the mechanism itself. Nothing here is a
   * number this file invented; a fork with a different catalogue gets different numbers rather than
   * this file's own guess.
   */
  function trustRow(ctx, cfg) {
    const { h } = ctx;
    const plist = places(cfg);
    const cheapEntry = cheapestEntry(cfg);
    const items = [
      plist.length ? plist.length + ' places on the menu' : 'More places added as the catalogue grows',
      cheapEntry ? 'eSIMs from ' + fmtPrice(cheapEntry.priceUsd) : 'Priced per package, shown at checkout',
      'No trading required — holding is all it takes',
      'No app, no SIM swap, no contract',
      'Paid over Bitcoin Lightning — no person in the loop',
    ];
    return h('div', { class: 'section trust' }, h('div', { class: 'wrap' },
      h('div', { class: 'trust-row' }, items.map((t) => h('div', { class: 'trust-item' }, t)))));
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
  function plansSection(ctx, cfg, allow) {
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
          h('div', { class: 'plan-size' }, (Number(p.gb) || 1) + ' GB'),
          h('div', { class: 'plan-price' }, fmtPrice(p.priceUsd)),
          h('div', { class: 'plan-term' }, (Number(p.days) || 7) + ' days'),
          h('div', { class: 'plan-meta' },
            h('span', {}, p.regions || p.name),
            need !== null ? h('span', {}, 'needs ≈ ' + fmtTokens(need) + ' OTT this week') : null),
          h('a', { class: 'btn btn-sm plan-cta', href: '#your-data' }, 'Get this eSIM')));
      }
    }
    select.addEventListener('change', paint);
    paint();

    return h('div', { class: 'section', id: 'plans' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' },
        h('h2', {}, 'Data plans, priced by place'),
        h('p', { class: 'small' }, 'Pick a place — the three sizes and their prices update below.')),
      h('div', { class: 'plan-picker' }, h('label', { for: 'plan-place' }, 'Place'), select),
      grid));
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
      { title: 'Your share becomes this week’s budget',
        body: 'Every Monday, last week’s creator tax on ' + carrier + '’s trades becomes this week’s data budget, and your allowance is your share of the circulating supply times that budget — banked as dollars of credit, because a gigabyte’s price depends on where you spend it.' },
      { title: 'Redeem an eSIM and scan it',
        body: 'Spend the credit on an eSIM from nadanada: pick a place and size, sign a message to prove the wallet is yours, and scan the QR at the airport — and spend it before the week ends, because what is unused does not carry over.' },
    ];
    return h('div', { class: 'section alt', id: 'how-it-works' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' }, h('h2', {}, 'How it works')),
      h('div', { class: 'steps' }, steps.map((s, i) => h('div', { class: 'step' },
        h('div', { class: 'step-n' }, String(i + 1)),
        h('div', { class: 'step-title' }, s.title),
        h('div', { class: 'step-body' }, s.body))))));
  }

  // ============================================================================ 5. coverage
  /** Every place in the catalogue, once each, with its cheapest entry — dense on purpose, so the
   *  page proves the "28 places" claim above rather than just making it a second time. */
  function coverageSection(ctx, cfg) {
    const { h } = ctx;
    const plist = places(cfg);
    const items = plist.map((p) => {
      const cheap = packagesAt(cfg, p.slug).reduce((m, x) => (!m || x.priceUsd <= m.priceUsd ? x : m), null);
      return h('div', { class: 'cov-item' },
        h('span', { class: 'cov-flag' }, p.flag),
        h('span', { class: 'cov-name' }, p.name),
        h('span', { class: 'cov-price' }, cheap ? 'from ' + fmtPrice(cheap.priceUsd) : '—'));
    });
    return h('div', { class: 'section', id: 'coverage' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' },
        h('h2', {}, 'Coverage'),
        h('p', { class: 'small' }, plist.length ? plist.length + ' places on the menu today.' : 'Nothing configured yet.')),
      h('div', { class: 'cov-grid' }, items)));
  }

  function addrLink(ctx, a) {
    const explorer = ctx.cfg && ctx.cfg.explorer;
    return explorer ? ctx.h('a', { class: 'mono', href: explorer + '/address/' + a, target: '_blank', rel: 'noopener' }, shortAddr(a)) : ctx.h('span', { class: 'mono' }, shortAddr(a));
  }

  // Before launch day the whole page below coverage is this one card: the rules the programme will
  // run under, and the one useful button, which launches the coin. cfg.pair is the only address the
  // config carries at this point.
  function notLaunched(ctx, cfg) {
    const { h } = ctx;
    const brand = brandOf(cfg);
    const rows = h('div', { class: 'rows' });
    const row = (k, v) => rows.appendChild(h('div', { class: 'row' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)));
    const plist = places(cfg);
    const cheapEntry = cheapestEntry(cfg);
    if (brand) {
      row('Carrier', brand.name + ' · ' + brand.full);
      row('Ticker', brand.ticker);
    }
    row('Status', 'Not launched yet');
    row('Weekly budget', 'last week’s creator tax, split by every wallet’s share of the circulating supply');
    row('Packages', plist.length && cheapEntry ? plist.length + ' places · ' + gbSizesText(cfg, 'and') + ' GB · from ' + fmtPrice(cheapEntry.priceUsd) : 'none configured yet');
    row('Redeemed as', 'eSIMs from nadanada, paid by Lightning');
    row('Creator tax', fmtPct(Number(cfg.taxBps) || 0) + ' to the treasury');
    row('Paired to', cfg.pair === ZERO || !cfg.pair ? 'native ETH (tax not priced in v1)' : 'USDG');
    row('Counts', 'balances snapshotted pre-graduation only');
    return h('div', { class: 'card data-notlaunched' },
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Not launched yet')),
      h('p', { class: 'small' }, 'The coin behind this programme has not been launched. These are the rules it will run under; the addresses land in config/esim.json on launch day.'),
      rows,
      h('div', { class: 'data-actions' },
        // whatever.fun is the launchpad this coin would launch through; it is a different site now,
        // so this leaves rather than routes — a new tab, and a label that says exactly that.
        h('a', { class: 'btn btn-primary', href: LAUNCHPAD_URL, target: '_blank', rel: 'noopener' }, 'Launch the coin on whatever.fun'),
        h('a', { class: 'btn btn-ghost', href: '#/about' }, 'How this works')));
  }

  // ============================================================================ 6. your data
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
    panel.appendChild(h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Your data')));

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
      panel.appendChild(h('p', { class: 'small' }, 'Connect a wallet to see what it holds, and how much data that buys this week. The allowance is simply your share of OTT’s circulating supply — it refreshes every Monday, and does not carry over.'));
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
    const tokensStr = standing && standing.tokens !== undefined && standing.tokens !== null ? standing.tokens : (fileRow && fileRow.tokens !== undefined ? fileRow.tokens : '0');
    const tokens = unitsFromDecimalStr(tokensStr, dec);
    const shareRaw = standing && standing.share !== undefined && standing.share !== null ? standing.share : (fileRow && fileRow.share);
    const share = Number.isFinite(Number(shareRaw)) ? Number(shareRaw) : 0;
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
    const allowanceUsd = Number.isFinite(Number(allowUsdRaw)) ? Number(allowUsdRaw) : 0;
    const redeemedUsd = standing ? Number(standing.redeemedUsd) : null;
    const remainingUsd = standing ? Math.max(0, allowanceUsd - (Number.isFinite(redeemedUsd) ? redeemedUsd : 0)) : null;

    if (apiError) body.appendChild(notice('Could not reach the redeem API: ' + apiError + '. Showing what the indexer last published; redeeming needs the API back.', 'warn'));

    if (stale) {
      body.appendChild(notice('This week’s allowance has not been published yet — the numbers below are from the week that ended '
        + (fmtDate(publishedWeekEnd) || 'last week') + '. A fresh file is written every half hour.', 'plain'));
    }

    if (!(tokens > 0)) {
      body.appendChild(notice('This wallet holds no OTT, so it has no data this week.', 'plain'));
      body.appendChild(h('div', { class: 'data-actions' },
        h('a', { class: 'btn btn-primary', href: LAUNCHPAD_URL, target: '_blank', rel: 'noopener' }, 'Get OTT on whatever.fun')));
      // A wallet that now holds nothing can still have an eSIM from a week it did — simsSection
      // shows it, and quietly shows nothing when there truly is none, the same hasAny guard always
      // gated this on.
      if (standing) body.appendChild(simsSection(ctx, cfg, addr, standing, freshOrder));
      return;
    }

    body.appendChild(dashboardTiles(ctx, cfg, { tokens, share, allowanceUsd, redeemedUsd, remainingUsd, weekEnd }));

    if (!standing) {
      body.appendChild(notice('Redeeming, and this week’s past orders, need the redeem API, which could not be reached.', 'warn'));
      return;
    }

    // The SIM is the object: what this wallet already has, and what is queued on it, comes before
    // the picker that adds more — so a returning holder reads "here is your eSIM" before "buy more
    // data", not the other way around.
    body.appendChild(simsSection(ctx, cfg, addr, standing, freshOrder));
    body.appendChild(redeemForm(ctx, cfg, addr, standing, allow, panel));
  }

  // A live countdown reads at most one at a time on this single-page app, so one module-level timer
  // is all it takes; every repaint stops the previous one before it might start a new one, and the
  // interval itself gives up the moment its own tile is no longer on the page (a route change, or a
  // panel rebuilt for some other reason), so nothing here can outlive what it is updating.
  let countdownTimer = null;
  function stopCountdown() { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } }

  /**
   * The two numbers the founder asked for, first and biggest — what this wallet holds, and what
   * that buys this week, in gigabytes, because that is what a carrier shows and a dollar figure is
   * not. Then four supporting tiles: used and left in the same units as the headline, the wallet's
   * share of supply, and a live countdown to the reset. Nothing here implies a single guaranteed GB
   * figure — inGb() says what the balance is worth at the cheapest place and the dearest, the same
   * honest spread the rest of the page already shows, because a gigabyte's price depends on where
   * it is spent.
   */
  function dashboardTiles(ctx, cfg, d) {
    const { h } = ctx;
    const lo = cheapest(cfg);
    // The three figures have to reconcile on screen. Flooring each of the three dollar amounts
    // independently does not: $18.62 of allowance, $1.99 used and $16.63 left floor to 26, 2 and 23
    // at the cheapest rate, and a reader who can add up sees 26 that turns into 25 and reads it as
    // a bug. So the total and the used figure are floored, and the remainder is what is left of the
    // total after it — the one of the three nobody checks independently.
    const headlineGb = lo && Number.isFinite(d.allowanceUsd) ? Math.floor(d.allowanceUsd / perGb(lo)) : null;
    const usedGb = lo && Number.isFinite(d.redeemedUsd) ? Math.floor(d.redeemedUsd / perGb(lo)) : null;
    const leftGb = headlineGb !== null && usedGb !== null ? Math.max(0, headlineGb - usedGb)
      : (lo && Number.isFinite(d.remainingUsd) ? Math.floor(d.remainingUsd / perGb(lo)) : null);

    const headline = h('div', { class: 'data-headline' },
      h('div', { class: 'dh-tile' },
        h('div', { class: 'dh-label' }, 'OTT held'),
        h('div', { class: 'dh-value' }, fmtTokens(d.tokens) + ' OTT'),
        h('div', { class: 'dh-sub' }, fmtSharePct(d.share) + ' of the circulating supply')),
      h('div', { class: 'dh-tile' },
        h('div', { class: 'dh-label' }, 'Data this week'),
        h('div', { class: 'dh-value' }, headlineGb === null ? '—' : fmtGb(headlineGb)),
        h('div', { class: 'dh-sub' }, inGb(cfg, d.allowanceUsd) || (Number.isFinite(d.allowanceUsd) ? fmtMoney(d.allowanceUsd) + ' of credit' : 'no packages configured yet'))));

    const supporting = h('div', { class: 'stat-grid data-tiles' },
      ctx.tile('Used this week', usedGb === null ? '—' : fmtGb(usedGb),
        Number.isFinite(d.redeemedUsd) ? fmtMoney(d.redeemedUsd) + ' redeemed' : 'not known — the redeem API could not be reached', 'coins'),
      ctx.tile('Left this week', leftGb === null ? '—' : fmtGb(leftGb),
        Number.isFinite(d.remainingUsd) ? fmtMoney(d.remainingUsd) + ' left to spend' : 'not known — the redeem API could not be reached', 'arrows'),
      ctx.tile('Your share', fmtSharePct(d.share), 'of OTT’s circulating supply', 'shield'),
      liveCountdownTile(ctx, d.weekEnd));

    return h('div', {}, headline, supporting);
  }

  // The "Resets in" tile updates itself every 30 seconds without a full repaint — days-and-hours
  // granularity does not need anything finer, and this way the countdown is actually live rather
  // than frozen at whatever it read when the wallet connected.
  function liveCountdownTile(ctx, weekEndSec) {
    stopCountdown();
    const tile = ctx.tile('Resets in', fmtCountdown(weekEndSec), 'Unused data does not carry over to next week.', 'clock');
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
  function redeemForm(ctx, cfg, addr, standing, allow, panel) {
    const { h, notice } = ctx;
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
      btn, hint, result);
    if (!window.ethereum) wrap.appendChild(notice('Redeeming needs a wallet that can sign a message.', 'plain'));

    function picked() { return packageByCode(cfg, packageInput.value); }
    function paintButton() {
      const p = picked();
      if (!p) { btn.textContent = 'Redeem'; btn.disabled = true; hint.textContent = 'No packages are configured.'; return; }
      btn.textContent = 'Redeem ' + p.name + ' · ' + (Number(p.gb) || 1) + ' GB — ' + fmtPrice(p.priceUsd);
      const short = remaining + 1e-9 < p.priceUsd;
      btn.disabled = short;
      hint.textContent = short ? 'You have ' + fmtMoney(remaining) + ' left this week; this package costs ' + fmtPrice(p.priceUsd) + '.' : '';
      hint.classList.toggle('err', false);
    }
    function selectSize(code) {
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
      selectSize(here.length ? here[0].code : '');
    }
    placeSelect.addEventListener('change', paintSizes);
    paintSizes();

    async function doRedeem() {
      const pkg = picked();
      if (!pkg) return;
      if (!window.ethereum) { hint.textContent = 'No wallet found to sign with.'; hint.classList.add('err'); return; }
      hint.textContent = ''; hint.classList.remove('err');
      btn.disabled = true;
      clear(result);
      // Only worth saying when a wallet prompt is actually about to appear — a reused signature
      // costs nothing to reuse, and saying "sign" when nothing will pop up reads as a stuck page.
      if (signInIsFresh(addr)) result.appendChild(notice('Sign the message in your wallet — it proves the address, and costs nothing.', 'plain'));
      try {
        const { message, signature } = await signIn(addr);
        clear(result);
        result.appendChild(notice('Ordering your eSIM… the pool pays nadanada over Lightning and waits for the profile; usually ten to twenty seconds.', 'plain'));
        // n names the slot this redeem means to fill — the count of orders the panel was painted
        // from — so a picture that has gone stale is refused rather than risking two eSIMs for one
        // balance.
        const n = (standing.orders || []).length;
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
        if (typeof ctx.toast === 'function') ctx.toast(out.order && out.order.pending ? 'eSIM ordered' : 'eSIM ready', packageLabel(pkg), 'success');
        // The signature that just redeemed also proves who is asking, so it buys a signed read
        // too — the panel repaints with every code this wallet is now owed to see, not only the
        // one it just bought, and without a second prompt. A read that fails on its own does not
        // undo the redemption; the standing is composed locally instead, the way this worked
        // before the read existed.
        let freshStanding = null;
        try { freshStanding = await api('POST', './api/redeem', { address: addr, message, signature }); }
        catch (e) { freshStanding = null; }
        if (freshStanding) {
          repaintFrom(ctx, cfg, addr, allow, freshStanding, panel, out.order);
        } else {
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
    panel.appendChild(h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Your data')));
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
  function simsSection(ctx, cfg, addr, standing, freshOrder) {
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
      if (!window.ethereum) { hint.textContent = 'No wallet found to sign with.'; hint.classList.add('err'); return; }
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
    return h('div', { class: 'data-sims' },
      h('div', { class: 'divider' }), label, cards, actions);
  }

  /**
   * This wallet's orders and history, filed under the eSIM each actually lives on. `standing.sims`
   * is nadanada's own list of profiles, and an order's `iccid` — or, before nadanada has finished
   * issuing it, `topupOf` — says which one a bundle belongs to; both are public even before a
   * signature reveals the codes, so grouping reads the same redacted or not. A provider with no
   * notion of a standing profile (site/api/lib/providers/esimaccess.js, and any order fixture
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
      codes: !!o.codes,
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
    const sim = group.sim;
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

    const code = h('code', { class: 'mono data-ac' }, sim.ac || '—');
    const copy = h('button', { class: 'btn btn-sm', onclick: async () => {
      try { await navigator.clipboard.writeText(sim.ac || ''); copy.textContent = 'Copied'; }
      catch (e) { copy.textContent = 'Select and copy'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    } }, 'Copy');

    // nadanada usually sends a picture of the QR; when it does not, the activation code alone is
    // enough to draw the same one here — a phone only ever reads the code, never the provider's PNG.
    let qrSrc = sim.qrCodeUrl || '';
    if (!qrSrc && sim.ac && window.WhateverQr) {
      try { qrSrc = window.WhateverQr.svg(sim.ac); } catch (e) { qrSrc = ''; }
    }
    const install = [
      sim.appleInstallUrl ? h('a', { class: 'btn btn-sm', href: sim.appleInstallUrl, target: '_blank', rel: 'noopener' }, 'Install on iPhone') : null,
      sim.androidInstallUrl ? h('a', { class: 'btn btn-sm', href: sim.androidInstallUrl, target: '_blank', rel: 'noopener' }, 'Install on Android') : null,
    ].filter(Boolean);

    return h('div', { class: 'card-quiet data-sim' + (mintedByFresh ? ' fresh' : '') },
      h('div', { class: 'data-sim-head' },
        h('span', { class: 'cc-sym' }, title),
        sim.iccid ? h('span', { class: 'small mono' }, 'ICCID ' + sim.iccid) : null),
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
        : o.stage === 'paid' ? 'Paid. nadanada is issuing this bundle — open this page again in a minute.'
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

  /**
   * Is the pool funded. The Lightning wallet that pays nadanada is what actually pays for a
   * redemption, and it lives off chain where nothing here can read it directly — so it is written
   * down in public every half hour, with the rate it is being spent at and the runway that implies,
   * and shown here with one word on it. "unknown" is what a fork without that wallet configured
   * shows, and is the honest word.
   */
  function poolCard(ctx, t, cfg) {
    const { h } = ctx;
    if (!t || typeof t !== 'object') return h('div', {});
    const brand = brandOf(cfg);
    const status = String(t.status || 'unknown');
    const badgeClass = status === 'funded' ? 'badge' : status === 'low' ? 'badge badge-hold' : 'badge badge-off';
    const r = t.reseller || null;
    const balance = r && Number.isFinite(Number(r.balanceUsd)) ? Number(r.balanceUsd) : null;
    // nadanada is paid from a Lightning wallet rather than a reseller account, so its balance is
    // introduced as what it is, sats and all; anything else keeps the older "at <reseller>" line.
    const balanceSub = r && r.name === 'nadanada'
      ? 'in the Lightning wallet that pays nadanada' + (Number.isFinite(Number(r.sats)) ? ' · ' + Number(r.sats).toLocaleString('en-US') + ' sats' : '') + (r.error ? ' — could not be read' : '')
      : (r && r.name ? 'at ' + r.name + (r.error ? ' — could not be read' : '') : 'no reseller reading');
    const runwayText = t.runwayDays === null || t.runwayDays === undefined
      ? (Number(t.redemptions30d) > 0 ? '—' : 'no spend yet')
      : Number(t.runwayDays).toLocaleString('en-US') + ' days';
    const last = t.lastClaim && t.lastClaim.at ? new Date(Number(t.lastClaim.at) * 1000) : null;
    const asOf = t.asOf ? new Date(Number(t.asOf) * 1000) : null;
    return h('div', { class: 'card data-pool' },
      h('div', { class: 'card-head' },
        h('h3', { class: 'card-title' }, 'The pool'),
        h('span', { class: badgeClass }, status.toUpperCase())),
      h('div', { class: 'stat-grid data-tiles' },
        ctx.tile('Pool balance', balance === null ? '—' : fmtMoney(balance), balanceSub, 'wallet'),
        ctx.tile('Runway', runwayText, 'at the last 30 days’ rate', 'clock'),
        ctx.tile('Last 30 days', fmtMoney(Number(t.spend30dUsd) || 0), (Number(t.redemptions30d) || 0) + ' eSIM' + (Number(t.redemptions30d) === 1 ? '' : 's') + ' redeemed', 'coins'),
        ctx.tile('Last claim', last && !Number.isNaN(last.getTime()) ? last.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'none yet',
          t.lastClaim ? fmtMoney(Number(t.lastClaim.amount) || 0) + ' ' + (t.lastClaim.kind === 'eth' ? 'ETH' : 'USDG') + ' out of the escrow' : 'the escrow is swept daily', 'arrows')),
      h('p', { class: 'small', style: 'margin-top:10px' },
        brand ? 'The balance that pays for a redemption is what ' + brand.name + ' pays nadanada from; it sits in a Lightning wallet, off chain. It is read and published every half hour'
              : 'The balance that pays for a redemption sits in a Lightning wallet, off chain. It is read and published every half hour',
        asOf && !Number.isNaN(asOf.getTime()) ? ' — last at ' + asOf.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' UTC' : '',
        Number.isFinite(Number(t.walletUsd)) ? '. The treasury wallet holds ' + fmtMoney(Number(t.walletUsd)) + ' USDG waiting to be moved there.' : '.'));
  }

  // Raised against the graduation threshold. The bar is the same idiom as status.js's own curve
  // card, and --w is the fraction, so the width states exactly what the numbers beside it say.
  function progress(ctx, c) {
    const { h } = ctx;
    const frac = Number.isFinite(c.raisedUsd) && c.thresholdUsd > 0 ? Math.min(1, c.raisedUsd / c.thresholdUsd) : 0;
    const fill = h('i', {});
    fill.style.setProperty('--w', String(frac));
    return h('div', { class: 'card data-progress' },
      h('div', { class: 'card-head' },
        h('h3', { class: 'card-title' }, 'Curve progress'),
        h('span', { class: 'num' }, Number.isFinite(c.raisedUsd) && Number.isFinite(c.thresholdUsd) ? fmtMoney(c.raisedUsd) + ' of ' + fmtMoney(c.thresholdUsd) : '—')),
      h('div', { class: 'sp-bar dp-bar' }, fill),
      h('p', { class: 'small', style: 'margin-top:10px' }, Math.round(frac * 100) + '% of the way to graduation. Creator tax accrues toward a future week’s budget until then.'));
  }

  // ============================================================================ 7. the programme's numbers
  /**
   * The treasury and curve figures, painted after the wallet panel rather than beside it — this is
   * supporting detail for a holder who wants to check the mechanism, not the first thing the page
   * shows. Kept as its own async function (rather than inlined in render()) only so render() stays
   * a plain list of the seven bands in order.
   */
  async function paintNumbers(ctx, cfg, numbers) {
    const { h, notice } = ctx;
    const usdgPaired = String(cfg.pair || '').toLowerCase() === String((ctx.cfg && ctx.cfg.usdg) || '').toLowerCase();
    try {
      const c = await readChain(ctx, cfg);
      clear(numbers);
      if (!usdgPaired) {
        // No fake accounting: the budget is priced from the curve's USDG-denominated fee escrow,
        // and a native-ETH pair (pair == 0x0) or any other pair collects its tax in that asset
        // instead. Say so where the numbers would be.
        numbers.appendChild(notice('This coin is paired to ' + (cfg.pair === ZERO || !cfg.pair ? 'native ETH' : shortAddr(cfg.pair))
          + ', and v1 only prices the weekly data budget in USDG — a native-ETH pair collects its creator tax in ETH instead, so no dollar budget can be read here yet.', 'warn'));
      }
      const lo = cheapest(cfg), hi = dearest(cfg);
      const poolGb = usdgPaired && Number.isFinite(c.treasuryUsd) && lo ? Math.floor(c.treasuryUsd / perGb(lo)) : null;
      numbers.appendChild(h('div', { class: 'stat-grid page-tiles data-tiles' },
        ctx.tile('Treasury claimable', usdgPaired ? fmtMoney(c.treasuryUsd) : '—', 'USDG sitting in the fee escrow, waiting to become a future week’s budget', 'wallet'),
        ctx.tile('Unclaimed, as data', poolGb === null ? '—' : fmtGb(poolGb),
          lo ? 'at ' + fmtPrice(perGb(lo)) + '/GB (' + lo.name + ' · ' + (Number(lo.gb) || 1) + ' GB)' + (hi && hi !== lo ? ' · ' + fmtGb(Math.floor(c.treasuryUsd / perGb(hi))) + ' ' + hi.name.toLowerCase() : '') : 'no packages configured', 'coins'),
        ctx.tile('Creator tax', fmtPct(c.taxBps), c.taxHeldUsd !== null ? fmtMoney(c.taxHeldUsd) + ' still held in the curve' : 'read from the curve', 'flame')));
      numbers.appendChild(progress(ctx, c));
      // The pool card is the one thing on this page the chain cannot vouch for, so it comes from a
      // file scripts/treasury.js writes every half hour. Missing (a fresh fork, the first run not
      // yet made) means no card, not an error: the chain numbers above are still true.
      try { numbers.appendChild(poolCard(ctx, await loadJson('./data/treasury.json'), cfg)); } catch (e) { /* no reading yet */ }
      if (c.graduated) numbers.appendChild(notice('This coin has graduated. v1 only prices next week’s budget from tax collected on the bonding curve, so trading from here on does not fund a future allowance.', 'warn'));
      numbers.appendChild(h('p', { class: 'small', style: 'margin-top:12px' },
        'Coin ', addrLink(ctx, cfg.coin), ' · curve ', addrLink(ctx, cfg.curve), ' · treasury ', addrLink(ctx, cfg.treasury), '.'));
    } catch (e) {
      clear(numbers);
      numbers.appendChild(notice('Could not read the chain: ' + errText(e), 'warn'));
    }
  }

  // The wallet may connect after this route has started rendering (app.js asks the wallet for its
  // accounts after the first paint), so the address is re-read whenever it matters, through the
  // getter app.js provides, and remembered when this page's own button connected it.
  let lastAccount = null;
  function currentAccount(ctx) {
    const live = typeof ctx.currentAccount === 'function' ? ctx.currentAccount() : null;
    return live || lastAccount || ctx.account || null;
  }

  window.WhateverData = {
    render, SEL, signInMessage, hexOfUtf8,
    // Shared with site/status.js, the same way SEL already is, so the two files cannot silently
    // disagree about how a token amount, a share or a week is read.
    unitsFromDecimalStr, fmtTokens, fmtSharePct, weekOf, weekStartOf, weekEndOf,
  };
})();
