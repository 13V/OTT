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
  const exchangeWireSvg = (vertical) => {
    const path = vertical
      ? 'M100 100C100 180 154 160 154 230S54 270 54 330S100 345 100 370C100 440 155 435 155 505S53 542 53 604S100 616 100 640C100 708 154 700 154 775S54 814 54 875S100 892 100 910'
      : 'M205 270H415C455 270 444 338 490 338S519 270 565 270H950C1100 270 1168 270 1168 375V578Q1168 615 1130 615H70Q32 615 32 656V855Q32 894 76 894H415C455 894 444 962 490 962S519 894 565 894H1000';
    return `<svg class="ott-wire-${vertical ? 'vertical' : 'horizontal'}" viewBox="0 0 ${vertical ? '200 1000' : '1200 1200'}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d="${path}" class="ott-wire-shadow"/>
      <path d="${path}" class="ott-wire-cord"/>
      <path d="${path}" class="ott-wire-highlight"/>
      <path d="${path}" pathLength="1000" class="ott-wire-signal"/>
    </svg>`;
  };

  function hero(h, launched, cfg, network) {
    const ticker = String(cfg.brand?.ticker || 'OTT');
    const knownNetwork = Number(network?.chainId) === 4663;
    return h('section', { class: 'ott-hero section' }, h('div', { class: 'ott-hero-inner wrap' },
      h('div', { class: 'ott-hero-copy' },
        h('p', { class: 'ott-company-name' }, 'ONCHAIN TELEPHONE + TELEGRAPH'),
        h('h1', { class: 'ott-hero-title' }, h('span', {}, 'A memecoin '), h('span', {}, 'with a '), h('span', {}, 'data plan.')),
        h('p', { class: 'ott-hero-sub' }, 'Weekly data credit for eligible OTT holders.', h('br'), 'At home or abroad. Funded by creator tax.'),
        h('div', { class: 'ott-hero-actions' },
          h('a', { class: 'ott-primary-action', href: launched ? '#/data' : '#/app' }, launched ? 'Check my credit' : 'Explore the app'),
          h('a', { class: 'ott-text-action', href: '#how-it-works' }, 'How it works ↗')),
        h('p', { class: 'ott-hero-note' }, launched ? 'Weekly credit depends on collected fees and your eligible OTT balance.' : 'Prelaunch. Explore plans and sample eSIM setup without a wallet. Weekly credit and redemption are not available yet.')),
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
        h('a', { class: 'ott-token-rules', href: '#/about' }, 'Token & credit rules ↗'))));
  }

  function journey(h, launched) {
    const stations = [
      ['trading', 'OTT trades fund the data.', 'Creator tax collected on OTT trades pays for mobile data. Trading itself does not earn data credit.', 'AT HOME'],
      ['budget', 'The weekly budget is set.', 'Last week’s collected tax pays for this week’s data budget. He checks the new budget over breakfast.', 'OVER BREAKFAST'],
      ['share', 'He checks his weekly credit.', 'At the weekly balance check, his share of eligible OTT determines how much data credit he receives.', 'BEFORE TAKE-OFF'],
      ['connection', 'He gets online in Tokyo.', 'He can use available credit to choose a travel eSIM. Then he can check directions, message friends and find the next stop.', 'ON ARRIVAL'],
    ];
    return h('section', { class: 'section ott-journey', id: 'how-it-works' }, h('div', { class: 'wrap' },
      sectionHead(h, 'HOW IT WORKS', 'From a trading screen to a Tokyo street.', 'Follow one OTT holder from home to Tokyo. Creator tax collected on OTT trades funds his weekly data credit.'),
      h('div', { class: 'ott-journey-ledger', 'aria-hidden': 'true' }, h('span', {}, 'OT+T / THE WEEKLY EXCHANGE'), h('span', {}, 'FROM HOME TO TOKYO')),
      h('div', { class: 'ott-wire-map', role: 'list', 'aria-label': 'How creator tax becomes mobile data' },
        (() => { const wire = h('div', { class: 'ott-wire', 'aria-hidden': 'true' }); wire.innerHTML = exchangeWireSvg(false) + exchangeWireSvg(true); return wire; })(),
        stations.map(([kind, name, caption, chapter], i) => {
          const graphic = h('div', { class: 'ott-station-graphic ott-station-' + kind, 'aria-hidden': 'true' },
            image(h, 'journey-' + kind + '-world', '', { width: '1024', height: '1024', loading: 'lazy' }));
          return h('div', { class: 'ott-station', role: 'listitem' },
            h('span', { class: 'ott-station-number' }, '0' + (i + 1) + ' / ' + chapter), graphic,
            h('div', { class: 'ott-station-copy' }, h('h3', {}, name), h('p', {}, caption)));
        })),
      h('p', { class: 'ott-journey-note' }, launched ? 'Funding and eligibility vary each week.' : 'Prelaunch: no weekly holder credit has been published.', ' ',
        h('a', { href: '#/about' }, 'Read the allocation rules ↗'))));
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
        h('figcaption', {}, launched ? 'Choose a country or region above to see available plans.' : 'Catalogue preview. Weekly credit and redemption are not available yet.')));
    const planDetails = h('details', { class: 'ott-plan-details' },
      h('summary', {}, 'View available plans'),
      h('div', { class: 'ott-plan-details-inner' },
        h('label', { for: 'plan-place' }, 'Available plans for'), placeSelect,
        empty, grid,
        h('p', { class: 'ott-credit-explain' }, 'Prices show the data credit required for a package. Buying OTT does not guarantee a fixed allowance.'),
        h('p', { class: 'ott-prelaunch-explain' }, launched ? 'Check your available credit and redeem in My data.' : 'Catalogue preview. Weekly credit and redemption are not available yet.')));

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

  function allocation(h) {
    const budget = h('input', { id: 'ott-example-budget', type: 'number', min: '0', step: 'any', value: '1000', inputmode: 'decimal', 'aria-describedby': 'ott-allocation-disclaimer ott-example-error' });
    const share = h('input', { id: 'ott-example-share', type: 'number', min: '0', max: '100', step: 'any', value: '1', inputmode: 'decimal', 'aria-describedby': 'ott-allocation-disclaimer ott-example-share-help ott-example-error' });
    const result = h('output', { class: 'ott-allocation-result', for: 'ott-example-budget ott-example-share', 'aria-label': 'Illustrative mobile-data credit', 'aria-live': 'polite' }, '$10.00');
    const budgetReadout = h('strong', { class: 'ott-allocation-budget' }, '$1,000.00');
    const shareReadout = h('strong', { class: 'ott-allocation-percentage' }, '1%');
    const explanation = h('p', { class: 'ott-allocation-explanation' });
    const error = h('p', { id: 'ott-example-error', class: 'ott-example-error', role: 'status' });
    const formatBudget = (value) => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const formatShare = (value) => value.toLocaleString('en-US', { maximumFractionDigits: 12 });
    function calculate() {
      const b = Number(budget.value), s = Number(share.value);
      const credit = b * (s / 100);
      const valid = budget.value.trim() !== '' && share.value.trim() !== '' && Number.isFinite(b) && Number.isFinite(s) && Number.isFinite(credit) && b >= 0 && s >= 0 && s <= 100;
      error.textContent = valid ? '' : 'Enter a budget of $0 or more and a share from 0% to 100%.';
      budget.setAttribute('aria-invalid', String(!valid && (budget.value.trim() === '' || !Number.isFinite(b) || b < 0)));
      share.setAttribute('aria-invalid', String(!valid && (share.value.trim() === '' || !Number.isFinite(s) || s < 0 || s > 100)));
      result.textContent = valid ? money(credit) : '—';
      budgetReadout.textContent = valid ? formatBudget(b) : '—';
      shareReadout.textContent = valid ? formatShare(s) + '%' : '—';
      explanation.textContent = valid
        ? 'In this example, ' + formatShare(s) + '% of the ' + formatBudget(b) + ' weekly budget gives you ' + money(credit) + ' in data credit.'
        : 'Enter a budget and a share to see the example credit.';
    }
    budget.addEventListener('input', calculate);
    share.addEventListener('input', calculate);
    const example = h('details', { class: 'ott-example' },
      h('summary', {}, 'Change the example'),
      h('div', { class: 'ott-example-inner' },
        h('div', { class: 'ott-example-fields' },
          h('div', {}, h('label', { for: 'ott-example-budget' }, 'Weekly data budget ($)'), budget),
          h('div', {}, h('label', { for: 'ott-example-share' }, 'Share of eligible OTT (%)'), share)),
        error,
        h('p', { id: 'ott-example-share-help', class: 'ott-example-help' }, 'Your share is your OTT balance divided by all eligible OTT at the weekly balance check.')));
    calculate();
    return h('section', { class: 'section ott-allocation' }, h('div', { class: 'wrap' },
      sectionHead(h, 'HOW YOUR DATA CREDIT WORKS', 'Your OTT share sets your data credit.', 'The weekly budget is split between eligible holders. Hold 1% of eligible OTT at the weekly balance check and you receive 1% of that budget as data credit.'),
      h('div', { class: 'ott-allocation-diagram' },
        h('p', { id: 'ott-allocation-disclaimer', class: 'ott-example-label' }, 'Example only. This is not your balance or a forecast.'),
        h('div', { class: 'ott-allocation-composition' },
          h('div', { class: 'ott-allocation-pass' },
            h('div', { class: 'ott-allocation-pass-head' }, h('strong', {}, 'OT+T'), h('span', {}, 'EXAMPLE DATA PASS')),
            h('div', { class: 'ott-allocation-steps', role: 'list', 'aria-label': 'Example calculation: weekly data budget multiplied by your eligible OTT share equals data credit' },
              h('div', { class: 'ott-allocation-readout', role: 'listitem' }, budgetReadout, h('span', {}, 'Weekly data budget')),
              h('span', { class: 'ott-allocation-connector', 'aria-hidden': 'true' }, '×'),
              h('div', { class: 'ott-allocation-readout', role: 'listitem' }, shareReadout, h('span', {}, 'Your share of eligible OTT')),
              h('span', { class: 'ott-allocation-connector', 'aria-hidden': 'true' }, '='),
              h('div', { class: 'ott-allocation-readout ott-allocation-credit', role: 'listitem' }, result, h('span', {}, 'Data credit for eSIMs at home or away'))),
            h('span', { class: 'ott-allocation-pass-stamp', 'aria-hidden': 'true' }, 'EXAMPLE ONLY')),
          h('div', { class: 'ott-allocation-art', 'aria-hidden': 'true' }, image(h, 'journey-share-world', '', { width: '1024', height: '1024', loading: 'lazy' }))),
        explanation),
      example,
      h('p', { class: 'ott-allocation-note' }, 'The budget and your share can change each week. Unused credit expires at the weekly reset. ',
        h('a', { href: '#/about' }, 'Read the full rules ↗'))));
  }

  function faq(h, launched) {
    const entries = [
      ['Can I use it at home?', 'Yes. Choose a package for your home country, such as United States for use in the US. You’ll need an unlocked phone that supports eSIMs. These packages include mobile data. Calls and SMS are not included.'],
      ['Is the data free?', 'If your available OTT credit covers the package, there is no extra payment for it. Creator tax pays for the weekly budget, and your eligible OTT holding determines your share. Buying OTT costs money and does not guarantee a fixed data allowance.'],
      ['How is weekly credit calculated?', 'Last week’s collected creator tax pays for this week’s data budget. Your credit depends on your OTT balance at the weekly snapshot and the circulating supply used for that week. The budget and eligibility can change.'],
      ['Does buying OTT give me credit immediately?', 'No. Credit is calculated at the weekly snapshot using the funded budget and your eligible balance. Buying today does not establish eligibility for the current week.'],
      ['What happens to unused credit?', 'Unused credit expires at the weekly reset. It does not roll over. An eSIM you have already redeemed follows its own expiry rules.'],
      ['Will an eSIM work on my phone?', 'Your phone must be unlocked and support eSIMs. Check your device and carrier settings before redeeming. Once a package is issued, you still need to install and activate it.'],
      ['When does a redeemed package expire?', 'Each package has its own validity and activation rules. Check those details before redeeming. We are still confirming how long an unused package can wait before activation.'],
      ['What if I don’t have enough credit?', 'You can choose a smaller package if your credit covers it and the data pool has enough funding. Otherwise, you’ll need to wait until the available credit or funding changes.'],
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

  function animateJourney(section) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((items) => {
      if (!items.some((item) => item.isIntersecting)) return;
      section.classList.add('ott-wire-active');
      observer.disconnect();
    }, { threshold: 0.25 });
    observer.observe(section);
    return () => observer.disconnect();
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
    const story = [journey(h, launched), catalogueSection, travelSection, allocation(h), window.WhateverAccountPreview.render(h, launched), faq(h, launched)];
    story.forEach((section) => view.appendChild(section));
    const cleanup = animateJourney(story[0]);
    if (cleanup && ctx.isCurrent) {
      const lifecycle = new MutationObserver(() => { if (!ctx.isCurrent()) { cleanup(); lifecycle.disconnect(); } });
      lifecycle.observe(view, { childList: true });
    }
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
