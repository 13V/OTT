'use strict';
/**
 * OT+T — the home route (#/): a carrier landing page, not a config dump.
 *
 * One coin on Pons carries a creator tax, and that tax goes to a treasury. What the treasury buys
 * with it is mobile data: every trade against the coin's bonding curve earns the TRADER a rebate
 * of rebateBps of what they traded, banked as dollars of data credit — earnedUsd = tradedUsd ×
 * rebateBps / 10000 — and spent later on eSIMs from nadanada, in 1, 5 or 10 GB sizes across a few
 * dozen places, paid for over Lightning. A gigabyte's price depends on where you buy it and how
 * much of it you buy at once — a 10 GB package is a far better per-gigabyte deal than a 1 GB one —
 * so credit is banked in dollars rather than gigabytes, and the page says so instead of hiding it
 * in a unit. The accounting is done off chain by scripts/allowances.js, which writes
 * site/data/allowances.json; the handing out of a profile is done by /api/redeem, because it costs
 * money and needs a secret. This file is the page between the two.
 *
 * The page reads top to bottom the way a carrier's does: a hero with the offer, a row of checkable
 * facts, the plan catalogue with a place picker (the actual product), how a trade turns into an
 * eSIM, the full coverage list, the visitor's own wallet and orders, and — last, as supporting
 * detail rather than the headline — the programme's own chain numbers. Every section but the
 * wallet panel and the live numbers reads from config/esim.json alone, so the page is not empty
 * before the coin launches; only the wallet panel and the chain numbers need a launched coin.
 *
 * It is a route module in the same sense site/launch.js is a signing module: app.js owns the
 * router, the RPC rotation, the wallet flow and the DOM helper, and hands them in as `ctx` — so
 * nothing here is a second copy of something app.js already does, and the file can be read on its
 * own. It exposes exactly one global, window.WhateverData, with one method: render(view, ctx). A
 * second global, window.WhateverQr (site/qr.js), draws the activation QR for the rare order whose
 * qrCodeUrl came back empty; this file calls it defensively and does not depend on it being loaded.
 *
 * Everything this page needs is loaded when the page is opened and never at boot — config/esim.json
 * and data/allowances.json are both allowed to be missing, and a missing file here must cost this
 * route its numbers and no other route anything. Every failure path is a notice in the page; the
 * only thing that throws is a bug.
 *
 * v1 is deliberately narrow: pre-graduation only, and USDG-paired only. Volume is counted from
 * USDG Transfer events between the wallet and the curve; a coin paired to native ETH has no such
 * events, so its trades could not be counted this way and the page says so rather than guessing.
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
  const packagesOf = (cfg) => (Array.isArray(cfg.packages) ? cfg.packages : []).filter((p) => p && p.code && Number(p.priceUsd) > 0 && Number(p.gb) > 0);
  // A package's price per gigabyte — what actually makes one package a better deal than another,
  // now that a place sells more than one size. "Cheapest"/"dearest" mean cheapest and dearest BY
  // THIS, not by the sticker price: a 10 GB package can cost more dollars than a 1 GB one at the
  // same place and still be the cheaper way to buy a gigabyte.
  const perGb = (p) => Number(p.priceUsd) / (Number(p.gb) || 1);
  const cheapest = (cfg) => packagesOf(cfg).reduce((m, p) => (m && perGb(m) <= perGb(p) ? m : p), null);
  const dearest = (cfg) => packagesOf(cfg).reduce((m, p) => (m && perGb(m) >= perGb(p) ? m : p), null);
  // The cheapest package to just buy, in dollars — "from $0.99" is a shelf price a trader with a
  // small balance can actually afford, not a unit price nobody redeems at exactly.
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
  // What a package actually costs a trader in trades, not dollars: priceUsd ÷ the rebate rate is
  // the volume they need to have traded to have earned that many dollars of credit. null when the
  // rebate rate is not configured, rather than a division that quietly claims 0% funds everything.
  function volumeFor(cfg, priceUsd) {
    const bps = Number(cfg.rebateBps) || 0;
    if (!bps || !Number.isFinite(priceUsd)) return null;
    return priceUsd / (bps / 10000);
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
    const rebateBps = Number(cfg.rebateBps) || 0;

    // These four read config/esim.json only, so they render the same whether or not a coin has
    // launched — which matters, because "not launched" is the state a first-time visitor sees.
    view.appendChild(trustRow(ctx, cfg));
    view.appendChild(plansSection(ctx, cfg));
    view.appendChild(howItWorks(ctx, cfg));
    view.appendChild(coverageSection(ctx, cfg));

    if (!launched) {
      view.appendChild(bareSection(ctx, notLaunched(ctx, cfg)));
      return;
    }

    const mine = h('div', { class: 'card data-mine' });
    view.appendChild(h('div', { class: 'section', id: 'your-data' }, h('div', { class: 'wrap' }, mine)));
    refresh.mine = () => paintMine(ctx, cfg, mine);
    // The wallet panel and the treasury numbers do not wait for each other: a slow RPC should not
    // hold up a balance that comes from a static file, and vice versa.
    refresh.mine();

    const numbers = h('div', { class: 'col' }, notice('Reading the chain…', 'plain'));
    view.appendChild(h('div', { class: 'section', id: 'programme' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' }, h('h2', {}, 'The programme’s numbers')),
      numbers)));
    await paintNumbers(ctx, cfg, rebateBps, numbers);
  }

  // A section with no header of its own — used for the two single-card fallbacks (config missing,
  // not launched) so they still sit in the page's .section/.wrap rhythm instead of floating flush
  // against the viewport edge.
  function bareSection(ctx, content) {
    return ctx.h('div', { class: 'section' }, ctx.h('div', { class: 'wrap' }, content));
  }

  // ============================================================================ 1. hero
  /**
   * One headline (the offer, not the mechanism — "trade the coin" is the how, and it belongs
   * further down), one sub-line, and two actions: the primary one either jumps to the plans a
   * visitor with a wallet is here for, or offers to connect one for a visitor who has none yet, so
   * connecting from the hero is not a dead end — `refresh.mine` (set once the wallet panel below
   * exists) repaints it with the freshly connected address instead of leaving the page to say
   * "Connect a wallet" under a wallet that is now connected.
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
        h('h1', { class: 'hero-title' }, 'Mobile data in 28 places, paid for by your trades.'),
        h('p', { class: 'hero-sub' }, 'A rebate on every trade, banked as credit for an eSIM.'),
        h('div', { class: 'hero-actions' }, primary,
          h('a', { class: 'btn btn-ghost', href: '#how-it-works' }, 'How it works')))));
  }

  // ============================================================================ 2. trust row
  /**
   * Three or four short, checkable claims — not a slogan. Two are read straight off the catalogue
   * (so they can never overstate it), and two describe the mechanism itself. Nothing here is a
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
   */
  function plansSection(ctx, cfg) {
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
        const vol = volumeFor(cfg, p.priceUsd);
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
            vol !== null ? h('span', {}, '≈ ' + fmtPrice(vol) + ' traded') : null),
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
   * Three plain, specific steps — trade, credit, redeem — with no marketing language. This is also
   * where the two facts that most need a straight sentence live: that the rebate pays whoever
   * traded rather than whoever is holding, and that v1 only counts pre-graduation, USDG-paired
   * trades. Both are true regardless of brand, and the wording only differs from a fork with no
   * brand configured in whose name it uses for the curve.
   */
  function howItWorks(ctx, cfg) {
    const { h } = ctx;
    const brand = brandOf(cfg);
    const carrier = brand ? brand.name : 'the coin';
    const rebate = fmtPct(Number(cfg.rebateBps) || 0);
    const steps = [
      { title: 'Trade the coin',
        body: 'Every buy or sell against ' + carrier + '’s bonding curve, in USDG, pays back whoever placed the trade. Holding the coin earns nothing on its own.' },
      { title: 'Credit accrues automatically',
        body: rebate + ' of what you traded is banked to your wallet as dollars of data credit — counted from pre-graduation trades in USDG only, no claim needed.' },
      { title: 'Redeem an eSIM and scan it',
        body: 'Spend the credit on an eSIM from nadanada: pick a place and size, sign a message to prove the wallet is yours, and scan the QR at the airport — that is where the credit turns into gigabytes, not at the trade.' },
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
    row('Rebate', fmtPct(Number(cfg.rebateBps) || 0) + ' of traded volume, as data credit');
    row('Packages', plist.length && cheapEntry ? plist.length + ' places · ' + gbSizesText(cfg, 'and') + ' GB · from ' + fmtPrice(cheapEntry.priceUsd) : 'none configured yet');
    row('Redeemed as', 'eSIMs from nadanada, paid by Lightning');
    row('Creator tax', fmtPct(Number(cfg.taxBps) || 0) + ' to the treasury');
    row('Paired to', cfg.pair === ZERO || !cfg.pair ? 'native ETH (not counted in v1)' : 'USDG');
    row('Counts', 'pre-graduation trades only');
    return h('div', { class: 'card data-notlaunched' },
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Not launched yet')),
      h('p', { class: 'small' }, 'The coin behind this programme has not been launched. These are the rules it will run under; the addresses land in config/esim.json on launch day.'),
      rows,
      h('div', { class: 'data-actions' },
        // whatever.fun is the launchpad this coin would launch through; it is a different site now,
        // so this leaves rather than routes — a new tab, and a label that says exactly that.
        h('a', { class: 'btn btn-primary', href: 'https://whatever-fun.vercel.app/#/new', target: '_blank', rel: 'noopener' }, 'Launch the coin on whatever.fun'),
        h('a', { class: 'btn btn-ghost', href: '#/about' }, 'How this works')));
  }

  // ============================================================================ 6. your data
  /**
   * The wallet's side of the page. Three sources in order of how sure they are: the address (the
   * wallet), what it has earned (allowances.json, built by the indexer), and what it has redeemed
   * (the API, which asks the provider). Each is allowed to fail on its own and says so in place.
   */
  async function paintMine(ctx, cfg, panel) {
    const { h, notice } = ctx;
    const account = currentAccount(ctx);
    clear(panel);
    panel.appendChild(h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Your data')));

    if (!account) {
      const hint = h('p', { class: 'hint' }, '');
      const btn = h('button', { class: 'btn btn-primary', onclick: async () => {
        btn.disabled = true;
        try {
          const acc = await ctx.connect();
          if (acc) { lastAccount = acc; paintMine(ctx, cfg, panel); return; }
          hint.textContent = 'No wallet connected.';
        } catch (e) { hint.textContent = 'Could not connect: ' + errText(e); hint.classList.add('err'); }
        finally { btn.disabled = false; }
      } }, 'Connect wallet');
      panel.appendChild(h('p', { class: 'small' }, 'Connect a wallet to see the data it has banked, and to redeem it as an eSIM.'));
      panel.appendChild(h('div', { class: 'data-actions' }, btn));
      panel.appendChild(hint);
      return;
    }

    const addr = account.toLowerCase();
    panel.appendChild(h('p', { class: 'mono data-addr' }, addr));
    const tiles = h('div', { class: 'stat-grid data-tiles' });
    const status = h('div', {}, notice('Reading your balance…', 'plain'));
    panel.appendChild(tiles);
    panel.appendChild(status);

    // What the indexer says this wallet earned. A missing file is "not built yet", not zero.
    let earnedUsd = null, allowError = null;
    try {
      const allow = await loadJson('./data/allowances.json');
      const row = allow && allow.wallets ? allow.wallets[addr] : null;
      earnedUsd = row && Number.isFinite(Number(row.earnedUsd)) ? Number(row.earnedUsd) : 0;
    } catch (e) { allowError = errText(e); }

    // What the API says has been redeemed. It is the only one of the three that knows.
    let standing = null, apiError = null;
    try { standing = await api('GET', './api/redeem?address=' + addr); }
    catch (e) { apiError = errText(e); }

    const earned = standing ? Number(standing.earnedUsd) : earnedUsd;
    const redeemed = standing ? Number(standing.redeemedUsd) : null;
    const remaining = standing ? Number(standing.remainingUsd) : null;
    clear(tiles);
    tiles.appendChild(ctx.tile('Earned', fmtMoney(earned), 'of data credit from your trades', 'coins'));
    tiles.appendChild(ctx.tile('Redeemed', fmtMoney(redeemed), 'spent on eSIM packages', 'clock'));
    tiles.appendChild(ctx.tile('Available', fmtMoney(remaining), inGb(cfg, remaining) || 'ready to spend', 'arrows'));

    clear(status);
    if (allowError) status.appendChild(notice('The allowances have not been built yet (data/allowances.json: ' + allowError + '). Run node scripts/allowances.js.', 'warn'));
    if (apiError) status.appendChild(notice('Could not reach the redeem API: ' + apiError, 'warn'));
    if (!standing) return;

    panel.appendChild(redeemForm(ctx, cfg, addr, standing, panel));
    panel.appendChild(orders(ctx, cfg, addr, standing.orders || []));
  }

  // A picker for which package: first the place, then the size sold at that place, then the one
  // button. The button says what the pick costs, and is disabled with a reason rather than hidden
  // when the balance is short, so a trader can see how far off they are.
  function redeemForm(ctx, cfg, addr, standing, panel) {
    const { h, notice } = ctx;
    const plist = places(cfg);
    const regions = plist.filter((p) => p.kind === 'region');
    const countries = plist.filter((p) => p.kind === 'country');
    const remaining = Number(standing.remainingUsd) || 0;
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
    const hint = h('p', { class: 'hint' }, '');
    const btn = h('button', { class: 'btn btn-primary btn-block', onclick: () => doRedeem() }, 'Redeem');
    const result = h('div', {});
    const wrap = h('div', { class: 'data-redeem' },
      h('div', { class: 'divider' }),
      h('div', { class: 'field' }, h('label', { for: 'f-place' }, 'Place'), placeSelect),
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
      hint.textContent = short ? 'You have ' + fmtMoney(remaining) + ' of credit; this package costs ' + fmtPrice(p.priceUsd) + '.' : '';
      hint.classList.toggle('err', false);
    }
    function selectSize(code) {
      packageInput.value = code;
      for (const el of sizes.children) el.classList.toggle('active', el.dataset.code === code);
      paintButton();
    }
    // Changing the place repaints the size row for that place and picks the smallest size, the
    // same as opening the picker for the first time does.
    function paintSizes() {
      clear(sizes);
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
        result.appendChild(orderCard(ctx, cfg, out.order, true));
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
          repaintFrom(ctx, cfg, addr, freshStanding, panel, out.order);
        } else {
          const spent = Number(out.order && out.order.priceUsd) || pkg.priceUsd;
          const fallback = Object.assign({}, standing, {
            remainingUsd: out.remainingUsd,
            redeemedUsd: Math.round((Number(standing.redeemedUsd || 0) + spent) * 100) / 100,
            orders: (standing.orders || []).concat([out.order]),
          });
          repaintFrom(ctx, cfg, addr, fallback, panel, out.order);
        }
      } catch (e) {
        const msg = errText(e);
        // A stale picture of the wallet's own orders is the one failure worth recovering from
        // without being asked twice: the panel is about to be rebuilt from scratch, so the message
        // goes to a toast, which outlives that rebuild, rather than into the result block paintMine
        // is about to clear out from under it.
        if (/reload/i.test(msg)) {
          if (typeof ctx.toast === 'function') ctx.toast('Could not redeem', msg, 'error');
          paintMine(ctx, cfg, panel);
          return;
        }
        clear(result);
        result.appendChild(notice('Could not redeem: ' + msg, 'error'));
        paintButton();
      }
    }
    return wrap;
  }

  // After a successful order, the whole wallet panel is rebuilt from the answer the API just
  // gave, with the new order pinned at the top. The GET is not repeated: the API told us the
  // remaining balance, and asking again only costs the provider a walk it has just done.
  function repaintFrom(ctx, cfg, addr, standing, panel, fresh) {
    const { h } = ctx;
    clear(panel);
    panel.appendChild(h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Your data')));
    panel.appendChild(h('p', { class: 'mono data-addr' }, addr));
    const tiles = h('div', { class: 'stat-grid data-tiles' },
      ctx.tile('Earned', fmtMoney(Number(standing.earnedUsd)), 'of data credit from your trades', 'coins'),
      ctx.tile('Redeemed', fmtMoney(Number(standing.redeemedUsd)), 'spent on eSIM packages', 'clock'),
      ctx.tile('Available', fmtMoney(Number(standing.remainingUsd)), inGb(cfg, Number(standing.remainingUsd)) || 'ready to spend', 'arrows'));
    panel.appendChild(tiles);
    panel.appendChild(orderCard(ctx, cfg, fresh, true));
    panel.appendChild(redeemForm(ctx, cfg, addr, standing, panel));
    panel.appendChild(orders(ctx, cfg, addr, standing.orders || [], fresh.transactionId));
  }

  /**
   * The past-orders list. A GET, or any unsigned load, never carries a code — an activation code
   * is a one-time thing, and only the wallet that signs for it gets to see one — so every card
   * here starts redacted (orderCard already renders that correctly: it just has nothing to show).
   * "Show my eSIM codes" is the signed read that fills them back in, in place. `excludeId` drops
   * whichever order is already pinned above this list as "fresh", so a just-redeemed order is
   * never shown twice — once with codes, once without.
   */
  function orders(ctx, cfg, addr, list, excludeId) {
    const { h } = ctx;
    const wrap = h('div', { class: 'data-orders' }, h('div', { class: 'divider' }), h('div', { class: 'label' }, 'PAST ESIMS'));
    const without = (items) => (excludeId ? items.filter((o) => o.transactionId !== excludeId) : items);
    const shown = without(list);
    if (!shown.length) { wrap.appendChild(h('p', { class: 'small' }, 'Nothing redeemed yet.')); return wrap; }

    const cards = h('div', {});
    // Newest first: the one you need at the gate is the one you just ordered.
    const paintCards = (items) => { clear(cards); for (const o of items.slice().reverse()) cards.appendChild(orderCard(ctx, cfg, o, false)); };
    paintCards(shown);

    const hint = h('p', { class: 'hint' }, '');
    const btn = h('button', { class: 'btn btn-sm', onclick: async () => {
      if (!window.ethereum) { hint.textContent = 'No wallet found to sign with.'; hint.classList.add('err'); return; }
      btn.disabled = true;
      hint.textContent = ''; hint.classList.remove('err');
      try {
        const { message, signature } = await signIn(addr);
        const out = await api('POST', './api/redeem', { address: addr, message, signature });
        paintCards(without(out.orders || []));
      } catch (e) {
        hint.textContent = 'Could not read your codes: ' + errText(e);
        hint.classList.add('err');
      } finally { btn.disabled = false; }
    } }, 'Show my eSIM codes');
    wrap.appendChild(h('div', { class: 'data-actions' }, btn, hint));
    wrap.appendChild(cards);
    return wrap;
  }

  /**
   * One eSIM: the QR the phone scans, the same activation code as text for the phones that would
   * rather be told than shown, and — when nadanada included them — the one-tap install links and
   * the manual SM-DP+/matching-id pair for a phone that can use neither of the above.
   */
  function orderCard(ctx, cfg, o, fresh) {
    const { h, notice } = ctx;
    o = o || {};
    const pkg = packageByCode(cfg, o.packageCode);
    const code = h('code', { class: 'mono data-ac' }, o.ac || '—');
    const copy = h('button', { class: 'btn btn-sm', onclick: async () => {
      try { await navigator.clipboard.writeText(o.ac || ''); copy.textContent = 'Copied'; }
      catch (e) { copy.textContent = 'Select and copy'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    } }, 'Copy');
    const when = o.createdAt ? new Date(o.createdAt) : null;

    // What "still working on it" means depends on the stage: the Lightning invoice can be sitting
    // unpaid, or paid and waiting on nadanada to issue the profile. o.note, when the pool left one,
    // is the one line of why.
    let pendingText = null;
    if (o.pending) {
      pendingText = o.stage === 'invoiced' ? 'Paying the invoice… open this page again in a minute.'
        : o.stage === 'paid' ? 'Paid. nadanada is issuing the profile — open this page again in a minute and the QR will be here.'
        : 'Ordered. The provider is still issuing the profile — open this page again in a minute and the QR will be here.';
      if (o.note) pendingText += ' (' + o.note + ')';
    }

    // nadanada usually sends a picture of the QR; when it does not, the activation code alone is
    // enough to draw the same one here — a phone only ever reads the code, never the provider's PNG.
    let qrSrc = o.qrCodeUrl || '';
    if (!qrSrc && o.ac && window.WhateverQr) {
      try { qrSrc = window.WhateverQr.svg(o.ac); } catch (e) { qrSrc = ''; }
    }
    const install = [
      o.appleInstallUrl ? h('a', { class: 'btn btn-sm', href: o.appleInstallUrl, target: '_blank', rel: 'noopener' }, 'Install on iPhone') : null,
      o.androidInstallUrl ? h('a', { class: 'btn btn-sm', href: o.androidInstallUrl, target: '_blank', rel: 'noopener' }, 'Install on Android') : null,
    ].filter(Boolean);

    return h('div', { class: 'card-quiet data-order' + (fresh ? ' fresh' : '') },
      h('div', { class: 'data-order-head' },
        h('span', { class: 'badge badge-hold' }, fresh ? 'NEW' : '#' + (Number.isFinite(Number(o.n)) ? Number(o.n) + 1 : '?')),
        h('span', { class: 'cc-sym' }, pkg ? packageLabel(pkg) : (o.packageCode || 'eSIM')),
        Number.isFinite(Number(o.priceUsd)) ? h('span', { class: 'small' }, fmtPrice(Number(o.priceUsd))) : null,
        when && !Number.isNaN(when.getTime()) ? h('span', { class: 'small' }, when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) : null),
      pendingText ? notice(pendingText, 'plain') : null,
      qrSrc ? h('img', { class: 'data-qr', src: qrSrc, alt: 'eSIM QR code for ' + (pkg ? pkg.name : o.packageCode || 'this package'), width: '180', height: '180' }) : null,
      install.length ? h('div', { class: 'data-install' }, install) : null,
      h('div', { class: 'data-ac-row' }, code, copy),
      o.smdpAddress ? h('p', { class: 'small' }, 'SM-DP+ ', h('span', { class: 'mono' }, o.smdpAddress), ' · code ', h('span', { class: 'mono' }, o.matchingId || '')) : null,
      o.iccid ? h('p', { class: 'small' }, 'ICCID ', h('span', { class: 'mono' }, o.iccid)) : null,
      h('p', { class: 'small' }, 'Order ', h('span', { class: 'mono' }, o.transactionId || '—')));
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
      h('p', { class: 'small', style: 'margin-top:10px' }, Math.round(frac * 100) + '% of the way to graduation. Rebates accrue until then.'));
  }

  // ============================================================================ 7. the programme's numbers
  /**
   * The treasury and curve figures, painted after the wallet panel rather than beside it — this is
   * supporting detail for a trader who wants to check the mechanism, not the first thing the page
   * shows. Kept as its own async function (rather than inlined in render()) only so render() stays
   * a plain list of the seven bands in order.
   */
  async function paintNumbers(ctx, cfg, rebateBps, numbers) {
    const { h, notice } = ctx;
    const usdgPaired = String(cfg.pair || '').toLowerCase() === String((ctx.cfg && ctx.cfg.usdg) || '').toLowerCase();
    try {
      const c = await readChain(ctx, cfg);
      clear(numbers);
      if (!usdgPaired) {
        // No fake accounting: the indexer counts USDG Transfer events, and a native-ETH pair
        // (pair == 0x0) or any other pair does not produce them. Say so where the numbers would be.
        numbers.appendChild(notice('This coin is paired to ' + (cfg.pair === ZERO || !cfg.pair ? 'native ETH' : shortAddr(cfg.pair))
          + ', and v1 only counts USDG-paired trades — a native-ETH pair has no Transfer events to count, so no rebates accrue here yet.', 'warn'));
      }
      const lo = cheapest(cfg), hi = dearest(cfg);
      const poolGb = usdgPaired && Number.isFinite(c.treasuryUsd) && lo ? Math.floor(c.treasuryUsd / perGb(lo)) : null;
      numbers.appendChild(h('div', { class: 'stat-grid page-tiles data-tiles' },
        ctx.tile('Treasury claimable', usdgPaired ? fmtMoney(c.treasuryUsd) : '—', 'USDG sitting in the fee escrow for the treasury', 'wallet'),
        ctx.tile('Data pool', poolGb === null ? '—' : poolGb.toLocaleString('en-US') + ' GB',
          lo ? 'at ' + fmtPrice(perGb(lo)) + '/GB (' + lo.name + ' · ' + (Number(lo.gb) || 1) + ' GB)' + (hi && hi !== lo ? ' · ' + Math.floor(c.treasuryUsd / perGb(hi)).toLocaleString('en-US') + ' GB ' + hi.name.toLowerCase() : '') : 'no packages configured', 'coins'),
        ctx.tile('Creator tax', fmtPct(c.taxBps), c.taxHeldUsd !== null ? fmtMoney(c.taxHeldUsd) + ' still held in the curve' : 'read from the curve', 'flame'),
        ctx.tile('Rebate', fmtPct(rebateBps), 'of what you trade, back as data', 'arrows')));
      numbers.appendChild(progress(ctx, c));
      // The pool card is the one thing on this page the chain cannot vouch for, so it comes from a
      // file scripts/treasury.js writes every half hour. Missing (a fresh fork, the first run not
      // yet made) means no card, not an error: the chain numbers above are still true.
      try { numbers.appendChild(poolCard(ctx, await loadJson('./data/treasury.json'), cfg)); } catch (e) { /* no reading yet */ }
      if (c.graduated) numbers.appendChild(notice('This coin has graduated. v1 counts trades against the bonding curve only, so volume from here on does not earn data.', 'warn'));
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

  window.WhateverData = { render, SEL, signInMessage, hexOfUtf8 };
})();
