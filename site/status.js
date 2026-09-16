'use strict';
/**
 * whatever.fun — the Status route (#/status): the network status page and the operator's
 * dashboard, in one screen.
 *
 * OT+T is a phone carrier built out of several moving parts that either work or do not: a coin
 * with a creator tax, an indexer that turns trades into data credit, a Lightning wallet that pays
 * nadanada for eSIMs, a store that remembers what was ordered, and two keepers — one that sweeps
 * the tax out of Pons's escrow, one that tops the Lightning wallet up from it. Nothing here is
 * marketing copy; it is the same six files and one HTTP call every other route reads, laid out so
 * an operator (or a trader wondering why a redeem failed) can see which of those parts is actually
 * running without opening a terminal.
 *
 * Six independent reads, each allowed to fail on its own:
 *   - ./api/status         — site/api/status.js (owned by another change; this file only consumes
 *                             the shape it documents: ok, asOf, brand, config, wiring, ready,
 *                             checks, pool). It may not exist at all on a static host with no
 *                             functions deployed, which is not a bug and is handled the same as any
 *                             other missing source: a warn row, not an exception.
 *   - ./config/esim.json   — the coin's addresses and the eSIM catalogue (site/esim.js reads the
 *                             same file for the same reasons).
 *   - ./data/allowances.json, ./data/treasury.json, ./data/claims.json, ./data/funding.json —
 *                             written by scripts/allowances.js, scripts/treasury.js,
 *                             scripts/claim.js and scripts/fund.js. A fresh checkout has all four
 *                             (a launch writes empty ones), so "missing" here mostly means "404",
 *                             which this page treats exactly like a real network failure.
 *
 * Like site/esim.js, this is a route module: app.js owns the router, the RPC rotation and the DOM
 * helper and hands them in as `ctx`; this file exposes exactly one global, window.WhateverStatus,
 * with one method, render(view, ctx). The chain read for the coin's own numbers reuses
 * window.WhateverData.SEL (esim.js's exported selector map) rather than naming the selectors a
 * second time, because esim.js is already loaded first and the two files reading the same view
 * functions under different literals is exactly the kind of drift a health page exists to catch.
 */
(function () {
  // esim.js exports these on window.WhateverData.SEL; reusing them means this file and esim.js
  // cannot silently disagree about which selector reads which view function on the curve. The
  // object below is copied only as a fallback for the (untested) case this script is ever loaded
  // before esim.js — every key it needs is also a key WhateverData.SEL carries.
  const SEL = (window.WhateverData && window.WhateverData.SEL) || {
    realQuoteReserve: '0x4f1f58fd',       // realQuoteReserve()    — curve
    graduationThreshold: '0x8b0bc501',    // graduationThreshold() — curve
    graduated: '0xe7c2b772',              // graduated()           — curve
    creatorTaxBps: '0xc1bb8901',          // creatorTaxBps()       — curve
    creatorTaxBalance: '0xdb2bd533',      // creatorTaxBalance()   — curve
  };
  const USDG_DECIMALS = 6;

  // How long a keeper can go quiet before its row turns from ok to warn, read off the cron
  // schedules that actually drive them (.github/workflows/allowances.yml, claim.yml): the indexer
  // and treasury refresh every 30 minutes, so two hours is four missed runs; the claim and funding
  // keepers run once a day, so two days is one missed run with room for a slow one.
  const INDEXER_STALE_S = 2 * 60 * 60;
  const CLAIM_STALE_S = 48 * 60 * 60;
  const FUND_STALE_S = 48 * 60 * 60;

  // ============================================================================ small helpers
  const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
  const brandOf = (cfg) => (cfg && cfg.brand) || null;
  const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '—');
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const errText = (e) => (e && e.message ? e.message : String(e)).slice(0, 200);
  const units = (big, decimals) => Number(big) / Math.pow(10, decimals);
  const word = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  // null/undefined/'' -> NaN, so a business value that is genuinely absent never gets mistaken for
  // the number zero — a real zero (no redemptions yet, say) still renders as "0", not as a dash.
  const numOr = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

  // Same formatting as site/esim.js: a balance always carries its cents, a percentage its one or
  // two decimals, a shelf price two decimals flat.
  const fmtMoney = (n) => (Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  const fmtPct = (bps) => (Number.isFinite(bps) ? (bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%' : '—');
  const fmtPrice = (n) => (Number.isFinite(n) ? '$' + n.toFixed(2) : '—');
  const fmtDate = (sec) => {
    const n = Number(sec);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const fmtCatalogueDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  // A relative age for a keeper's last run — "5m", "3h", "2d" — coarse on purpose, because the
  // question a health row answers is "is this stale", not "to the second when did it last run".
  function fmtAgo(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    if (s < 90) return s + 's';
    const m = Math.round(s / 60);
    if (m < 90) return m + 'm';
    const hr = Math.round(m / 60);
    if (hr < 48) return hr + 'h';
    return Math.round(hr / 24) + 'd';
  }

  async function loadJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  // The health endpoint answers JSON on the one status it ever chooses (200); anything else — a
  // 404 from a static host with no functions deployed, a gateway's own error page — is a fetch
  // that failed, not a payload to interpret.
  async function fetchStatus() {
    const res = await fetch('./api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let j = null;
    try { j = await res.json(); } catch (e) { throw new Error('answered a non-JSON body'); }
    if (!j || typeof j !== 'object') throw new Error('answered an empty body');
    return j;
  }

  // A settled Promise.allSettled entry -> [value, null] or [null, message], so every one of the
  // six sources below is handled the same way and none of them can throw past this point.
  const settle = (r) => (r.status === 'fulfilled' ? [r.value, null] : [null, errText(r.reason)]);

  // A tile whose number might genuinely not exist: `okSub` is shown beside the real value, `whySub`
  // is shown instead of inventing one — never a silent zero, never a value with no explanation.
  function fmtTile(ctx, label, num, fmtFn, okSub, whySub, icon) {
    const has = Number.isFinite(num);
    return ctx.tile(label, has ? fmtFn(num) : '—', has ? okSub : whySub, icon);
  }
  function cardHead(ctx, title) {
    const { h } = ctx;
    return h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, title));
  }
  function txLink(ctx, hash) {
    const { h } = ctx;
    const explorer = ctx.cfg && ctx.cfg.explorer;
    const short = hash && hash.length > 14 ? hash.slice(0, 8) + '…' + hash.slice(-6) : (hash || '—');
    return explorer ? h('a', { class: 'mono', href: explorer + '/tx/' + hash, target: '_blank', rel: 'noopener' }, short) : h('span', { class: 'mono' }, short);
  }

  // ============================================================================ the catalogue (esim.json)
  // esim.js keeps these private too, so they are copied rather than imported — small, pure, and
  // the one true source of "what counts as a package" stays the arithmetic in both files agree on:
  // a package needs a code, a positive price and a positive size.
  const packagesOf = (cfg) => (Array.isArray(cfg.packages) ? cfg.packages : []).filter((p) => p && p.code && Number(p.priceUsd) > 0 && Number(p.gb) > 0);
  const perGb = (p) => Number(p.priceUsd) / (Number(p.gb) || 1);
  const cheapest = (cfg) => packagesOf(cfg).reduce((m, p) => (m && perGb(m) <= perGb(p) ? m : p), null);
  const dearest = (cfg) => packagesOf(cfg).reduce((m, p) => (m && perGb(m) >= perGb(p) ? m : p), null);
  const cheapestEntry = (cfg) => packagesOf(cfg).reduce((m, p) => (m && m.priceUsd <= p.priceUsd ? m : p), null);
  function placeSlugs(cfg) {
    const seen = new Set();
    for (const p of packagesOf(cfg)) seen.add(p.slug);
    return Array.from(seen);
  }

  // ============================================================================ the coin's chain reads
  /** Exactly the five view functions site/esim.js reads off the curve for the same numbers — no
   *  treasury/escrow read here, because "the treasury" section below gets that from the files the
   *  keepers write, not from a second live chain call. */
  async function readChain(ctx, cfg) {
    const calls = [
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
      raisedUsd: out.raised == null ? null : units(out.raised, USDG_DECIMALS),
      thresholdUsd: out.threshold == null ? null : units(out.threshold, USDG_DECIMALS),
      graduated: out.graduated == null ? null : out.graduated !== 0n,
      taxBps: out.taxBps == null ? null : Number(out.taxBps),
      taxHeldUsd: out.taxHeld == null ? null : units(out.taxHeld, USDG_DECIMALS),
    };
  }

  // ============================================================================ 1. the health strip
  function statusRow(ctx, state, name, detail) {
    const { h } = ctx;
    return h('div', { class: 'status-row' },
      h('span', { class: 'status-dot ' + state, 'aria-hidden': 'true' }),
      h('b', {}, name),
      h('span', { class: 'small' }, detail));
  }

  /**
   * One of the four rows the health endpoint answers for. `critical` decides what "not ok" means:
   * the store and the provider are load-bearing — without a store nothing an order does can be
   * remembered, without the provider no eSIM can be fetched at all — so a failing check there is
   * off. The payer only blocks the last step (paying nadanada for a profile the provider has
   * already agreed to issue), which is real but narrower, so a failing check there is a warn.
   */
  function checkRow(ctx, label, wiringName, check, critical) {
    const name = wiringName ? label + ' · ' + wiringName : label;
    const state = !check || check.ok === undefined || check.ok === null ? 'warn' : (check.ok ? 'ok' : (critical ? 'off' : 'warn'));
    const detail = (check && check.detail) ? String(check.detail) : 'the health check reported nothing for this';
    return statusRow(ctx, state, name, detail);
  }

  function indexerRow(ctx, allow, allowErr) {
    if (allowErr) return statusRow(ctx, 'warn', 'Indexer', 'data/allowances.json has not been built yet (' + allowErr + '). Run node scripts/allowances.js.');
    const asOf = Number(allow && allow.asOf);
    if (!Number.isFinite(asOf)) return statusRow(ctx, 'warn', 'Indexer', 'has no reading yet. Run node scripts/allowances.js.');
    const ageS = Date.now() / 1000 - asOf;
    const fresh = ageS <= INDEXER_STALE_S;
    return statusRow(ctx, fresh ? 'ok' : 'warn', 'Indexer', (fresh ? 'updated ' : 'stale — last updated ') + fmtAgo(ageS) + ' ago' + (fresh ? '' : ', expected every 30 minutes'));
  }

  function claimKeeperRow(ctx, launched, claims, claimsErr) {
    if (claimsErr) return statusRow(ctx, 'warn', 'Claim keeper', 'data/claims.json has not been built yet (' + claimsErr + '). Run node scripts/claim.js.');
    const list = Array.isArray(claims) ? claims : [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last) return statusRow(ctx, launched ? 'warn' : 'ok', 'Claim keeper', launched ? 'no claim has been recorded yet' : 'nothing to claim yet — the coin has not launched');
    const ageS = Date.now() / 1000 - Number(last.at);
    const fresh = Number.isFinite(ageS) && ageS <= CLAIM_STALE_S;
    return statusRow(ctx, fresh ? 'ok' : 'warn', 'Claim keeper',
      (fresh ? 'last claimed ' : 'stale — last claimed ') + fmtAgo(ageS) + ' ago (' + fmtMoney(numOr(last.amount)) + ' ' + (last.kind === 'eth' ? 'ETH' : 'USDG') + ')');
  }

  function fundKeeperRow(ctx, launched, fund, fundErr) {
    if (fundErr) return statusRow(ctx, 'warn', 'Funding keeper', 'data/funding.json has not been built yet (' + fundErr + '). Run node scripts/fund.js.');
    const list = Array.isArray(fund) ? fund : [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last) return statusRow(ctx, launched ? 'warn' : 'ok', 'Funding keeper', launched ? 'no funding run has been recorded yet' : 'nothing to fund yet — the coin has not launched');
    const status = String(last.status || 'unknown');
    if (status === 'expired' || status === 'emergency') {
      return statusRow(ctx, 'off', 'Funding keeper', 'the last run is ' + status + ' and needs a hand at ff.io (order ' + (last.fixedFloatOrder || '—') + ')');
    }
    const ageS = Date.now() / 1000 - Number(last.finishedAt || last.at);
    const fresh = Number.isFinite(ageS) && ageS <= FUND_STALE_S;
    return statusRow(ctx, fresh ? 'ok' : 'warn', 'Funding keeper',
      (fresh ? 'last ran ' : 'stale — last ran ') + fmtAgo(ageS) + ' ago, moved ' + fmtMoney(numOr(last.amountUsd)) + ' (' + status + ')');
  }

  /**
   * Seven rows, always in this order: the coin, provider, Lightning wallet and store come from
   * ./api/status; the indexer, claim keeper and funding keeper come from the data files the
   * keepers themselves write, so they still say something true when the health endpoint cannot be
   * reached at all — a static host with no functions deployed still has an indexer, a claim log
   * and a funding log.
   */
  function healthStrip(ctx, d) {
    const { h } = ctx;
    const rows = h('div', {});
    if (d.apiErr) {
      rows.appendChild(statusRow(ctx, 'warn', 'Health check', './api/status could not be reached (' + d.apiErr + '); the coin, provider, wallet and store rows below depend on it.'));
    } else {
      const api = d.api;
      const cfgReady = !!(api.ready && api.ready.config);
      const launched = !!(api.config && api.config.launched);
      rows.appendChild(statusRow(ctx, cfgReady ? 'ok' : 'off', 'The coin', launched ? 'launched' : 'not launched yet'));
      rows.appendChild(checkRow(ctx, 'Provider', api.wiring && api.wiring.provider, api.checks && api.checks.provider, true));
      rows.appendChild(checkRow(ctx, 'Lightning wallet', api.wiring && api.wiring.payer, api.checks && api.checks.payer, false));
      rows.appendChild(checkRow(ctx, 'Store', api.wiring && api.wiring.store, api.checks && api.checks.store, true));
    }
    const launchedLocally = !!(d.cfg && isAddress(d.cfg.treasury));
    rows.appendChild(indexerRow(ctx, d.allow, d.allowErr));
    rows.appendChild(claimKeeperRow(ctx, launchedLocally, d.claims, d.claimsErr));
    rows.appendChild(fundKeeperRow(ctx, launchedLocally, d.fund, d.fundErr));
    return h('div', { class: 'card status-strip' }, cardHead(ctx, 'Health'), rows);
  }

  // ============================================================================ 2. the coin
  function coinSection(ctx, cfg, cfgErr, launched, chain, chainErr) {
    const { h, notice } = ctx;
    const card = h('div', { class: 'card' }, cardHead(ctx, 'The coin'));
    if (cfgErr) { card.appendChild(notice('site/config/esim.json could not be read (' + cfgErr + ').', 'warn')); return card; }
    if (!launched) {
      const brand = brandOf(cfg);
      card.appendChild(h('p', { class: 'small' },
        (brand ? brand.name : 'This carrier') + ' has not launched a coin yet. ', h('a', { href: 'https://whatever-fun.vercel.app/#/new', target: '_blank', rel: 'noopener' }, 'Launch the coin on whatever.fun'), '.'));
      return card;
    }
    if (chainErr) { card.appendChild(notice('Could not read the chain: ' + chainErr, 'warn')); return card; }
    const c = chain || {};
    card.appendChild(h('div', { class: 'stat-grid' },
      fmtTile(ctx, 'Raised', numOr(c.raisedUsd), fmtMoney,
        Number.isFinite(c.thresholdUsd) ? 'of ' + fmtMoney(c.thresholdUsd) + ' to graduate' : 'of an unread graduation threshold',
        'could not be read from the curve', 'chart'),
      fmtTile(ctx, 'Creator tax', numOr(c.taxBps), fmtPct, 'of every trade, to the treasury', 'could not be read from the curve', 'flame'),
      fmtTile(ctx, 'Tax held', numOr(c.taxHeldUsd), fmtMoney, 'sitting in the curve, unclaimed', 'could not be read from the curve', 'coins'),
      ctx.tile('Graduated', c.graduated === null || c.graduated === undefined ? '—' : (c.graduated ? 'Yes' : 'Not yet'),
        c.graduated === null || c.graduated === undefined ? 'could not be read from the curve' : (c.graduated ? 'trading has moved to the pool' : 'still selling on the bonding curve'), 'shield')));
    const frac = Number.isFinite(c.raisedUsd) && c.thresholdUsd > 0 ? Math.min(1, c.raisedUsd / c.thresholdUsd) : null;
    const fill = h('i', {});
    fill.style.setProperty('--w', String(frac || 0));
    card.appendChild(h('div', { class: 'data-progress' },
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Curve progress'),
        h('span', { class: 'num' }, Number.isFinite(c.raisedUsd) && Number.isFinite(c.thresholdUsd) ? fmtMoney(c.raisedUsd) + ' of ' + fmtMoney(c.thresholdUsd) : '—')),
      h('div', { class: 'sp-bar dp-bar' }, fill),
      h('p', { class: 'small', style: 'margin-top:10px' }, frac === null ? 'Progress could not be read from the curve.' : Math.round(frac * 100) + '% of the way to graduation.')));
    return card;
  }

  // ============================================================================ 3. the pool
  function poolSection(ctx, d) {
    const { h, notice } = ctx;
    const card = h('div', { class: 'card' }, cardHead(ctx, 'The pool'));
    const { treas, treasErr, api, apiErr } = d;
    if (treasErr && apiErr) {
      card.appendChild(notice('Nothing is known about the pool (data/treasury.json: ' + treasErr + '; the health check: ' + apiErr + '). Run node scripts/treasury.js.', 'warn'));
      return card;
    }
    const t = treas || {};
    const pool = (api && api.pool) || null;
    const balanceUsd = pool ? numOr(pool.usd) : NaN;
    const sats = pool ? numOr(pool.sats) : NaN;
    card.appendChild(h('div', { class: 'stat-grid' },
      fmtTile(ctx, 'Pool balance', balanceUsd, fmtMoney,
        Number.isFinite(sats) ? sats.toLocaleString('en-US') + ' sats' : 'in the Lightning wallet that pays nadanada',
        apiErr ? 'the health check could not be reached (' + apiErr + ')' : 'the health check reported no pool reading', 'wallet'),
      fmtTile(ctx, 'Runway', numOr(t.runwayDays), (n) => n.toLocaleString('en-US') + ' days', 'at the last 30 days’ rate',
        treasErr ? 'data/treasury.json: ' + treasErr : 'no spend yet to measure a rate from', 'clock'),
      fmtTile(ctx, 'Last 30 days', numOr(t.spend30dUsd), fmtMoney, 'spent on redemptions',
        treasErr ? 'data/treasury.json: ' + treasErr : 'run node scripts/treasury.js', 'coins'),
      fmtTile(ctx, 'Redemptions', numOr(t.redemptions30d), (n) => n.toLocaleString('en-US'), 'in the last 30 days',
        treasErr ? 'data/treasury.json: ' + treasErr : 'run node scripts/treasury.js', 'arrows')));
    return card;
  }

  // ============================================================================ 4. the treasury
  function claimFact(ctx, launched, claims, claimsErr) {
    const { h, notice } = ctx;
    if (claimsErr) return notice('The claim log has not been built yet (data/claims.json: ' + claimsErr + '). Run node scripts/claim.js.', 'warn');
    const list = Array.isArray(claims) ? claims : [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last) return h('p', { class: 'small' }, launched ? 'No claim has been made yet.' : 'Nothing to claim yet — the coin has not launched.');
    return h('p', { class: 'small' },
      'Last claim: ', h('b', {}, fmtMoney(numOr(last.amount)) + ' ' + (last.kind === 'eth' ? 'ETH' : 'USDG')),
      ' on ' + (fmtDate(last.at) || 'an unrecorded date') + ' — ', last.txHash ? txLink(ctx, last.txHash) : 'no transaction recorded', '.');
  }
  function fundFact(ctx, launched, fund, fundErr) {
    const { h, notice } = ctx;
    if (fundErr) return notice('The funding log has not been built yet (data/funding.json: ' + fundErr + '). Run node scripts/fund.js.', 'warn');
    const list = Array.isArray(fund) ? fund : [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last) return h('p', { class: 'small' }, launched ? 'No funding run has been recorded yet.' : 'Nothing to fund yet — the coin has not launched.');
    return h('p', { class: 'small' },
      'Last funding run: ', h('b', {}, fmtMoney(numOr(last.amountUsd)) + ' → ' + numOr(last.sats).toLocaleString('en-US') + ' sats'),
      ' on ' + (fmtDate(last.at) || 'an unrecorded date') + ' — ' + String(last.status || 'unknown'),
      last.fixedFloatOrder ? ' · order ' + last.fixedFloatOrder : '', '.');
  }
  function treasurySection(ctx, launched, d) {
    const { h } = ctx;
    const { treas, treasErr, claims, claimsErr, fund, fundErr } = d;
    const t = treas || {};
    const card = h('div', { class: 'card' }, cardHead(ctx, 'The treasury'));
    card.appendChild(h('div', { class: 'stat-grid' },
      fmtTile(ctx, 'Claimable in escrow', numOr(t.escrowClaimableUsd), fmtMoney, 'USDG waiting in the Pons fee escrow',
        treasErr ? 'data/treasury.json: ' + treasErr : 'not read yet', 'wallet'),
      fmtTile(ctx, 'Treasury wallet', numOr(t.walletUsd), fmtMoney, 'USDG held before it is moved to the pool',
        treasErr ? 'data/treasury.json: ' + treasErr : 'not read yet', 'coins')));
    card.appendChild(claimFact(ctx, launched, claims, claimsErr));
    card.appendChild(fundFact(ctx, launched, fund, fundErr));
    return card;
  }

  // ============================================================================ 5. the programme
  function programmeSection(ctx, d) {
    const { h, notice } = ctx;
    const card = h('div', { class: 'card' }, cardHead(ctx, 'The programme'));
    if (d.allowErr) {
      card.appendChild(notice('The indexer has not run yet (data/allowances.json: ' + d.allowErr + '). Run node scripts/allowances.js.', 'warn'));
      return card;
    }
    const wallets = (d.allow && d.allow.wallets) || {};
    const entries = Object.entries(wallets);
    let traded = 0, earned = 0, earners = 0;
    for (const [, w] of entries) {
      const tw = numOr(w && w.tradedUsd), ew = numOr(w && w.earnedUsd);
      if (Number.isFinite(tw)) traded += tw;
      if (Number.isFinite(ew)) { earned += ew; if (ew > 0) earners++; }
    }
    card.appendChild(h('div', { class: 'stat-grid' },
      ctx.tile('Traded', fmtMoney(traded), 'total volume against the curve', 'chart'),
      ctx.tile('Earned', fmtMoney(earned), 'total data credit banked', 'coins'),
      ctx.tile('Wallets earning', String(earners), entries.length ? 'of ' + entries.length + ' that have traded' : 'nobody has traded yet', 'shield')));
    if (!entries.length) { card.appendChild(h('p', { class: 'small' }, 'Nobody has traded against the curve yet.')); return card; }

    const top = entries.slice().sort((a, b) => numOr(b[1] && b[1].earnedUsd) - numOr(a[1] && a[1].earnedUsd)).slice(0, 5);
    const tbody = h('tbody', {});
    for (const [addr, w] of top) {
      tbody.appendChild(h('tr', {},
        h('td', { class: 'mono' }, shortAddr(addr)),
        h('td', { class: 'num' }, fmtMoney(numOr(w && w.tradedUsd) || 0)),
        h('td', { class: 'num' }, fmtMoney(numOr(w && w.earnedUsd) || 0))));
    }
    card.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'status-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Wallet'), h('th', { class: 'num' }, 'Traded'), h('th', { class: 'num' }, 'Earned'))),
      tbody)));
    return card;
  }

  // ============================================================================ 6. the catalogue
  function catalogueSection(ctx, cfg, cfgErr) {
    const { h, notice } = ctx;
    const card = h('div', { class: 'card' }, cardHead(ctx, 'The catalogue'));
    if (cfgErr) { card.appendChild(notice('site/config/esim.json could not be read (' + cfgErr + ').', 'warn')); return card; }
    const list = packagesOf(cfg);
    if (!list.length) { card.appendChild(notice('No packages are configured yet in config/esim.json.', 'warn')); return card; }
    const placeCount = placeSlugs(cfg).length;
    const cheap = cheapestEntry(cfg);
    const lo = cheapest(cfg), hi = dearest(cfg);
    const catDate = cfg.catalogueAt ? fmtCatalogueDate(cfg.catalogueAt) : null;
    card.appendChild(h('div', { class: 'stat-grid' },
      ctx.tile('Provider', cfg.provider || '—', 'the eSIM reseller', 'shield'),
      ctx.tile('Places', String(placeCount), placeCount === 1 ? 'place on the menu' : 'places on the menu', 'chart'),
      ctx.tile('Packages', String(list.length), 'fixed-size eSIM packages', 'coins'),
      ctx.tile('Cheapest', cheap ? fmtPrice(cheap.priceUsd) : '—', cheap ? cheap.name + ' · ' + (Number(cheap.gb) || 1) + ' GB' : 'no packages configured', 'wallet'),
      ctx.tile('Per gigabyte', lo ? fmtPrice(perGb(lo)) + (hi && hi !== lo ? ' – ' + fmtPrice(perGb(hi)) : '') : '—',
        lo ? (hi && hi !== lo ? lo.name + ' to ' + hi.name : lo.name) : 'no packages configured', 'flame'),
      ctx.tile('Catalogue date', catDate || '—', catDate ? 'when ' + (cfg.provider || 'the provider') + ' was last read' : 'not recorded in config/esim.json', 'clock')));
    return card;
  }

  // ============================================================================ the page
  async function render(view, ctx) {
    const { h, notice } = ctx;
    const label = h('div', { class: 'label' }, 'NETWORK STATUS');
    const lede = h('p', { class: 'page-lede' },
      'The coin, the pool, the treasury, the programme and the catalogue — read straight off the same files and the same chain every other route uses, with whatever is missing named instead of hidden.');
    view.appendChild(h('div', { class: 'page-head' }, label, h('h1', {}, 'Everything, and whether it is running.'), lede));

    const body = h('div', { class: 'data-page' }, notice('Reading the network…', 'plain'));
    view.appendChild(body);

    try {
      const [cfgR, allowR, treasR, claimsR, fundR, apiR] = await Promise.allSettled([
        loadJson('./config/esim.json'),
        loadJson('./data/allowances.json'),
        loadJson('./data/treasury.json'),
        loadJson('./data/claims.json'),
        loadJson('./data/funding.json'),
        fetchStatus(),
      ]);
      const [cfgRaw, cfgErr] = settle(cfgR);
      const [allow, allowErr] = settle(allowR);
      const [treas, treasErr] = settle(treasR);
      const [claims, claimsErr] = settle(claimsR);
      const [fund, fundErr] = settle(fundR);
      const [api, apiErr] = settle(apiR);
      const cfg = cfgRaw || {};

      const brand = brandOf(cfg);
      if (brand) label.textContent = (brand.name + ' · NETWORK STATUS').toUpperCase();

      // A partial config counts as not launched, the same rule site/esim.js uses: with no curve
      // there is nothing to read the coin's numbers from.
      const launched = isAddress(cfg.coin) && isAddress(cfg.curve) && isAddress(cfg.treasury);
      let chain = null, chainErr = null;
      if (launched) {
        try { chain = await readChain(ctx, cfg); }
        catch (e) { chainErr = errText(e); }
      }

      clear(body);
      body.appendChild(healthStrip(ctx, { cfg, api, apiErr, allow, allowErr, claims, claimsErr, fund, fundErr }));
      body.appendChild(coinSection(ctx, cfg, cfgErr, launched, chain, chainErr));
      body.appendChild(poolSection(ctx, { treas, treasErr, api, apiErr }));
      body.appendChild(treasurySection(ctx, launched, { treas, treasErr, claims, claimsErr, fund, fundErr }));
      body.appendChild(programmeSection(ctx, { allow, allowErr }));
      body.appendChild(catalogueSection(ctx, cfg, cfgErr));
    } catch (e) {
      // Every expected failure is handled above, source by source; this is only a backstop against
      // a bug in this file itself, so the page still says something honest instead of going blank.
      clear(body);
      body.appendChild(notice('This page hit a problem building itself: ' + errText(e), 'error'));
    }
  }

  window.WhateverStatus = { render };
})();
