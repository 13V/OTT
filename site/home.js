'use strict';
/**
 * The public OTT story in the house's DeFi layout: a join card beside the otter in the hero, the
 * token's facts as a stats strip, the terms as stat cards and a checklist, the coverage directory
 * as an asset list, and the otter's scenes in rounded panels. Account balances and redemption
 * remain in esim.js.
 */
(function () {
  const money = (value) => Number.isFinite(Number(value)) ? '$' + Number(value).toFixed(2) : '—';
  const art = (name) => './assets/story/' + name + '.webp';
  const entries = (cfg) => Array.isArray(cfg.packages) ? cfg.packages.filter((p) => p && p.code && p.slug && Number(p.gb) > 0 && Number(p.priceUsd) > 0) : [];
  const places = (cfg) => [...new Map(entries(cfg).map((p) => [p.slug, { slug: p.slug, name: p.name, kind: p.kind, flag: p.flag || '' }])).values()];
  const at = (cfg, slug) => entries(cfg).filter((p) => p.slug === slug).sort((a, b) => Number(a.gb) - Number(b.gb));
  // A section's opening: a short label in the accent, the title, and one paragraph.
  const sectionHead = (h, label, title, body, id) => h('div', { class: 'ott-section-head' },
    h('span', { class: 'ott-eyebrow' }, label), h('h2', id ? { id } : {}, title), body ? h('p', {}, body) : null);
  // A scene's caption: one line of the story.
  const caption = (h, ...line) => h('figcaption', {}, ...line);
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
      welcomeGb: welcomeOk ? Number(w.gb) : null,
      welcomeDays: welcomeOk ? Number(w.days) : null,
      welcomeMax: welcomeOk ? money(w.maxUsd) : null,
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
  function snapshotCountdown(h, tag = 'dd') {
    const week = window.WhateverData;
    const value = h(tag, { class: 'ott-countdown' });
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
   * Joining at a glance, laid out like a swap: what you burn above, what you get below, and the
   * terms underneath. It is a summary, not a form: the burn itself only happens in My data.
   */
  function joinCard(h, launched, cfg) {
    const t = terms(cfg);
    const leg = (label, amount, token, hint, mod) => h('div', { class: 'ott-swap-leg' + (mod ? ' ott-swap-leg--' + mod : '') },
      h('span', { class: 'ott-swap-label' }, label),
      h('div', { class: 'ott-swap-row' }, h('strong', { class: 'ott-swap-amount' }, amount), token),
      hint ? h('span', { class: 'ott-swap-hint' }, hint) : null);
    const token = (mark, name) => h('span', { class: 'ott-swap-token' }, h('span', { class: 'ott-swap-icon ott-swap-icon--' + mark, 'aria-hidden': 'true' }), name);
    const detail = (term, value) => h('div', {}, h('dt', {}, term), h('dd', {}, value));
    return h('div', { class: 'ott-swap', role: 'group', 'aria-labelledby': 'ott-swap-title' },
      h('div', { class: 'ott-swap-head' },
        h('strong', { id: 'ott-swap-title' }, 'Joining, at a glance'),
        h('span', { class: 'ott-swap-state' + (launched ? ' is-open' : '') }, launched ? 'Open' : 'At launch')),
      h('div', { class: 'ott-swap-legs' },
        leg('You burn', t.burnUsd ? '≈ $' + t.burnUsd : 'Once', token('coin', 'OTT'), 'Once, priced in OTT each Monday.'),
        h('div', { class: 'ott-swap-arrow', 'aria-hidden': 'true' }, h('span', {}, '↓')),
        leg('You get', t.welcomeGb ? t.welcomeGb + ' GB' : 'eSIM', token('sim', 'eSIM'),
          t.welcomeDays ? 'Any ' + t.welcomeDays + '-day plan up to ' + t.welcomeMax + '.' : 'A welcome eSIM.', 'get')),
      h('dl', { class: 'ott-swap-details' },
        t.shareNumber !== null ? detail('Members’ weekly share', t.shareNumber + '% of fees') : null,
        t.cap ? detail('Most one member gets', t.cap + '× the average') : null,
        detail('Next snapshot', snapshotCountdown(h, 'span'))),
      h('a', { class: 'ott-swap-cta', href: launched ? '#/data' : '#trust' }, launched ? 'Join in My data' : 'What happens when you burn'));
  }

  function hero(h, launched, cfg, network) {
    const ticker = String(cfg.brand?.ticker || 'OTT');
    const knownNetwork = network?.chain === 'solana';
    const fact = (term, ...value) => h('div', { class: 'ott-token-fact' }, h('dt', {}, term), h('dd', {}, ...value));
    return h('section', { class: 'ott-hero section' }, h('div', { class: 'ott-hero-inner wrap' },
      h('div', { class: 'ott-hero-copy' },
        h('h1', { class: 'ott-hero-title' }, h('span', {}, 'A memecoin '), h('span', {}, 'with a '), h('span', { class: 'ott-hero-accent' }, 'data plan.')),
        h('p', { class: 'ott-hero-sub' }, h('span', {}, 'Burn once to get your eSIM.'), ' ', h('span', {}, 'Trading fees fund your data.')),
        h('div', { class: 'ott-hero-actions' },
          h('a', { class: 'ott-primary-action', href: launched ? '#/data' : '#/app' }, launched ? 'Check my credit' : 'Explore the app'),
          h('a', { class: 'ott-secondary-action', href: '#how-it-works' }, 'How it works ', h('span', { 'aria-hidden': 'true' }, '↓'))),
        h('p', { class: 'ott-hero-note' }, launched ? 'Burn ' + terms(cfg).burn + ' once to join. Members claim a welcome eSIM and share each week’s data budget.'
          : 'Enrolment is not open until launch. Then, burn ' + terms(cfg).burn + ' once for your first eSIM. Explore plans and sample eSIM setup without a wallet.')),
      h('div', { class: 'ott-hero-art hero-visual' },
        h('figure', { class: 'ott-hero-scene' },
          image(h, 'otter-hero', 'Our otter, in its red neckerchief, floats on its back in a night harbour, reading a phone that lights up its face.', { width: '1120', height: '1394', fetchpriority: 'high' }),
          h('figcaption', { class: 'ott-hero-caption' }, h('strong', {}, 'Touch grass. Stay online.'))),
        joinCard(h, launched, cfg)),
      // The token's line, as an exchange shows it: what it is, where it trades, the programme's
      // state, and the time left until the week's snapshot.
      h('div', { class: 'ott-token-strip', 'aria-label': 'OTT token information' },
        h('dl', { class: 'ott-token-facts' },
          fact('Token', h('span', { class: 'ott-token-mark', 'aria-hidden': 'true' }), ticker),
          knownNetwork ? fact('Network', 'Solana · pump.fun') : null,
          fact('Programme', h('a', { href: '#/status', class: 'ott-token-status' + (launched ? ' is-live' : '') }, h('span', { class: 'ott-status-dot', 'aria-hidden': 'true' }), launched ? 'Programme configured' : 'Prelaunch', h('span', { 'aria-hidden': 'true' }, ' →'))),
          fact('Next snapshot', snapshotCountdown(h, 'span'))),
        h('a', { class: 'ott-token-rules', href: '#/about' }, 'Membership & data rules →'))));
  }

  /**
   * The programme's terms: the four figures that decide what a member gets as stat cards, and the
   * rest as a checklist. Every figure comes from the published config; a figure it lacks leaves
   * its card or line out.
   */
  function figures(h, cfg) {
    const t = terms(cfg);
    const w = cfg.membership && cfg.membership.welcome;
    const stat = (label, value, body, mod) => h('article', { class: 'ott-stat' + (mod ? ' ott-stat--' + mod : '') },
      h('span', { class: 'ott-stat-label' }, label), h('strong', { class: 'ott-stat-value' }, value), h('p', {}, body));
    const line = (title, value, body) => h('li', {}, h('span', { class: 'ott-check', 'aria-hidden': 'true' }),
      h('div', {}, h('strong', {}, title, h('span', {}, value)), h('p', {}, body)));
    return h('section', { class: 'section ott-figures', 'aria-labelledby': 'ott-figures-title' }, h('div', { class: 'wrap' },
      h('div', { class: 'ott-figures-top' },
        sectionHead(h, 'The programme in numbers', 'Fees in. Data out.', 'Every figure comes from the published configuration. None of it is a forecast.', 'ott-figures-title'),
        h('div', { class: 'ott-stats' },
          t.shareNumber !== null ? stat('Members’ share', t.shareNumber + '%', 'of the fees collected the week before becomes this week’s member data budget.', 'accent') : null,
          stat('Creator fee', CURVE_FEE, 'pump.fun pays it to the OT+T treasury on every bonding-curve trade. After graduation it is 0.95%, falling to 0.05% as the market cap grows.'),
          t.burnUsd ? stat('To join', '≈ $' + t.burnUsd, 'of OTT, burned once. The amount in OTT is set each Monday from the price. Membership doesn’t expire.') : null,
          t.cap ? stat('Share cap', t.cap + '×', 'the average share: the most any one member gets in a week.') : null)),
      h('div', { class: 'ott-terms' },
        h('div', { class: 'ott-terms-head' }, h('h3', {}, 'And the rest of the terms.'), h('a', { href: '#/about' }, 'All the rules →')),
        h('ul', { class: 'ott-checklist' },
          t.shareNumber !== null ? line('Reserve', (100 - t.shareNumber) + '%', 'stays in the pool for welcome eSIMs and payment costs.') : null,
          t.welcomeShort ? line('Welcome eSIM', t.welcomeShort, 'Any plan up to ' + money(w.maxUsd) + ', paid from the reserve, not from weekly credit.') : null,
          line('Credit expiry', 'Weekly', 'Unused credit expires at the Monday snapshot, 00:00 UTC. The money stays in the pool.'),
          line('Settlement', 'Lightning', 'The backend buys each eSIM from the supplier over Bitcoin Lightning.')))));
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
    // A place without a flag (a region, or a country with no artwork) gets its initials instead,
    // the way a token list shows a coin it has no logo for.
    const avatar = (p) => flag(p) || h('span', { class: 'cov-initials', 'aria-hidden': 'true' }, p.name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase());
    // A place's plans in one line: how many, and the smallest to largest size.
    const span = (slug) => {
      const items = at(cfg, slug);
      if (!items.length) return { count: '', sizes: '' };
      const low = Number(items[0].gb), high = Number(items[items.length - 1].gb);
      return { count: items.length + (items.length === 1 ? ' plan' : ' plans'), sizes: (low === high ? low : low + '–' + high) + ' GB' };
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
      const sizes = span(state.slug);
      coverageResult.replaceChildren(
        h('div', { class: 'ott-coverage-result-top' },
          place ? avatar(place) : null,
          h('span', { class: 'ott-coverage-result-label' }, items.length ? (launched ? 'Supported coverage' : 'Coverage preview') : 'Coverage check')),
        h('h3', {}, destination),
        h('p', { class: 'ott-coverage-availability' }, items.length ? items.length + ' package' + (items.length === 1 ? '' : 's') + ' available for use in ' + destination + '.' : 'No packages are configured yet.'),
        ...(place?.kind === 'region' && selected?.regions ? [h('p', { class: 'ott-coverage-region' }, 'Regional coverage: ' + selected.regions + '.')] : []),
        ...(items.length ? [h('dl', { class: 'ott-coverage-figures' },
          h('div', {}, h('dt', {}, 'Sizes'), h('dd', {}, sizes.sizes)),
          h('div', {}, h('dt', {}, 'From'), h('dd', {}, money(Math.min(...items.map((p) => Number(p.priceUsd)))) + ' credit')))] : []));
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
    // The directory, laid out like a wallet's asset list: every covered place once, its flag as the
    // token icon, its plans on the right. Each row is a button that only changes the preview above;
    // the extra figures are hidden from the button's name, which stays the place's name.
    const board = h('div', { class: 'ott-airport-board' },
      h('div', { class: 'ott-airport-board-head' },
        h('div', {}, h('span', { class: 'ott-airport-board-label' }, 'The directory'), h('h3', {}, 'Where to next?')),
        h('p', {}, 'Choose a place to check its plans.')),
      ['country', 'region'].map((kind) => {
        const group = list.filter((p) => p.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
        if (!group.length) return null;
        return h('div', { class: 'ott-coverage-group ott-coverage-' + kind + '-group' },
          h('h4', {}, kind === 'country' ? 'Countries' : 'Regions'),
          h('div', { class: 'cov-grid' }, group.map((p) => {
            const plans = span(p.slug);
            return h('button', { type: 'button', class: 'cov-item', onclick: () => choose(p.slug) },
              avatar(p),
              h('span', { class: 'cov-text' }, h('span', { class: 'cov-name' }, p.name), h('span', { class: 'cov-kind', 'aria-hidden': 'true' }, kind === 'country' ? 'Country' : 'Region')),
              h('span', { class: 'cov-plans', 'aria-hidden': 'true' }, h('b', {}, plans.sizes), h('span', {}, plans.count)),
              h('span', { class: 'cov-arrow', 'aria-hidden': 'true' }, '→'));
          })));
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
          sectionHead(h, 'Coverage', 'Use it at home. Take it with you.', 'Use your data credit at home or on your next trip.'),
          h('div', { class: 'ott-coverage-shortcuts', 'aria-label': 'Featured destinations' }, shortcuts.map((p) => h('a', { href: '#plans', class: 'ott-destination-shortcut', 'data-slug': p.slug }, p.name))),
          h('div', { class: 'search-shell' }, h('label', { for: 'destination-search' }, 'Where will you use your data?'), h('div', { class: 'search-control' }, search, clearButton), results),
          h('p', { class: 'ott-coverage-device' }, 'Use a compatible, unlocked phone that supports eSIMs. Mobile data only; calls and SMS are not included.')),
        h('div', { class: 'ott-coverage-panel' },
          h('figure', { class: 'ott-coverage-art ott-story-figure' },
            image(h, 'otter-pier', 'Our otter strolls along a lamp-lit pier at night, phone in paw, with the city lights across the water.', { width: '1440', height: '956', loading: 'lazy' }),
            caption(h, h('strong', {}, list.length + ' places'), ' in the current catalogue, at home and away.')),
          coverageResult)),
      planDetails, details));
    root.chooseDestination = choose;
    return root;
  }

  /** What a week of data is for, in three moments. */
  function travel(h) {
    const step = (number, text) => h('li', { class: 'ott-benefit' }, h('span', {}, number), h('p', {}, text));
    return h('section', { class: 'section ott-travel' }, h('div', { class: 'wrap' },
      h('div', { class: 'ott-travel-grid' },
        h('figure', { class: 'ott-travel-image ott-story-figure' },
          image(h, 'otter-tokyo', 'Our otter, backpack on, checks a glowing map at a busy Tokyo crossing at night.', { width: '1440', height: '956', loading: 'lazy' }),
          h('figcaption', { class: 'ott-scene-caption' }, h('strong', {}, 'Shibuya, Tokyo'), h('span', {}, 'Off the plane and already online.'))),
        h('div', { class: 'ott-travel-copy' }, sectionHead(h, 'Travel', 'Find your way in a new city.'),
          h('ol', { class: 'ott-travel-steps' },
            step('1', 'Find your hotel.'),
            step('2', 'Tell them you’ve landed.'),
            step('3', 'Pick somewhere for dinner.'))))));
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
          sectionHead(h, 'Questions', 'Before you connect.'),
          h('p', { class: 'ott-faq-more' }, 'The full rules, figures and limits are published. ', h('a', { href: '#/about' }, 'Read the programme rules →'))),
        h('div', { class: 'faq-list' }, entries.map(([q, a]) => h('details', { class: 'faq-item' }, h('summary', {}, q), h('p', {}, a))))),
      // The closing banner: the brand's red aura, and the two otters who hold paws so they don't
      // drift apart.
      h('div', { class: 'ott-close' },
        h('figure', { class: 'ott-close-art' }, image(h, 'otter-paws', 'Two otters asleep on their backs under the stars, holding paws so they don’t drift apart.', { width: '1040', height: '1300', loading: 'lazy' }),
          caption(h, 'Sea otters hold paws while they sleep.')),
        h('div', { class: 'ott-close-copy' },
          h('span', { class: 'ott-eyebrow' }, launched ? 'Membership open' : 'Opens at launch'),
          h('h2', {}, 'Where are you heading?'),
          h('p', { class: 'ott-close-story' }, 'So they don’t drift apart. That’s the whole idea: wherever you go, stay connected.'),
          h('div', { class: 'ott-close-actions' }, h('a', { class: 'ott-primary-action ott-primary-action--light', href: '#plans' }, 'Explore destinations'),
            h('a', { class: 'ott-secondary-action', href: launched ? '#/data' : '#/app' }, launched ? 'Open My data' : 'Explore the app'))))));
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
    const story = [figures(h, cfg), membership.journey(h, cfg, launched), membership.allocation(h, cfg), catalogueSection, travel(h),
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
