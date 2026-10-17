'use strict';
/**
 * whatever.fun — the Status route (#/status): the network status page and the operator's
 * dashboard, in one screen.
 *
 * OT+T is a phone carrier built out of several moving parts that either work or do not: a coin on
 * pump.fun whose creator fees fund the programme, a ledger keeper that turns last week's collected
 * fees and this week's members into a data budget, a Lightning wallet that pays wholesale for
 * eSIMs, a store that remembers what was ordered, and two keepers — one that collects the creator
 * fees into the treasury, one that converts them to Lightning. Nothing here is marketing copy; it
 * is the same six files and one HTTP call every other route reads, laid out so an operator (or a
 * holder wondering why a redeem failed) can see which of those parts is running.
 *
 * Six independent reads, each allowed to fail on its own:
 *   - ./api/status         — site/api/status.js. It may not exist on a static host with no
 *                             functions deployed, which is handled like any other missing source:
 *                             a warn row, not an exception.
 *   - ./config/esim.json   — the coin's addresses and the eSIM catalogue.
 *   - ./data/allowances.json, ./data/treasury.json, ./data/claims.json, ./data/funding.json —
 *                             written by scripts/allowances.js, scripts/treasury.js,
 *                             scripts/claim.js and scripts/fund.js.
 *
 * Plus one chain read, the coin's pump.fun bonding curve, for its progress and raised SOL.
 * Like site/esim.js, this is a route module: app.js hands in `ctx`, and this file exposes exactly
 * one global, window.WhateverStatus, with one method, render(view, ctx).
 */
(function () {
  // esim.js exports these, for the same reason: the wallets table below reads a token balance and
  // a share the same way esim.js's own dashboard does. The fallbacks are only for the (untested)
  // case this script loads before esim.js.
  const WD = window.WhateverData || {};
  const unitsFromDecimalStr = WD.unitsFromDecimalStr || function (s, decimals) {
    try { return Number(BigInt(String(s === null || s === undefined ? '0' : s))) / Math.pow(10, Number(decimals) || 0); }
    catch (e) { return NaN; }
  };
  const fmtTokens = WD.fmtTokens || ((n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'));
  const fmtSharePct = WD.fmtSharePct || function (share) {
    const s = Number(share);
    if (!Number.isFinite(s) || s < 0) return '—';
    if (s === 0) return '0%';
    const pct = s * 100;
    const digits = pct >= 100 ? 0 : Math.min(6, Math.max(0, 2 - Math.floor(Math.log10(pct))));
    return pct.toFixed(digits) + '%';
  };
  // pump.fun's bonding curve sells 793.1 million tokens (six decimals) before it graduates.
  const CURVE_SALE_UNITS = 793100000000000n;
  const BONDING_CURVE_DISC = [23, 183, 248, 55, 96, 216, 172, 96];

  // How long a keeper can go quiet before its row turns from ok to warn, read off the cron
  // schedules that actually drive them (.github/workflows/allowances.yml, claim.yml): the indexer
  // and treasury refresh every 30 minutes, so two hours is four missed runs; the claim and funding
  // keepers run once a day, so two days is one missed run with room for a slow one.
  const INDEXER_STALE_S = 2 * 60 * 60;
  const CLAIM_STALE_S = 48 * 60 * 60;
  const FUND_STALE_S = 48 * 60 * 60;

  // ============================================================================ small helpers
  const Sol = () => window.OTTSolana;
  const isAddress = (a) => !!Sol() && Sol().isAddress(a);
  const launchedConfig = (cfg) => !!window.OTTSolana && window.OTTSolana.launchedConfig(cfg);
  const brandOf = (cfg) => (cfg && cfg.brand) || null;
  const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '—');
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const errText = (e) => (e && e.message ? e.message : String(e)).slice(0, 200);
  // null/undefined/'' -> NaN, so a business value that is genuinely absent never gets mistaken for
  // the number zero — a real zero (no redemptions yet, say) still renders as "0", not as a dash.
  const numOr = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

  // Same formatting as site/esim.js: a balance always carries its cents, a percentage its one or
  // two decimals, a shelf price two decimals flat.
  const fmtMoney = (n) => (Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  const fmtSol = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 }) + ' SOL' : '—');
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
    const url = window.OTTClientConfig?.apiUrl('./api/status') || './api/status';
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
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
  // Every one of the six blocks below shares the home page's own rhythm: a full-width band, a
  // centred column, and a heading above the card rather than inside it. The card itself is kept —
  // this is still six distinct, bordered readings, closer to a table than to a marketing page — so
  // only where the heading lives moves, not what it says or what sits under it.
  function section(ctx, title, card) {
    const { h } = ctx;
    return h('div', { class: 'section' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' }, h('h2', {}, title)),
      card));
  }
  function txLink(ctx, signature) {
    const { h } = ctx;
    const short = signature && signature.length > 14 ? signature.slice(0, 8) + '…' + signature.slice(-6) : (signature || '—');
    const href = signature && ctx.explorer && typeof ctx.explorer.tx === 'function' ? ctx.explorer.tx(signature) : '';
    return href ? h('a', { class: 'mono', href, target: '_blank', rel: 'noopener' }, short) : h('span', { class: 'mono' }, short);
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

  // ============================================================================ the coin's chain read
  /**
   * The coin's pump.fun bonding curve: how much of its sale is done, the SOL it has raised and
   * whether it has graduated to PumpSwap. One account read; the treasury figures come from the
   * files the keepers write, not from a second live read.
   */
  async function readChain(ctx, cfg) {
    const S = Sol();
    const curve = await S.programAddress(['bonding-curve', S.addressBytes(cfg.coin)], S.PROGRAMS.pump);
    const info = await ctx.rpc('getAccountInfo', [curve.address, { encoding: 'base64', commitment: 'confirmed' }]);
    const value = info && info.value;
    if (!value || value.owner !== S.PROGRAMS.pump) throw new Error('the coin has no pump.fun bonding curve');
    const b = S.decodeBase64(value.data[0]);
    if (b.length < 49 || BONDING_CURVE_DISC.some((x, i) => b[i] !== x)) throw new Error('the bonding curve could not be read');
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u64 = (at) => view.getBigUint64(at, true);
    const remaining = u64(24);
    const sold = remaining >= CURVE_SALE_UNITS ? 0n : CURVE_SALE_UNITS - remaining;
    return {
      curve: curve.address,
      raisedSol: Number(u64(32)) / 1e9,
      progress: Number(sold * 10000n / CURVE_SALE_UNITS) / 10000,
      graduated: b[48] === 1,
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
   * off. The payer only blocks the last step (paying wholesale for a profile the provider has
   * already agreed to issue), which is real but narrower, so a failing check there is a warn.
   */
  function checkRow(ctx, label, wiringName, check, critical) {
    // Keep the network partner private on the public status page. Wallet and store implementation
    // names are harmless operational detail, but the fulfilment source is intentionally unnamed.
    const name = label === 'Provider' ? 'Network partner' : (wiringName ? label + ' · ' + wiringName : label);
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
    if (claimsErr) return statusRow(ctx, 'warn', 'Fee keeper', 'data/claims.json has not been built yet (' + claimsErr + '). Run node scripts/claim.js.');
    const list = Array.isArray(claims) ? claims : [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last) return statusRow(ctx, launched ? 'warn' : 'ok', 'Fee keeper', launched ? 'no fee collection has been recorded yet' : 'nothing to collect yet — the coin has not launched');
    const ageS = Date.now() / 1000 - Number(last.at);
    const fresh = Number.isFinite(ageS) && ageS <= CLAIM_STALE_S;
    return statusRow(ctx, fresh ? 'ok' : 'warn', 'Fee keeper',
      (fresh ? 'last collected ' : 'stale — last collected ') + fmtAgo(ageS) + ' ago (' + fmtSol(numOr(last.sol)) + ')');
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
   * Eight rows, always in this order: the coin, provider, Lightning wallet, store and redemption come from
   * ./api/status; the indexer, claim keeper and funding keeper come from the data files the
   * keepers themselves write, so they still say something true when the health endpoint cannot be
   * reached at all — a static host with no functions deployed still has an indexer, a claim log
   * and a funding log.
   */
  function healthStrip(ctx, d) {
    const { h } = ctx;
    const rows = h('div', {});
    const preview = !!(d.cfg && d.cfg.brand && !launchedConfig(d.cfg));
    if (d.apiErr) {
      rows.appendChild(preview
        ? statusRow(ctx, '', 'Health check', 'Live service checks begin after launch; this preview is showing catalogue and programme information.')
        : statusRow(ctx, 'warn', 'Health check', './api/status could not be reached (' + d.apiErr + '); the coin, provider, wallet and store rows below depend on it.'));
    } else {
      const api = d.api;
      const cfgReady = !!(api.ready && api.ready.config);
      const launched = !!(api.config && api.config.launched);
      rows.appendChild(statusRow(ctx, cfgReady ? 'ok' : 'off', 'The coin', launched ? 'launched' : 'not launched yet'));
      rows.appendChild(checkRow(ctx, 'Provider', api.wiring && api.wiring.provider, api.checks && api.checks.provider, true));
      rows.appendChild(checkRow(ctx, 'Lightning wallet', api.wiring && api.wiring.payer, api.checks && api.checks.payer, false));
      rows.appendChild(checkRow(ctx, 'Store', api.wiring && api.wiring.store, api.checks && api.checks.store, true));
      const redemption = api.redemption;
      if (!launched) {
        rows.appendChild(statusRow(ctx, redemption && redemption.enabled === true ? 'warn' : 'off', 'Data redemption',
          redemption && redemption.enabled === true ? 'Prelaunch. Purchases are enabled, but token launch is still pending.'
            : redemption && redemption.enabled === false ? 'Prelaunch. Data redemption is disabled.' : 'Prelaunch. Data redemption is unavailable.'));
      } else if (redemption && redemption.enabled === false) {
        rows.appendChild(statusRow(ctx, 'off', 'Data redemption', 'Purchases are paused. Account and installation reads remain available.'));
      } else if (redemption && redemption.enabled === true && redemption.ready === true) {
        rows.appendChild(statusRow(ctx, 'ok', 'Data redemption', 'Purchases are enabled. Funding and service checks passed.'));
      } else if (redemption && redemption.enabled === true && redemption.ready === false) {
        rows.appendChild(statusRow(ctx, 'warn', 'Data redemption', 'Purchases are enabled, but the service is not ready. Check funding and dependencies.'));
      } else {
        rows.appendChild(statusRow(ctx, 'warn', 'Data redemption', 'Redemption readiness is unavailable. Purchases have not been verified.'));
      }
    }
    const launchedLocally = launchedConfig(d.cfg);
    rows.appendChild(preview && !d.allowErr
      ? statusRow(ctx, '', 'Indexer', 'not active until coin launch')
      : indexerRow(ctx, d.allow, d.allowErr));
    rows.appendChild(claimKeeperRow(ctx, launchedLocally, d.claims, d.claimsErr));
    rows.appendChild(fundKeeperRow(ctx, launchedLocally, d.fund, d.fundErr));
    return h('div', { class: 'card status-strip' }, rows);
  }

  // ============================================================================ 2. the coin
  function coinSection(ctx, cfg, cfgErr, launched, chain, chainErr) {
    const { h, notice } = ctx;
    const card = h('div', { class: 'card' });
    if (cfgErr) { card.appendChild(notice('site/config/esim.json could not be read (' + cfgErr + ').', 'warn')); return card; }
    if (!launched) {
      const brand = brandOf(cfg);
      card.appendChild(h('p', { class: 'small' },
        (brand ? brand.name : 'This carrier') + ' has not launched its coin yet. OTT will launch on ', h('a', { href: 'https://pump.fun', target: '_blank', rel: 'noopener' }, 'pump.fun'), ', paired with SOL.'));
      return card;
    }
    const links = h('p', { class: 'small' },
      h('a', { href: typeof ctx.launchpad === 'function' ? ctx.launchpad(cfg.coin) : 'https://pump.fun/coin/' + cfg.coin, target: '_blank', rel: 'noopener' }, 'OTT on pump.fun ↗'), ' · ',
      h('a', { href: ctx.explorer && typeof ctx.explorer.token === 'function' ? ctx.explorer.token(cfg.coin) : 'https://solscan.io/token/' + cfg.coin, target: '_blank', rel: 'noopener' }, 'Token on Solscan ↗'));
    if (chainErr) { card.append(notice('Could not read the bonding curve: ' + chainErr, 'warn'), links); return card; }
    const c = chain || {};
    card.appendChild(h('div', { class: 'stat-grid' },
      fmtTile(ctx, 'Curve sold', numOr(c.progress), (n) => Math.round(n * 100) + '%', c.graduated ? 'the curve sold out and graduated' : 'of the bonding curve’s tokens, toward graduation', 'could not be read from the curve', 'chart'),
      // A graduated curve holds no SOL: it all moved into the PumpSwap pool, so "0 SOL" would misread.
      c.graduated ? ctx.tile('Raised', 'In the pool', 'the curve’s SOL moved into PumpSwap at graduation', 'coins')
        : fmtTile(ctx, 'Raised', numOr(c.raisedSol), fmtSol, 'SOL in the bonding curve', 'could not be read from the curve', 'coins'),
      ctx.tile('Creator fee', c.graduated ? '0.05–0.95%' : '0.30%', c.graduated ? 'of each PumpSwap trade, by market cap' : 'of each trade on the curve, to the treasury', 'flame'),
      ctx.tile('Graduated', c.graduated === null || c.graduated === undefined ? '—' : (c.graduated ? 'Yes' : 'Not yet'),
        c.graduated === null || c.graduated === undefined ? 'could not be read from the curve' : (c.graduated ? 'trading has moved to PumpSwap' : 'still selling on the bonding curve'), 'shield')));
    const frac = Number.isFinite(c.progress) ? Math.min(1, c.progress) : null;
    const fill = h('i', {});
    fill.style.setProperty('--w', String(frac || 0));
    card.appendChild(h('div', { class: 'data-progress' },
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Curve progress'),
        h('span', { class: 'num' }, frac === null ? '—' : Math.round(frac * 100) + '%')),
      h('div', { class: 'sp-bar dp-bar' }, fill),
      h('p', { class: 'small', style: 'margin-top:10px' }, frac === null ? 'Progress could not be read from the curve.' : c.graduated ? 'Graduated: OTT now trades on PumpSwap.' : Math.round(frac * 100) + '% of the way to graduation.')));
    card.appendChild(links);
    return card;
  }

  // ============================================================================ 3. the pool
  function poolSection(ctx, d) {
    const { h, notice } = ctx;
    const card = h('div', { class: 'card' });
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
        Number.isFinite(sats) ? sats.toLocaleString('en-US') + ' sats' : 'in the Lightning wallet that pays our network partner',
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
    if (claimsErr) return notice('The fee collection log has not been built yet (data/claims.json: ' + claimsErr + '). Run node scripts/claim.js.', 'warn');
    const list = Array.isArray(claims) ? claims : [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last) return h('p', { class: 'small' }, launched ? 'No creator fees have been collected yet.' : 'Nothing to collect yet — the coin has not launched.');
    return h('p', { class: 'small' },
      'Last fee collection: ', h('b', {}, fmtSol(numOr(last.sol)) + (Number.isFinite(numOr(last.usd)) ? ' (' + fmtMoney(numOr(last.usd)) + ')' : '')),
      ' on ' + (fmtDate(last.at) || 'an unrecorded date') + ' — ', last.tx ? txLink(ctx, last.tx) : 'no transaction recorded', '.');
  }
  function fundFact(ctx, launched, fund, fundErr) {
    const { h, notice } = ctx;
    if (fundErr) return notice('The funding log has not been built yet (data/funding.json: ' + fundErr + '). Run node scripts/fund.js.', 'warn');
    const list = Array.isArray(fund) ? fund : [];
    const last = list.length ? list[list.length - 1] : null;
    if (!last) return h('p', { class: 'small' }, launched ? 'No funding run has been recorded yet.' : 'Nothing to fund yet — the coin has not launched.');
    return h('p', { class: 'small' },
      'Last funding run: ', h('b', {}, (Number.isFinite(numOr(last.solSent)) ? fmtSol(numOr(last.solSent)) + ' · ' : '') + fmtMoney(numOr(last.amountUsd)) + ' → ' + numOr(last.sats).toLocaleString('en-US') + ' sats'),
      ' on ' + (fmtDate(last.at) || 'an unrecorded date') + ' — ' + String(last.status || 'unknown'),
      last.fixedFloatOrder ? ' · order ' + last.fixedFloatOrder : '', '.');
  }
  function treasurySection(ctx, launched, d) {
    const { h } = ctx;
    const { treas, treasErr, claims, claimsErr, fund, fundErr } = d;
    const t = treas || {};
    const card = h('div', { class: 'card' });
    card.appendChild(h('div', { class: 'stat-grid' },
      fmtTile(ctx, 'Uncollected fees', numOr(t.claimableUsd), fmtMoney,
        Number.isFinite(numOr(t.claimableSol)) ? fmtSol(numOr(t.claimableSol)) + ' waiting in pump.fun’s creator vaults' : 'waiting in pump.fun’s creator vaults',
        treasErr ? 'data/treasury.json: ' + treasErr : 'not read yet', 'wallet'),
      fmtTile(ctx, 'Treasury wallet', numOr(t.walletUsd), fmtMoney,
        Number.isFinite(numOr(t.walletSol)) ? fmtSol(numOr(t.walletSol)) + ' before it is moved to the pool' : 'SOL held before it is moved to the pool',
        treasErr ? 'data/treasury.json: ' + treasErr : 'not read yet', 'coins')));
    if (isAddress(t.treasury)) {
      card.appendChild(h('p', { class: 'small' }, 'Treasury: ', h('a', { class: 'mono', href: ctx.explorer && typeof ctx.explorer.account === 'function' ? ctx.explorer.account(t.treasury) : 'https://solscan.io/account/' + t.treasury, target: '_blank', rel: 'noopener' }, shortAddr(t.treasury)), '.'));
    }
    card.appendChild(claimFact(ctx, launched, claims, claimsErr));
    card.appendChild(fundFact(ctx, launched, fund, fundErr));
    return card;
  }

  // ============================================================================ 5. the programme
  /**
   * The week itself: the budget last week's collected fees funded, how many members share it,
   * this week's join amount and the week the numbers are for — read straight from
   * allowances.json. The table is this week's members by allowance.
   */
  function programmeSection(ctx, d) {
    const { h, notice } = ctx;
    const card = h('div', { class: 'card' });
    if (d.allowErr) {
      card.appendChild(notice('The indexer has not run yet (data/allowances.json: ' + d.allowErr + '). Run node scripts/allowances.js.', 'warn'));
      return card;
    }
    const allow = d.allow || {};
    const wallets = allow.wallets || {};
    const entries = Object.entries(wallets);
    const budgetUsd = numOr(allow.budgetUsd);
    const holders = Number.isFinite(Number(allow.holders)) ? Number(allow.holders) : entries.length;
    const weekLabel = fmtDate(allow.weekStart);
    const requirement = allow.membership && allow.membership.requirement;
    const joinTokens = requirement && Number(requirement.burnTokens) > 0 ? Number(requirement.burnTokens) : 0;
    const joinUsd = joinTokens && Number(requirement.priceUsd) > 0 ? joinTokens * Number(requirement.priceUsd) : NaN;

    card.appendChild(h('div', { class: 'stat-grid' },
      ctx.tile('This week’s budget', fmtMoney(budgetUsd), allow.budgetSource ? String(allow.budgetSource) : 'last week’s collected creator fees', 'coins'),
      ctx.tile('Members sharing', String(holders), holders === 1 ? 'member in this week’s split' : 'members in this week’s split', 'shield'),
      ctx.tile('Join amount', joinTokens ? fmtTokens(joinTokens) + ' OTT' : '—', joinTokens ? 'about ' + fmtMoney(joinUsd) + ', set for this week' : 'set at the first ledger update of the week', 'flame'),
      ctx.tile('Week', weekLabel || '—', weekLabel ? 'the week this allowance is for' : 'not recorded in allowances.json', 'clock')));
    if (!entries.length) { card.appendChild(h('p', { class: 'small' }, 'No member is in this week’s split yet.')); return card; }

    const top = entries.slice().sort((a, b) => numOr(b[1] && b[1].allowanceUsd) - numOr(a[1] && a[1].allowanceUsd)).slice(0, 5);
    const tbody = h('tbody', {});
    for (const [addr, w] of top) {
      const tokens = unitsFromDecimalStr(w && w.tokens, allow.decimals);
      tbody.appendChild(h('tr', {},
        h('td', { class: 'mono' }, shortAddr(addr)),
        h('td', { class: 'num' }, Number.isFinite(tokens) ? fmtTokens(tokens) + ' OTT' : '—'),
        h('td', { class: 'num' }, fmtSharePct(w && w.share)),
        h('td', { class: 'num' }, fmtMoney(numOr(w && w.allowanceUsd) || 0))));
    }
    card.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'status-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Wallet'), h('th', { class: 'num' }, 'Holds'), h('th', { class: 'num' }, 'Share'), h('th', { class: 'num' }, 'Allowance'))),
      tbody)));
    // Five rows is a sample, not the ledger. The whole of it lives on its own route rather than
    // growing this card, because concentration and a search over every wallet are a page's worth of
    // page and this one already carries five other readings.
    if (entries.length > top.length) {
      card.appendChild(h('p', { class: 'small' },
        h('a', { class: 'status-more-link', href: '#/holders' },
          'See all ' + entries.length + ' members →')));
    }
    return card;
  }

  // ============================================================================ 6. the catalogue
  function catalogueSection(ctx, cfg, cfgErr) {
    const { h, notice } = ctx;
    const card = h('div', { class: 'card' });
    if (cfgErr) { card.appendChild(notice('site/config/esim.json could not be read (' + cfgErr + ').', 'warn')); return card; }
    const list = packagesOf(cfg);
    if (!list.length) { card.appendChild(notice('No packages are configured yet in config/esim.json.', 'warn')); return card; }
    const placeCount = placeSlugs(cfg).length;
    const cheap = cheapestEntry(cfg);
    const lo = cheapest(cfg), hi = dearest(cfg);
    const catDate = cfg.catalogueAt ? fmtCatalogueDate(cfg.catalogueAt) : null;
    card.appendChild(h('div', { class: 'stat-grid' },
      ctx.tile('Network partner', list.length ? 'Connected' : '—', 'private eSIM fulfilment', 'shield'),
      ctx.tile('Places', String(placeCount), placeCount === 1 ? 'place on the menu' : 'places on the menu', 'chart'),
      ctx.tile('Packages', String(list.length), 'fixed-size eSIM packages', 'coins'),
      ctx.tile('Cheapest', cheap ? fmtPrice(cheap.priceUsd) : '—', cheap ? cheap.name + ' · ' + (Number(cheap.gb) || 1) + ' GB' : 'no packages configured', 'wallet'),
      ctx.tile('Per gigabyte', lo ? fmtPrice(perGb(lo)) + (hi && hi !== lo ? ' – ' + fmtPrice(perGb(hi)) : '') : '—',
        lo ? (hi && hi !== lo ? lo.name + ' to ' + hi.name : lo.name) : 'no packages configured', 'flame'),
      ctx.tile('Catalogue date', catDate || '—', catDate ? 'when the provider catalogue was last read' : 'not recorded in config/esim.json', 'clock')));
    return card;
  }

  // ============================================================================ the page
  async function render(view, ctx) {
    const { h, notice } = ctx;
    const label = h('div', { class: 'label' }, 'NETWORK STATUS');
    const lede = h('p', { class: 'page-lede' },
      'The coin, the pool, the treasury, the programme and the catalogue — read straight off the same files and the same Solana accounts every other route uses, with whatever is missing named instead of hidden.');
    view.appendChild(h('div', { class: 'page-head' }, label, h('h1', {}, 'Everything, and whether it is running.'), lede));

    const body = h('div', {}, notice('Reading the network…', 'plain'));
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
      if (ctx.isCurrent && !ctx.isCurrent()) return;
      const [cfgRaw, cfgErr] = settle(cfgR);
      const [allow, allowErr] = settle(allowR);
      const [treas, treasErr] = settle(treasR);
      const [claims, claimsErr] = settle(claimsR);
      const [fund, fundErr] = settle(fundR);
      const [api, apiErr] = settle(apiR);
      const cfg = cfgRaw || {};

      const brand = brandOf(cfg);
      if (brand) label.textContent = (brand.name + ' · NETWORK STATUS').toUpperCase();

      // A partial config counts as not launched, the same rule site/esim.js uses.
      const launched = launchedConfig(cfg);
      let chain = null, chainErr = null;
      if (launched) {
        try { chain = await readChain(ctx, cfg); }
        catch (e) { chainErr = errText(e); }
      }
      if (ctx.isCurrent && !ctx.isCurrent()) return;

      clear(body);
      body.appendChild(h('div', { class: 'status-summary' },
        h('span', { class: 'state-pill' }, launched ? 'PROGRAMME CONFIGURED' : 'PRELAUNCH'),
        h('p', {}, launched
          ? 'The programme has launched. Check the health rows below for current funding and service availability.'
          : 'OT+T has not launched. The destination catalogue is a preview; weekly credit and redemptions are not available yet.')));
      body.appendChild(section(ctx, 'Health', healthStrip(ctx, { cfg, api, apiErr, allow, allowErr, claims, claimsErr, fund, fundErr })));
      body.appendChild(section(ctx, 'The coin', coinSection(ctx, cfg, cfgErr, launched, chain, chainErr)));
      body.appendChild(section(ctx, 'The pool', poolSection(ctx, { treas, treasErr, api, apiErr })));
      body.appendChild(section(ctx, 'The treasury', treasurySection(ctx, launched, { treas, treasErr, claims, claimsErr, fund, fundErr })));
      body.appendChild(section(ctx, 'The programme', programmeSection(ctx, { allow, allowErr })));
      body.appendChild(section(ctx, 'The catalogue', catalogueSection(ctx, cfg, cfgErr)));
    } catch (e) {
      // Every expected failure is handled above, source by source; this is only a backstop against
      // a bug in this file itself, so the page still says something honest instead of going blank.
      clear(body);
      body.appendChild(notice('This page hit a problem building itself: ' + errText(e), 'error'));
    }
  }

  window.WhateverStatus = { render };
})();
