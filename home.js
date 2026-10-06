'use strict';
/** The public OTT story. Account balances and redemption remain in esim.js. */
(function () {
  const money = (value) => Number.isFinite(Number(value)) ? '$' + Number(value).toFixed(2) : '—';
  const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
  const asset = (name) => './assets/ott/' + name + '.webp';
  const entries = (cfg) => Array.isArray(cfg.packages) ? cfg.packages.filter((p) => p && p.code && p.slug && Number(p.gb) > 0 && Number(p.priceUsd) > 0) : [];
  const places = (cfg) => [...new Map(entries(cfg).map((p) => [p.slug, { slug: p.slug, name: p.name, kind: p.kind, flag: p.flag || '' }])).values()];
  const at = (cfg, slug) => entries(cfg).filter((p) => p.slug === slug).sort((a, b) => Number(a.gb) - Number(b.gb));
  const sectionHead = (h, label, title, body) => h('div', { class: 'ott-section-head' },
    h('span', { class: 'ott-eyebrow' }, label), h('h2', {}, title), body ? h('p', {}, body) : null);
  const image = (h, name, alt, attrs = {}) => h('img', { src: asset(name), alt, decoding: 'async', ...attrs });
  const clayLabel = (h, value, attrs = {}) => window.WhateverClayType?.label(h, value, attrs) || h('span', attrs, value);
  function hero(h, launched, cfg, network) {
    const ticker = String(cfg.brand?.ticker || 'OTT');
    const knownNetwork = Number(network?.chainId) === 4663;
    return h('section', { class: 'ott-hero section' }, h('div', { class: 'ott-hero-inner wrap' },
      h('div', { class: 'ott-hero-copy' },
        h('p', { class: 'ott-company-name' }, 'ONCHAIN TELEPHONE + TELEGRAPH'),
        h('h1', { class: 'ott-hero-title' }, h('span', {}, 'A memecoin '), h('span', {}, 'with a '), h('span', {}, 'data plan.')),
        h('p', { class: 'ott-hero-sub' }, 'Burn once to get your eSIM.', h('br'), 'Trading fees fund your data.'),
        h('div', { class: 'ott-hero-actions' },
          h('a', { class: 'ott-primary-action', href: launched ? '#/data' : '#/app' }, launched ? 'Check my credit' : 'Explore the app'),
          h('a', { class: 'ott-text-action', href: '#how-it-works' }, 'How it works ↗')),
        h('p', { class: 'ott-hero-note' }, 'Planned membership. Enrolment is not open. Explore plans and sample eSIM setup without a wallet.'),
        h('a', { class: 'ott-hero-trust', href: '#trust' }, 'What needs to be ready before you burn ↗')),
      h('div', { class: 'ott-hero-art hero-visual' },
        h('figure', { class: 'ott-hero-scene' },
          h('figcaption', { class: 'ott-hero-caption' }, image(h, 'hero-touch-grass-lettering', 'Touch Grass, Stay Online.', { width: '1536', height: '768', fetchpriority: 'high' })),
          image(h, 'hero-touch-grass', 'Handmade clay OTT holder touching a tuft of grass with one fingertip while looking at his phone. His dog waits beside him on an orange SIM-shaped grass island.', { width: '1122', height: '1402', fetchpriority: 'high' }),
        )),
      h('div', { class: 'ott-token-strip', 'aria-label': 'OTT token information' },
        h('dl', { class: 'ott-token-facts' },
          h('div', { class: 'ott-token-fact' }, h('dt', {}, 'TOKEN'), h('dd', {}, ticker)),
          knownNetwork ? h('div', { class: 'ott-token-fact' }, h('dt', {}, 'NETWORK'), h('dd', {}, 'Robinhood Chain')) : null,
          h('div', { class: 'ott-token-fact' }, h('dt', {}, 'PROGRAMME'), h('dd', {}, h('a', { href: '#/status', class: 'ott-token-status' }, h('span', { class: 'ott-status-dot', 'aria-hidden': 'true' }), launched ? 'Programme configured' : 'Prelaunch', ' ↗')))),
        h('a', { class: 'ott-token-rules', href: '#/about' }, 'Membership & data rules ↗'))));
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
    const board = h('div', { class: 'ott-airport-board' },
      h('div', { class: 'ott-airport-board-head' },
        h('div', {}, h('span', { class: 'ott-airport-board-label' }, 'OT+T COVERAGE'), h('h3', {}, clayLabel(h, 'Where to next?'))),
        h('p', {}, 'Choose a place to check its plans.')),
      ['country', 'region'].map((kind) => {
        const group = list.filter((p) => p.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
        if (!group.length) return null;
        return h('div', { class: 'ott-coverage-group ott-coverage-' + kind + '-group' },
          h('h4', {}, kind === 'country' ? 'Countries' : 'Regions'),
          h('div', { class: 'cov-grid' }, group.map((p) => h('button', { type: 'button', class: 'cov-item', onclick: () => choose(p.slug) },
            flag(p), clayLabel(h, p.name, { class: 'cov-name' }), h('span', { class: 'cov-arrow', 'aria-hidden': 'true' }, '↗')))));
      }));
    const details = h('details', { class: 'coverage-details ott-coverage-details', id: 'coverage' },
      h('summary', {}, 'See where your data works', h('span', {}, list.length + ' places')),
      h('figure', { class: 'ott-airport-scene' },
        h('div', { class: 'ott-airport-world' },
          h('div', { class: 'ott-airport-backdrop' }, image(h, 'coverage-airport-world', 'Hand-moulded clay airport scene. The same OTT holder stands with his back to us, looking up at a coverage board suspended from the ceiling.', { width: '1536', height: '1024', loading: 'lazy' })), board),
        h('figcaption', {}, launched ? 'Choose a country or region above to see available plans.' : 'Catalogue preview. Membership enrolment and redemption are not available yet.')));
    const planDetails = h('details', { class: 'ott-plan-details' },
      h('summary', {}, 'View available plans'),
      h('div', { class: 'ott-plan-details-inner' },
        h('label', { for: 'plan-place' }, 'Available plans for'), placeSelect,
        empty, grid,
        h('p', { class: 'ott-credit-explain' }, 'Prices show the data credit required for a package. Membership is planned; its allowance will depend on the funded pool and published rules.'),
        h('p', { class: 'ott-prelaunch-explain' }, launched ? 'Check your available prototype credit in My data.' : 'Catalogue preview. Membership enrolment and redemption are not available yet.')));

    const root = h('section', { class: 'section ott-catalogue', id: 'plans' }, h('div', { class: 'wrap' },
      h('div', { class: 'ott-coverage-layout', id: 'plan-options' },
        h('figure', { class: 'ott-everyday-scene' }, image(h, 'everyday-dog-world', 'Hand-moulded clay illustration of the OTT holder walking his dog through his neighbourhood while checking his phone.', { width: '1200', height: '900', loading: 'lazy' }),
          h('figcaption', {}, 'An OTT everyday illustration')),
        h('div', { class: 'ott-coverage-copy' },
          sectionHead(h, 'DATA FOR EVERY DAY', 'Use it at home. Take it with you.', 'Use your data credit at home or on your next trip.'),
          h('div', { class: 'ott-coverage-shortcuts', 'aria-label': 'Featured destinations' }, shortcuts.map((p) => h('a', { href: '#plans', class: 'ott-destination-shortcut', 'data-slug': p.slug }, p.name + ' ↗'))),
          h('div', { class: 'search-shell' }, h('label', { for: 'destination-search' }, 'Where will you use your data?'), h('div', { class: 'search-control' }, search, clearButton), results),
          coverageResult,
          h('p', { class: 'ott-coverage-device' }, 'Use a compatible, unlocked phone that supports eSIMs. Mobile data only; calls and SMS are not included.'))),
      planDetails, details));
    root.chooseDestination = choose;
    return root;
  }

  function travel(h) {
    return h('section', { class: 'section ott-travel' }, h('div', { class: 'wrap' },
      sectionHead(h, 'STAY CONNECTED', 'Find your way in a new city.'),
      h('div', { class: 'ott-travel-grid' },
        h('figure', { class: 'ott-travel-image' },
          image(h, 'shibuya-clay', 'Clay illustration of Shibuya Crossing: a traveller checks his phone in front of the orange OT+T booth, sharply focused as the crowd passes in motion blur.', { width: '1536', height: '1024', loading: 'lazy' }),
          h('figcaption', { class: 'ott-scene-caption' },
            h('strong', {}, 'Shibuya, Tokyo'),
            h('span', {}, 'Maps, messages and a place to eat.'),
            h('small', {}, 'An OTT travel illustration'))),
        h('div', { class: 'ott-travel-copy' },
          h('div', { class: 'ott-benefit' }, h('span', {}, '01'), h('p', {}, 'Find your hotel.')),
          h('div', { class: 'ott-benefit' }, h('span', {}, '02'), h('p', {}, 'Tell them you’ve landed.')),
          h('div', { class: 'ott-benefit' }, h('span', {}, '03'), h('p', {}, 'Pick somewhere for dinner.'))))));
  }

  function faq(h, launched) {
    const entries = [
      ['Can I use it at home?', 'Yes. Choose a package for your home country, such as United States for use in the US. You’ll need an unlocked phone that supports eSIMs. These packages include mobile data. Calls and SMS are not included.'],
      ['How do I get my first eSIM?', 'The planned model is one OTT burn to enrol for membership and receive your first eSIM. Enrolment is not open. The exact burn amount, initial package and membership duration will be published before you commit tokens.'],
      ['Do I burn again for more data?', 'No repeat burn is planned for each top-up. Collected trading fees will fund ongoing member data. A top-up still needs available credit, pool funding and a compatible supplier profile.'],
      ['How much data will I receive?', 'It depends on fees actually collected, the allocation to data, eligible membership numbers and package costs. The calculator is an equal-share example, not a promised balance. The final formula and credit expiry rules are still being finalised.'],
      ['What if the first eSIM cannot be delivered?', 'We plan to hold enrolment tokens in refundable escrow while the first eSIM is awaiting delivery, then finalise the burn after the required issuance check. Escrow, timeout and recovery rules need to be built and reviewed before public enrolment. This protection is not live yet.'],
      ['How can I check where the fees go?', 'We plan to publish fees received, the data allocation, spending, reserves and member count with timestamps. On-chain transactions can link to an explorer. External payment-provider balances and service delivery need clearly labelled reports and verification.'],
      ['Does a burn guarantee data forever?', 'No. The burn is a planned one-time entry cost, not a promise of unlimited or lifetime data. Allowances depend on funding. Membership duration and what happens when fees stop must be stated before enrolment opens.'],
      ['Will an eSIM work on my phone?', 'Your phone must be unlocked and support eSIMs. Check your device and carrier settings before redeeming. Once a package is issued, you still need to install and activate it.'],
      ['When does a redeemed package expire?', 'Each package has its own validity and activation rules. Check those details before redeeming. We are still confirming how long an unused package can wait before activation.'],
      ['What if I don’t have enough credit?', 'Under the planned model, you could choose a smaller package if your allowance covers it and the pool has enough funding. Otherwise, wait for available funding. The app currently offers a sample journey while enrolment stays closed.'],
    ];
    return h('section', { class: 'section ott-faq' }, h('div', { class: 'wrap' },
      sectionHead(h, 'GOOD TO KNOW', 'Before you connect.'),
      h('div', { class: 'ott-faq-layout' },
        h('div', { class: 'faq-list' }, entries.map(([q, a]) => h('details', { class: 'faq-item' }, h('summary', {}, q), h('p', {}, a)))),
        h('figure', { class: 'ott-faq-art', 'aria-hidden': 'true' },
          image(h, 'faq-clay-help', '', { width: '1254', height: '1254', loading: 'lazy' }))),
      h('div', { class: 'ott-close' }, h('h2', {}, 'Where are you heading?'),
        h('div', {}, h('a', { class: 'ott-primary-action', href: '#plans' }, 'Explore destinations'),
          h('a', { class: 'ott-text-action', href: launched ? '#/data' : '#/app' }, launched ? 'Open My data ↗' : 'Explore the app ↗')))));
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
    const launched = isAddress(cfg.coin) && isAddress(cfg.curve) && isAddress(cfg.treasury);
    view.appendChild(hero(h, launched, cfg, ctx.cfg));
    const travelSection = travel(h);
    const catalogueSection = catalogue(h, cfg, launched);
    const membership = window.WhateverMembershipStory;
    const story = [membership.journey(h), membership.allocation(h), catalogueSection, travelSection,
      window.WhateverAccountPreview.render(h, launched), membership.trust(h), faq(h, launched)];
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
