'use strict';
/**
 * OT+T — the Holders route (#/holders): this week's members.
 *
 * The week's ledger in full: every member in this week's split, the OTT it held at the Monday
 * snapshot, its share of all those members' OTT, and the dollars of data allowance it gets after
 * the cap. It is the same file the programme card on #/status reads a top five out of —
 * data/allowances.json, written by scripts/allowances.js — shown whole rather than trimmed.
 *
 * Everything on it is public chain data — members found from their sends to the incinerator,
 * holdings read from their token accounts' own history — so there is nothing here that a block
 * explorer would not also show. What the page never carries is anything from the redemption store:
 * no order, no ICCID and above all no activation code, which only ever travels back to a signed
 * request from the wallet that earned it.
 */
(function () {
  // The same helpers site/esim.js exports and site/status.js already borrows, so all three files
  // read a token amount, a share and a week identically. The fallbacks exist only for the case
  // where this module is somehow loaded without esim.js.
  const WD = window.WhateverData || {};
  const UI = () => window.WhateverUI || null;

  const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '—');
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const errText = (e) => (e && e.message ? e.message : String(e)).slice(0, 200);
  const numOr = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const fmtMoney = (n) => (Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  const fmtDate = (sec) => {
    const n = Number(sec);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
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

  async function loadJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // A long ledger is paged rather than dumped: a launched coin can have thousands of holders, and
  // a table that renders all of them costs a visible stall on a phone for rows nobody scrolled to.
  const PAGE = 100;

  // ============================================================================ the page
  async function render(view, ctx) {
    const { h, notice } = ctx;

    view.appendChild(h('div', { class: 'page-head' },
      h('div', { class: 'label' }, 'OT+T · MEMBERS'),
      h('h1', {}, 'Who shares this week, and what it buys them.'),
      h('p', { class: 'page-lede' },
        'Every member in this week’s split: the OTT it held at Monday’s snapshot, its share of all '
        + 'members’ OTT, and the data allowance that share is worth after the cap. Read from public '
        + 'Solana transactions — the same ledger the status page reads a top five out of.')));

    const body = h('div', {}, notice('Reading the week’s ledger…', 'plain'));
    view.appendChild(body);

    let allow = null, err = null;
    try { allow = await loadJson('./data/allowances.json'); }
    catch (e) { err = errText(e); }

    clear(body);
    if (err) {
      body.appendChild(notice('The indexer has not written a ledger yet (data/allowances.json: ' + err + '). Run node scripts/allowances.js.', 'warn'));
      return;
    }

    allow = allow || {};
    const wallets = allow.wallets && typeof allow.wallets === 'object' ? allow.wallets : {};
    const rows = Object.entries(wallets).map(([addr, w]) => ({
      addr,
      tokens: unitsFromDecimalStr(w && w.tokens, allow.decimals),
      share: numOr(w && w.share),
      allowanceUsd: numOr(w && w.allowanceUsd),
    }));

    body.appendChild(summary(ctx, allow, rows));
    body.appendChild(rows.length ? ledger(ctx, allow, rows) : emptyState(ctx, allow));
  }

  // ============================================================================ the week's header
  function summary(ctx, allow, rows) {
    const { h } = ctx;
    const budgetUsd = numOr(allow.budgetUsd);
    const holders = Number.isFinite(Number(allow.holders)) ? Number(allow.holders) : rows.length;
    const weekLabel = fmtDate(allow.weekStart);
    const memberTokens = unitsFromDecimalStr(allow.memberTokens, allow.decimals);
    const allMembers = allow.members && typeof allow.members === 'object' ? Object.keys(allow.members).length : 0;

    const tiles = h('div', { class: 'stat-grid' },
      ctx.tile('This week’s budget', Number.isFinite(budgetUsd) ? fmtMoney(budgetUsd) : '—',
        allow.budgetSource ? String(allow.budgetSource) : 'last week’s collected creator fees', 'coins'),
      ctx.tile('Members sharing', String(holders),
        holders === 1 ? 'member in this week’s split' : 'members in this week’s split', 'shield'),
      ctx.tile('Members in all', String(allMembers), 'including those who joined since Monday', 'arrows'),
      ctx.tile('Members’ OTT', Number.isFinite(memberTokens) ? fmtTokens(memberTokens) + ' OTT' : '—',
        'held by this week’s members at the snapshot', 'coins'),
      ctx.tile('Week of', weekLabel || '—',
        weekLabel ? 'the week this allowance is for' : 'not recorded in the ledger', 'clock'));

    const card = h('div', { class: 'card' }, tiles);
    const conc = concentration(ctx, rows);
    if (conc) card.appendChild(conc);
    return h('div', { class: 'section' }, h('div', { class: 'wrap' }, card));
  }

  /**
   * How tightly the members' OTT is held. The cap limits what any one member can take, but
   * concentration still decides how the rest is shared, and it is not readable from a top-five
   * table — five rows look much the same whether they hold 9% of it or 90%.
   */
  function concentration(ctx, rows) {
    const { h } = ctx;
    const shares = rows.map((r) => r.share).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => b - a);
    if (shares.length < 2) return null;
    const sum = (n) => shares.slice(0, n).reduce((a, b) => a + b, 0);
    const bands = [['Top 1', 1], ['Top 10', 10], ['Top 50', 50]]
      .filter(([, n]) => n === 1 || shares.length > n / 2);

    return h('div', {},
      h('div', { class: 'divider' }),
      h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Concentration')),
      h('div', { class: 'conc-row' }, bands.map(([label, n]) => {
        const pct = Math.min(1, sum(n));
        return h('div', { class: 'conc-item' },
          h('div', { class: 'conc-label' }, label + ' of ' + Math.min(n, shares.length)),
          h('div', { class: 'conc-bar' }, h('i', { style: 'width:' + (pct * 100).toFixed(2) + '%' })),
          h('div', { class: 'conc-val' }, fmtSharePct(pct) + ' of members’ OTT'));
      })));
  }

  // ============================================================================ the ledger table
  function ledger(ctx, allow, rows) {
    const { h } = ctx;
    const u = UI();
    const me = ctx.currentAccount && ctx.currentAccount() || '';

    const state = { key: 'allowanceUsd', dir: 'desc', q: '', shown: PAGE };

    const tbody = h('tbody', {});
    const count = h('p', { class: 'small holders-count' });
    const more = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { state.shown += PAGE; paint(); } }, 'Show more');

    function visible() {
      const q = state.q.trim().toLowerCase();
      let out = q ? rows.filter((r) => r.addr.toLowerCase().indexOf(q) !== -1) : rows.slice();
      const k = state.key, dir = state.dir === 'desc' ? -1 : 1;
      out.sort((a, b) => {
        if (k === 'addr') return dir * a.addr.localeCompare(b.addr);
        const av = Number.isFinite(a[k]) ? a[k] : -Infinity;
        const bv = Number.isFinite(b[k]) ? b[k] : -Infinity;
        return av === bv ? a.addr.localeCompare(b.addr) : dir * (av - bv);
      });
      return out;
    }

    function paint() {
      const list = visible();
      const page = list.slice(0, state.shown);
      clear(tbody);
      page.forEach((r, i) => {
        const mine = me && r.addr === me;
        tbody.appendChild(h('tr', { class: mine ? 'holder-you' : null },
          h('td', { class: 'holders-rank num' }, String(i + 1)),
          h('td', { class: 'mono' }, shortAddr(r.addr), mine ? h('span', { class: 'holders-you-tag' }, 'you') : null),
          h('td', { class: 'num' }, Number.isFinite(r.tokens) ? fmtTokens(r.tokens) + ' OTT' : '—'),
          h('td', { class: 'num' }, fmtSharePct(r.share)),
          h('td', { class: 'num' }, Number.isFinite(r.allowanceUsd) ? fmtMoney(r.allowanceUsd) : '—')));
      });
      clear(count);
      count.appendChild(document.createTextNode(
        list.length === rows.length
          ? 'Showing ' + page.length + ' of ' + rows.length + (rows.length === 1 ? ' member' : ' members')
          : 'Showing ' + page.length + ' of ' + list.length + ' matching ' + rows.length + ' members'));
      more.hidden = page.length >= list.length;
      if (!list.length) {
        tbody.appendChild(h('tr', {}, h('td', { colspan: '5', class: 'holders-none' }, 'No wallet matches that address.')));
      }
    }

    const columns = [
      { key: 'rank', label: '#', num: true },
      { key: 'addr', label: 'Wallet', sortable: true },
      { key: 'tokens', label: 'Holds', num: true, sortable: true },
      { key: 'share', label: 'Share', num: true, sortable: true },
      { key: 'allowanceUsd', label: 'Allowance', num: true, sortable: true },
    ];

    let thead;
    if (u && u.sortableHeader) {
      const built = u.sortableHeader(columns, (key, dir) => { state.key = key; state.dir = dir; state.shown = PAGE; paint(); });
      thead = built.el;
      if (built.setActive) built.setActive('allowanceUsd', 'desc');
    } else {
      thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : null }, c.label))));
    }

    const tools = h('div', { class: 'holders-tools' });
    if (u && u.searchBox) {
      const box = u.searchBox('Find a wallet address', (v) => { state.q = v || ''; state.shown = PAGE; paint(); });
      tools.appendChild(box.el);
    }
    tools.appendChild(count);

    paint();

    const card = h('div', { class: 'card' },
      tools,
      h('div', { class: 'table-wrap' }, h('table', { class: 'status-table holders-table' }, thead, tbody)),
      h('div', { class: 'holders-more' }, more));

    return h('div', { class: 'section' }, h('div', { class: 'wrap' },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'The week’s ledger')),
      card,
      h('p', { class: 'holders-note' },
        'Holdings are read at Monday 00:00 UTC, not at the moment of redemption — an allowance '
        + 'computed from a live balance could be taken by borrowing a large position, redeeming '
        + 'against it and returning it. No member gets more than the cap. Unspent allowance expires '
        + 'when the week does.')));
  }

  function emptyState(ctx, allow) {
    const { h, notice } = ctx;
    const why = allow.budgetSource ? String(allow.budgetSource) : 'the coin is not launched yet';
    return h('div', { class: 'section' }, h('div', { class: 'wrap' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'No members in this week’s split yet')),
        h('p', { class: 'small' },
          'The ledger is empty: ' + why + '. Once OTT trades and members join, the weekly ledger '
          + 'lists every member who joined before Monday’s snapshot, with what they held then, and '
          + 'this page fills itself from that file — nothing here is stored on top of chain data.'))));
  }

  window.OTTHolders = { render };
})();
