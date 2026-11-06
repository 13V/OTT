'use strict';
/**
 * The public OTT story, told the way a protocol explains itself: what the pool is, the parameters
 * it runs on, the route a trade's fee takes to a phone, and how to check every step. Account
 * balances and redemption remain in esim.js.
 */
(function () {
  const money = (value) => Number.isFinite(Number(value)) ? '$' + Number(value).toFixed(2) : '—';
  const art = (name) => './assets/story/' + name + '.webp';
  const entries = (cfg) => Array.isArray(cfg.packages) ? cfg.packages.filter((p) => p && p.code && p.slug && Number(p.gb) > 0 && Number(p.priceUsd) > 0) : [];
  const places = (cfg) => [...new Map(entries(cfg).map((p) => [p.slug, { slug: p.slug, name: p.name, kind: p.kind, flag: p.flag || '' }])).values()];
  const at = (cfg, slug) => entries(cfg).filter((p) => p.slug === slug).sort((a, b) => Number(a.gb) - Number(b.gb));
  const sectionHead = (h, label, title, body) => h('div', { class: 'ott-section-head' },
    h('span', { class: 'ott-eyebrow' }, label), h('h2', {}, title), body ? h('p', {}, body) : null);
  const image = (h, name, alt, attrs = {}) => h('img', { src: art(name), alt, decoding: 'async', ...attrs });
  // pump.fun's creator fee on a bonding-curve trade, which the treasury collects. It is pump.fun's
  // published rate, not a programme setting, so it is the one figure here not read from the config.
  const CURVE_FEE = '0.30%';
  // The published membership terms from config/esim.json, as phrases and figures. A missing figure
  // leaves its phrase out rather than guessing one.
  function terms(cfg) {
    const m = cfg.membership && typeof cfg.membership === 'object' ? cfg.membership : {};
    const w = m.welcome && typeof m.welcome === 'object' ? m.welcome : null;
    const bps = Number(cfg.budgetBps);
    const share = bps > 0 && bps <= 10000 ? bps / 100 : null;
    const welcomeOk = w && [w.gb, w.days, w.maxUsd].every((v) => Number(v) > 0);
    return {
      // The join amount is set in dollars and turned into OTT each week, so the story quotes dollars.
      burn: Number(m.burnUsd) > 0 ? 'about $' + Number(m.burnUsd) + ' of OTT' : 'OTT',
      burnUsd: Number(m.burnUsd) > 0 ? Number(m.burnUsd) : null,
      welcome: welcomeOk ? 'any ' + Number(w.gb) + ' GB, ' + Number(w.days) + '-day plan up to ' + money(w.maxUsd) : 'a welcome eSIM',
      welcomeShort: welcomeOk ? Number(w.gb) + ' GB · ' + Number(w.days) + ' days' : null,
      cap: Number(m.capMultiple) > 0 ? Number(m.capMultiple) : null,
      share: share !== null ? share + '%' : 'a published share',
      shareNumber: share,
    };
  }

  /** "3d 04h 12m" until a unix time, or "now". */
  function until(target) {
    const left = Math.max(0, Math.floor(target - Date.now() / 1000));
    if (!left) return 'now';
    const d = Math.floor(left / 86400), hr = Math.floor((left % 86400) / 3600), min = Math.floor((left % 3600) / 60);
    return (d ? d + 'd ' : '') + String(hr).padStart(2, '0') + 'h ' + String(min).padStart(2, '0') + 'm';
  }

  /** The weekly snapshot countdown. It stops itself once its element has left the page. */
  function snapshotCountdown(h) {
    const week = window.WhateverData;
    const value = h('dd', { class: 'ott-countdown' });
    if (!week || typeof week.weekOf !== 'function' || typeof week.weekEndOf !== 'function') {
      value.textContent = 'Mondays 00:00 UTC';
      return value;
    }
    const paint = () => {
      const end = week.weekEndOf(week.weekOf(Math.floor(Date.now() / 1000)));
      value.textContent = 'in ' + until(end);
      value.setAttribute('title', 'Next Monday snapshot, 00:00 UTC');
    };
    paint();
    const timer = setInterval(() => { if (!value.isConnected) { clearInterval(timer); return; } paint(); }, 30000);
    return value;
  }

  /**
   * The pool, as its parameters: the hero's card. Every figure comes from the published config,
   * and before launch the card says so instead of showing a balance it does not have.
   */
  function poolCard(h, cfg, launched) {
    const t = terms(cfg);
    const share = t.shareNumber;
    const row = (k, v) => h('div', { class: 'ott-pool-row' }, h('dt', {}, k), typeof v === 'string' ? h('dd', {}, v) : v);
    return h('div', { class: 'ott-pool-card', role: 'group', 'aria-label': 'The OTT data pool' },
      h('div', { class: 'ott-pool-head' },
        h('div', { class: 'ott-pool-id' },
          h('span', { class: 'ott-pool-icon', 'aria-hidden': 'true' }),
          h('div', {}, h('strong', {}, 'OTT Data Pool'), h('span', {}, 'Solana · pump.fun'))),
        h('span', { class: 'ott-pool-state' + (launched ? ' is-live' : '') }, launched ? 'Live' : 'Prelaunch')),
      h('div', { class: 'ott-pool-headline' },
        h('span', { class: 'ott-pool-k' }, 'Members’ share of fees'),
        h('strong', { class: 'ott-pool-big' }, share !== null ? String(share) : '—', share !== null ? h('small', {}, '%') : null),
        h('span', { class: 'ott-pool-sub' }, 'of last week’s collected creator fees, split by holdings')),
      share !== null ? h('div', { class: 'ott-pool-split', 'aria-hidden': 'true' },
        h('i', { style: '--w:' + share / 100 }), h('i', { style: '--w:' + (100 - share) / 100 })) : null,
      share !== null ? h('div', { class: 'ott-pool-legend' },
        h('span', {}, h('b', { class: 'is-accent' }), 'Members ' + share + '%'),
        h('span', {}, h('b', { class: 'is-cool' }), 'Reserve ' + (100 - share) + '%')) : null,
      h('dl', { class: 'ott-pool-rows' },
        t.burnUsd ? row('Join', '~$' + t.burnUsd + ' burn, once') : null,
        t.welcomeShort ? row('Welcome eSIM', t.welcomeShort) : null,
        t.cap ? row('Share cap', t.cap + '× the average') : null,
        row('Settles over', 'Bitcoin Lightning'),
        row('Unused credit', 'Expires weekly'),
        row('Next snapshot', snapshotCountdown(h))),
      h('div', { class: 'ott-pool-route', 'aria-hidden': 'true' },
        ['Trade', 'Fees', 'Pool', 'eSIM'].map((step, i) => [i ? h('i') : null, h('span', {}, step)])));
  }

  function hero(h, launched, cfg, network) {
    const ticker = String(cfg.brand?.ticker || 'OTT');
    const knownNetwork = network?.chain === 'solana';
    return h('section', { class: 'ott-hero section' }, h('div', { class: 'ott-hero-inner wrap' },
      h('div', { class: 'ott-hero-copy' },
        h('p', { class: 'ott-company-name' }, h('span', { class: 'ott-company-dot', 'aria-hidden': 'true' }), 'ONCHAIN TELEPHONE + TELEGRAPH'),
        h('h1', { class: 'ott-hero-title' }, h('span', {}, 'A memecoin '), h('span', {}, 'with a '), h('span', { class: 'ott-hero-accent' }, 'data plan.')),
        h('p', { class: 'ott-hero-sub' }, 'Burn once to get your eSIM.', h('br'), 'Trading fees fund your data.'),
        h('div', { class: 'ott-hero-actions' },
          h('a', { class: 'ott-primary-action', href: launched ? '#/data' : '#/app' }, launched ? 'Check my credit' : 'Explore the app'),
          h('a', { class: 'ott-text-action', href: '#how-it-works' }, 'How it works ↗')),
        h('p', { class: 'ott-hero-note' }, launched ? 'Burn ' + terms(cfg).burn + ' once to join. Members claim a welcome eSIM and share each week’s data budget.'
          : 'Enrolment is not open until launch. Then, burn ' + terms(cfg).burn + ' once for your first eSIM. Explore plans and sample eSIM setup without a wallet.'),
        h('a', { class: 'ott-hero-trust', href: '#trust' }, 'What happens when you burn ↗')),
      h('div', { class: 'ott-hero-art hero-visual' },
        h('figure', { class: 'ott-hero-scene' },
          image(h, 'otter-hero', 'Our otter, in its signal-orange neckerchief, floats on its back in a night harbour, reading a phone that lights up its face.', { width: '1120', height: '1394', fetchpriority: 'high' }),
          h('figcaption', { class: 'ott-hero-caption' }, h('span', {}, 'MEET THE OTTER'), h('strong', {}, 'Touch grass. Stay online.')))),
      poolCard(h, cfg, launched),
      h('div', { class: 'ott-token-strip', 'aria-label': 'OTT token information' },
        h('dl', { class: 'ott-token-facts' },
          h('div', { class: 'ott-token-fact' }, h('dt', {}, 'TOKEN'), h('dd', {}, ticker)),
          knownNetwork ? h('div', { class: 'ott-token-fact' }, h('dt', {}, 'NETWORK'), h('dd', {}, 'Solana · pump.fun')) : null,
          h('div', { class: 'ott-token-fact' }, h('dt', {}, 'PROGRAMME'), h('dd', {}, h('a', { href: '#/status', class: 'ott-token-status' }, h('span', { class: 'ott-status-dot', 'aria-hidden': 'true' }), launched ? 'Programme configured' : 'Prelaunch', ' ↗')))),
        h('a', { class: 'ott-token-rules', href: '#/about' }, 'Membership & data rules ↗'))));
  }

  /** The protocol in four numbers, each with what it means in one line. */
  function parameters(h, cfg) {
    const t = terms(cfg);
    const cell = (value, unit, label, note) => h('div', { class: 'ott-param', role: 'listitem' },
      h('strong', { class: 'ott-param-value' }, value, unit ? h('small', {}, unit) : null),
      h('span', { class: 'ott-param-label' }, label),
      h('p', {}, note));
    return h('section', { class: 'section ott-params', 'aria-label': 'Programme parameters' }, h('div', { class: 'wrap' },
      h('div', { class: 'ott-params-grid', role: 'list' },
        cell(CURVE_FEE, null, 'Creator fee', 'pump.fun pays it to the OT+T treasury on every bonding-curve trade.'),
        t.shareNumber !== null ? cell(t.shareNumber + '/' + (100 - t.shareNumber), null, 'Members / reserve', 'How each week’s collected fees divide between members’ data and the reserve.') : null,
        t.burnUsd ? cell('$' + t.burnUsd, null, 'One burn to join', 'Priced in OTT each Monday. Membership doesn’t expire.') : null,
        t.cap ? cell(t.cap, '×', 'Share cap', 'The most any member gets each week, against the average share.') : null)));
  }

  function catalogue(h, cfg, launched, onChoose) {
    const list = places(cfg);
    const shortcuts = ['united-states', 'japan', 'europe'].map((slug) => list.find((p) => p.slug === slug)).filter(Boolean);
    if (!shortcuts.length) shortcuts.push(...list.slice(0, 3));
    const flagCodes = new Set(['us', 'gb', 'de', 'fr', 'es', 'it', 'pt', 'gr', 'tr', 'ae', 'jp', 'sg', 'th', 'vn', 'id', 'in', 'au', 'mx', 'br', 'ca']);
    const flag = (p) => {
      const points = Array.from(p.flag || '').map((c) => c.codePointAt(0));
      const code = points.length === 2 && points.every((n) => n >= 0x1f1e6 && n <= 0x1f1ff)
        ? points.map((n) => String.fromCharCode(n - 0x1f1e6 + 97)).join('') : '';
      return flagCodes.has(code) ? h('img', { class: 'cov-flag', src: './assets/flags/' + code + '.svg', width: '24', height: '18', alt: '', 'aria-hidden': 'true', loading: 'lazy' }) : null;
    };
    const first = list.find((p) => p.slug === 'united-states') || list.find((p) => p.slug === 'japan') || list[0] || null;
    const state = { slug: first?.slug || '', code: '' };
    const placeSelect = h('select', { id: 'plan-place', class: 'ott-place-select', 'aria-label': 'Available plans for' },
      h('option', { value: '' }, 'Choose a covered place'),
      list.filter((p) => p.kind === 'region').length ? h('optgroup', { label: 'Regions' }, list.filter((p) => p.kind === 'region').map((p) => h('option', { value: p.slug }, p.name))) : null,
      list.filter((p) => p.kind === 'country').length ? h('optgroup', { label: 'Countries' }, list.filter((p) => p.kind === 'country').map((p) => h('option', { value: p.slug }, p.name))) : null);
    const search = h('input', { type: 'search', id: 'destination-search', class: 'destination-search', placeholder: 'Search a country or region', autocomplete: 'off', 'aria-controls': 'ott-coverage-search-results' });
    const results = h('div', { id: 'ott-coverage-search-results', class: 'destination-results', 'aria-live': 'polite', hidden: true });
    const coverageResult = h('div', { class: 'ott-coverage-result', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const empty = h('p', { class: 'ott-package-empty', hidden: true }, 'No packages are configured for this destination yet.');
    const grid = h('div', { class: 'plan-grid ott-plan-grid' });
    const clearButton = h('button', { type: 'button', class: 'ott-clear-search', onclick: () => { search.value = ''; paintResults(); search.focus(); } }, 'Clear');

    function paintResults() {
      results.replaceChildren();
      const q = search.value.trim().toLocaleLowerCase();
      if (!q) { results.hidden = true; return; }
      results.hidden = false;
      const matches = list.filter((p) => p.name.toLocaleLowerCase().includes(q));
      if (!matches.length) { results.appendChild(h('p', { class: 'destination-empty' }, 'No matching place in the current catalogue. Try a country or region.')); return; }
      matches.forEach((p) => results.appendChild(h('button', { type: 'button', class: 'destination-result', onclick: () => choose(p.slug) },
        h('span', {}, p.name), h('small', {}, p.kind === 'region' ? 'Region' : 'Country'))));
    }

    function paint() {
      const items = at(cfg, state.slug);
      const selected = items.find((p) => p.code === state.code) || items.find((p) => Number(p.gb) === 5) || items[0] || null;
      state.code = selected?.code || '';
      placeSelect.value = state.slug;
      grid.replaceChildren();
      empty.hidden = !!items.length;
      items.forEach((p) => {
        const active = selected && p.code === selected.code;
        grid.appendChild(h('div', { class: 'plan-card' + (active ? ' featured' : '') },
          h('div', { class: 'plan-destination' }, p.name + ' / ' + (p.kind === 'region' ? 'REGION' : 'COUNTRY')),
          h('h3', { class: 'plan-size' }, p.gb + ' GB'),
          h('div', { class: 'plan-term' }, p.days + ' days of data'),
          h('div', { class: 'plan-credit-label' }, 'DATA CREDIT REQUIRED'),
          h('div', { class: 'plan-price' }, money(p.priceUsd)),
          h('div', { class: 'plan-meta' }, h('span', {}, p.regions || p.name)),
          h('a', { href: launched ? '#/data' : '#/status', class: 'btn btn-sm plan-cta', onclick: () => window.WhateverData?.selectPackage(p.code) }, launched ? 'Select this plan' : 'Check launch status')));
      });
      const place = list.find((p) => p.slug === state.slug);
      const destination = place?.name || 'Choose a covered place';
      coverageResult.replaceChildren(
        h('span', { class: 'ott-coverage-result-label' }, items.length ? (launched ? 'SUPPORTED COVERAGE' : 'COVERAGE PREVIEW') : 'COVERAGE CHECK'),
        h('h3', {}, destination),
        h('p', { class: 'ott-coverage-availability' }, items.length ? items.length + ' package' + (items.length === 1 ? '' : 's') + ' available for use in ' + destination + '.' : 'No packages are configured yet.'),
        ...(place?.kind === 'region' && selected?.regions ? [h('p', { class: 'ott-coverage-region' }, 'Regional coverage: ' + selected.regions + '.')] : []));
      onChoose?.(state.slug, destination, selected);
    }

    function choose(slug) {
      if (!list.some((p) => p.slug === slug)) return;
      state.slug = slug;
      state.code = '';
      search.value = '';
      paintResults();
      paint();
      document.getElementById('plans')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    }
    placeSelect.addEventListener('change', () => choose(placeSelect.value));
    search.addEventListener('input', paintResults);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { search.value = ''; paintResults(); }
      if (e.key === 'Enter') { const match = list.find((p) => p.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())); if (search.value.trim() && match) { e.preventDefault(); choose(match.slug); } }
    });
    state.slug = first?.slug || '';
    paint();
    // A departures board: every covered place, in the protocol's mono, each one a button that
    // only changes the coverage preview above.
    const board = h('div', { class: 'ott-airport-board' },
      h('div', { class: 'ott-airport-board-head' },
        h('div', {}, h('span', { class: 'ott-airport-board-label' }, 'OT+T COVERAGE'), h('h3', {}, 'Where to next?')),
        h('p', {}, 'Choose a place to check its plans.')),
      ['country', 'region'].map((kind) => {
        const group = list.filter((p) => p.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
        if (!group.length) return null;
        return h('div', { class: 'ott-coverage-group ott-coverage-' + kind + '-group' },
          h('h4', {}, kind === 'country' ? 'Countries' : 'Regions'),
          h('div', { class: 'cov-grid' }, group.map((p) => h('button', { type: 'button', class: 'cov-item', onclick: () => choose(p.slug) },
            flag(p), h('span', { class: 'cov-name' }, p.name), h('span', { class: 'cov-arrow', 'aria-hidden': 'true' }, '↗')))));
      }));
    const details = h('details', { class: 'coverage-details ott-coverage-details', id: 'coverage' },
      h('summary', {}, 'See where your data works', h('span', {}, list.length + ' places')),
      h('div', { class: 'ott-airport-scene' }, board,
        h('p', { class: 'ott-airport-note' }, launched ? 'Choose a country or region above to see available plans.' : 'Catalogue preview. Membership enrolment and redemption open at launch.')));
    const planDetails = h('details', { class: 'ott-plan-details' },
      h('summary', {}, 'View available plans'),
      h('div', { class: 'ott-plan-details-inner' },
        h('label', { for: 'plan-place' }, 'Available plans for'), placeSelect,
        empty, grid,
        h('p', { class: 'ott-credit-explain' }, 'Prices show the data credit required for a package. Members’ weekly credit follows their OTT holdings' + (terms(cfg).cap ? ', and no member gets more than ' + terms(cfg).cap + '× the average' : '') + '.'),
        h('p', { class: 'ott-prelaunch-explain' }, launched ? 'Check your membership and weekly credit in My data.' : 'Catalogue preview. Membership enrolment and redemption open at launch.')));

    const root = h('section', { class: 'section ott-catalogue', id: 'plans' }, h('div', { class: 'wrap' },
      h('div', { class: 'ott-coverage-layout', id: 'plan-options' },
        h('div', { class: 'ott-coverage-copy' },
          sectionHead(h, 'DATA FOR EVERY DAY', 'Use it at home. Take it with you.', 'Use your data credit at home or on your next trip.'),
          h('div', { class: 'ott-coverage-shortcuts', 'aria-label': 'Featured destinations' }, shortcuts.map((p) => h('a', { href: '#plans', class: 'ott-destination-shortcut', 'data-slug': p.slug }, p.name + ' ↗'))),
          h('div', { class: 'search-shell' }, h('label', { for: 'destination-search' }, 'Where will you use your data?'), h('div', { class: 'search-control' }, search, clearButton), results),
          coverageResult,
          h('p', { class: 'ott-coverage-device' }, 'Use a compatible, unlocked phone that supports eSIMs. Mobile data only; calls and SMS are not included.')),
        h('figure', { class: 'ott-coverage-art ott-story-figure' },
          image(h, 'otter-pier', 'Our otter strolls along a lamp-lit pier at night, phone in paw, with the city lights across the water.', { width: '1440', height: '956', loading: 'lazy' }),
          h('figcaption', {}, h('strong', {}, list.length + ' places'), h('span', {}, 'in the current catalogue, at home and away')))),
      planDetails, details));
    root.chooseDestination = choose;
    return root;
  }

  /** What a week of data is for, in three moments. */
  function travel(h) {
    return h('section', { class: 'section ott-travel' }, h('div', { class: 'wrap' },
      h('div', { class: 'ott-travel-grid' },
        h('figure', { class: 'ott-travel-image ott-story-figure' },
          image(h, 'otter-tokyo', 'Our otter, backpack on, checks a glowing map at a busy Tokyo crossing at night.', { width: '1440', height: '956', loading: 'lazy' }),
          h('figcaption', { class: 'ott-scene-caption' }, h('strong', {}, 'Shibuya, Tokyo'), h('span', {}, 'Off the plane and already online.'))),
        h('div', { class: 'ott-travel-copy' }, sectionHead(h, 'STAY CONNECTED', 'Find your way in a new city.'),
          h('ol', { class: 'ott-travel-steps' },
          h('li', { class: 'ott-benefit' }, h('span', {}, '01'), h('p', {}, 'Find your hotel.')),
          h('li', { class: 'ott-benefit' }, h('span', {}, '02'), h('p', {}, 'Tell them you’ve landed.')),
          h('li', { class: 'ott-benefit' }, h('span', {}, '03'), h('p', {}, 'Pick somewhere for dinner.')))))));
  }

  function faq(h, launched, cfg) {
    const t = terms(cfg);
    const entries = [
      ['Can I use it at home?', 'Yes. Choose a package for your home country, such as United States for use in the US. You’ll need an unlocked phone that supports eSIMs. These packages include mobile data. Calls and SMS are not included.'],
      ['How do I get my first eSIM?', 'Burn ' + t.burn + ' once to become a member, then claim a welcome eSIM: ' + t.welcome + '. The reserve pays for it, so it doesn’t use weekly credit.' + (launched ? '' : ' Enrolment opens when OTT launches.')],
      ['Do I burn again for more data?', 'No. One burn is your membership. Each week, members share ' + t.share + ' of the previous week’s trading fees as data credit. A top-up still needs available credit, a funded pool and a compatible supplier profile.'],
      ['How much data will I receive?', 'Your weekly credit follows the OTT you hold at the Monday snapshot' + (t.cap ? ', and no member gets more than ' + t.cap + '× the average share' : '') + '. The total depends on fees actually collected, the number of members and package prices. Unused weekly credit expires at the end of the week.'],
      ['What if the first eSIM cannot be delivered?', 'The app offers the burn only while the reserve can pay for a welcome eSIM. If issuing it is delayed, for example when many members join at once, your membership stays on-chain and you can claim the eSIM later without burning again. The burn itself can’t be undone or refunded.'],
      ['How can I check where the fees go?', 'The status page shows fees received, the data budget, spending and the pool balance. Every burn is a public transaction you can check on the explorer. Supplier and payment-provider balances are reported figures and are labelled that way.'],
      ['Does a burn guarantee data forever?', 'No. Membership doesn’t expire, but weekly credit depends on fees actually collected. If trading fees stop, new weekly credit stops too. A burn is an entry cost, not a promise of unlimited data.'],
      ['Will an eSIM work on my phone?', 'Your phone must be unlocked and support eSIMs. Check your device and carrier settings before redeeming. Once a package is issued, you still need to install and activate it.'],
      ['When does a redeemed package expire?', 'Each package has its own validity and activation rules. Check those details before redeeming. We are still confirming how long an unused package can wait before activation.'],
      ['What if I don’t have enough credit?', 'Choose a smaller package your weekly credit covers, or wait for next week’s credit. The pool also needs enough funding when you order.' + (launched ? '' : ' Before launch, the app offers a sample journey.')],
    ];
    return h('section', { class: 'section ott-faq' }, h('div', { class: 'wrap' },
      h('div', { class: 'ott-faq-layout' },
        h('div', { class: 'ott-faq-side' },
          sectionHead(h, 'GOOD TO KNOW', 'Before you connect.'),
          h('p', { class: 'ott-faq-more' }, 'The full rules, figures and limits are published. ', h('a', { href: '#/about' }, 'Read the programme rules ↗'))),
        h('div', { class: 'faq-list' }, entries.map(([q, a]) => h('details', { class: 'faq-item' }, h('summary', {}, q), h('p', {}, a))))),
      h('div', { class: 'ott-close' },
        h('figure', { class: 'ott-close-art' }, image(h, 'otter-paws', 'Two otters asleep on their backs under the stars, holding paws so they don’t drift apart.', { width: '1040', height: '1300', loading: 'lazy' })),
        h('div', { class: 'ott-close-copy' },
          h('span', { class: 'ott-eyebrow' }, launched ? 'MEMBERSHIP OPEN' : 'OPENS AT LAUNCH'),
          h('h2', {}, 'Where are you heading?'),
          h('p', { class: 'ott-close-story' }, 'Sea otters hold paws while they sleep, so they don’t drift apart. That’s the whole idea: wherever you go, stay connected.'),
          h('div', { class: 'ott-close-actions' }, h('a', { class: 'ott-primary-action', href: '#plans' }, 'Explore destinations'),
            h('a', { class: 'ott-text-action', href: launched ? '#/data' : '#/app' }, launched ? 'Open My data ↗' : 'Explore the app ↗'))))));
  }

  async function render(view, ctx) {
    const { h, notice } = ctx;
    let cfg;
    try {
      const response = await fetch('./config/esim.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Catalogue configuration unavailable');
      cfg = await response.json();
    } catch (error) {
      if (ctx.isCurrent && !ctx.isCurrent()) return;
      view.appendChild(h('section', { class: 'section' }, h('div', { class: 'wrap' }, notice('The eSIM catalogue could not be loaded. Please try again.', 'warn'))));
      return;
    }
    if (ctx.isCurrent && !ctx.isCurrent()) return;
    const launched = !!window.OTTSolana && window.OTTSolana.launchedConfig(cfg);
    view.appendChild(hero(h, launched, cfg, ctx.cfg));
    const catalogueSection = catalogue(h, cfg, launched);
    const membership = window.WhateverMembershipStory;
    const story = [parameters(h, cfg), membership.journey(h, cfg, launched), membership.allocation(h, cfg), catalogueSection, travel(h),
      window.WhateverAccountPreview.render(h, launched), membership.trust(h, cfg, launched), faq(h, launched, cfg)];
    story.forEach((section) => view.appendChild(section));
    view.querySelectorAll('.ott-destination-shortcut').forEach((link) => link.addEventListener('click', (event) => {
      event.preventDefault();
      catalogueSection.chooseDestination(link.dataset.slug);
      history.replaceState(null, '', '#plans');
    }));
    const anchor = location.hash.slice(1);
    if (anchor && !anchor.startsWith('/')) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }));
  }

  window.WhateverHome = { render };
})();
