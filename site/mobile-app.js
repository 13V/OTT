'use strict';
/* The holder app shares the website's wallet and redemption code. Preview data lives only in
 * this page's memory; it is never sent to a wallet, a provider or browser storage. */
(function () {
  const SCREENS = ['home', 'plans', 'esims', 'help'];
  const LABELS = { home: 'Home', plans: 'Plans', esims: 'eSIMs', help: 'Help' };
  const PATHS = {
    home: ['M3 10 12 3l9 7', 'M5 9v11h14V9', 'M9 20v-7h6v7'],
    plans: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M3 12h18', 'M12 3c5 5 5 13 0 18-5-5-5-13 0-18'],
    esims: ['M7 3h7l4 4v14H6V3z', 'M9 10h6v7H9z', 'M12 10v7', 'M9 13h6'],
    help: ['M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5', 'M12 17h.01', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18'],
    arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
    download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 16v5h16v-5'],
    check: ['m5 12 4 4L19 6'],
    close: ['m6 6 12 12', 'M6 18 18 6'],
  };
  let preview = false;
  let demoSpent = 5;
  let demoOrders = [];
  let selectedSlug = 'united-states';
  let selectedCode = '';
  let helpPlatform = 'iphone';

  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  const launched = cfg => cfg && ['coin', 'curve', 'treasury'].every(key => /^0x[0-9a-fA-F]{40}$/.test(cfg[key] || ''));
  const go = screen => { location.hash = screen === 'home' ? '#/app' : '#/app/' + screen; };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of PATHS[name] || PATHS.esims) {
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  function action(h, text, onclick, className = 'om-button') {
    return h('button', { type: 'button', class: className, onclick }, text);
  }

  function dialog(h, title, content, source) {
    const id = 'om-dialog-title';
    const sheet = h('dialog', { class: 'om-dialog', 'aria-labelledby': id },
      h('div', { class: 'om-dialog-head' }, h('h2', { id }, title),
        action(h, icon('close'), () => sheet.close(), 'om-icon-button')),
      content);
    sheet.querySelector('button').setAttribute('aria-label', 'Close');
    sheet.addEventListener('close', () => { sheet.remove(); source?.focus(); }, { once: true });
    sheet.addEventListener('click', event => {
      const box = sheet.getBoundingClientRect();
      if (event.target === sheet && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) sheet.close();
    });
    document.body.appendChild(sheet);
    sheet.showModal();
    return sheet;
  }

  async function install(h, source) {
    const state = await window.OTTPwa?.install?.();
    if (!source.isConnected) return;
    if (state && ['accepted', 'dismissed'].includes(state.outcome)) return;
    const instructions = h('div', { class: 'om-guide-copy' },
      h('p', {}, 'Keep OTT on your home screen and open it like an app.'),
      h('h3', {}, 'iPhone'), h('p', {}, 'Open this page in Safari. Tap Share, then Add to Home Screen. If shown, keep Open as Web App switched on.'),
      h('h3', {}, 'Android'), h('p', {}, 'Open this page in Chrome. In the browser menu, choose Install app or Add to Home screen.'),
      h('p', { class: 'om-muted' }, 'Installation options depend on your browser. eSIM installation is a separate step after redeeming a package.'));
    if (state?.outcome === 'installed') instructions.prepend(h('p', { class: 'om-inline-note' }, 'You are already using OTT as an app.'));
    dialog(h, 'Add OTT to your phone', instructions, source);
  }

  async function wallet(ctx, source) {
    const { h } = ctx;
    if (window.ethereum?.request) {
      source.disabled = true;
      try {
        const account = await ctx.connect();
        if (account) { preview = false; if (ctx.isCurrent()) ctx.refresh(); }
      } catch (error) { ctx.toast('Could not connect', error.message || 'Try again in your wallet.', 'error'); }
      finally { if (source.isConnected) source.disabled = false; }
      return;
    }
    const copy = action(h, 'Copy app link', async () => {
      try {
        const url = new URL('./', location.href); url.hash = '/app';
        await navigator.clipboard.writeText(url.href);
        copy.textContent = 'Link copied';
      } catch { copy.textContent = 'Copy the address from your browser'; }
    });
    dialog(h, 'Open OTT in your wallet', h('div', { class: 'om-guide-copy' },
      h('p', {}, 'Use your wallet’s browser to open OTT, then tap Connect wallet.'),
      h('p', { class: 'om-muted' }, 'Direct wallet connection from Safari, Chrome and the home-screen app is still being built. You can explore plans and the setup guide here.'), copy), source);
  }

  function previewBanner(h, ctx) {
    return h('div', { class: 'om-preview-banner', role: 'status' },
      h('span', {}, h('strong', {}, 'App preview'), 'Sample credit and eSIMs. No real orders.'),
      action(h, 'Exit preview', () => { preview = false; demoSpent = 5; demoOrders = []; ctx.refresh(); }, 'om-small-button'));
  }

  function enterPreview(ctx) { preview = true; demoSpent = 5; demoOrders = []; ctx.refresh(); }

  function home(h, ctx, cfg) {
    const active = launched(cfg);
    const account = ctx.currentAccount();
    const credit = h('section', { class: 'om-credit-card', 'aria-label': preview ? 'Sample weekly credit' : 'Weekly credit' },
      h('div', { class: 'om-credit-copy' },
        h('span', { class: 'om-kicker' }, preview ? 'SAMPLE WEEKLY CREDIT' : 'YOUR WEEKLY DATA CREDIT'),
        preview ? h('p', { class: 'om-balance' }, money(Math.max(0, 20 - demoSpent))) : h('h2', {}, active ? 'Your wallet.\nYour connection.' : 'Touch grass.\nStay online.'),
        h('p', { class: 'om-credit-note' }, preview ? 'For your next data package. This is an example balance.' : active ? 'Connect your wallet to check this week’s credit.' : 'Weekly data credit for eligible OTT holders. At home or abroad.'),
        preview ? h('div', { class: 'om-credit-stats' },
          h('span', {}, 'Example allocation', h('strong', {}, '$20.00')),
          h('span', {}, 'Used in preview', h('strong', {}, money(demoSpent)))) : null),
      h('img', { class: 'om-credit-character', src: './assets/ott/hero-touch-grass.webp', alt: 'The OTT clay character touching grass beside his dog.', width: 720, height: 720 }));
    const content = h('div', { class: 'om-home-grid' },
      credit,
      h('section', { class: 'om-panel om-start-panel' },
        h('span', { class: 'om-kicker' }, 'YOUR NEXT CONNECTION'),
        h('h2', {}, preview ? 'Take the app for a spin.' : 'Data for everyday life.'),
        h('p', {}, preview ? 'Choose a package, add it to your sample account and explore how installation works.' : 'Choose where you’ll use your data. Your phone can keep its usual number.'),
        action(h, ['Find a data plan', icon('arrow')], () => go('plans')),
        !preview ? action(h, 'Try the app preview', () => enterPreview(ctx), 'om-text-button') : null),
      h('section', { class: 'om-panel om-wallet-panel' },
        h('div', { class: 'om-panel-heading' }, icon('esims'), h('h2', {}, preview ? 'Sample eSIM' : account ? 'Wallet connected' : 'Your wallet is your account')),
        h('p', {}, preview ? 'Japan · 5 GB · 30 days. Explore the setup guide without issuing an eSIM.' : account ? account : 'Connect to view the credit and eSIMs attached to your wallet.'),
        preview ? action(h, 'View sample eSIMs', () => go('esims'), 'om-text-button') : (() => {
          const button = action(h, account ? 'View My data' : 'Connect wallet', event => account ? go('esims') : wallet(ctx, event.currentTarget), 'om-secondary-button');
          return button;
        })()),
      h('section', { class: 'om-panel om-note-panel' },
        h('span', { class: 'om-kicker' }, 'GOOD TO KNOW'),
        h('h2', {}, 'One setup. More data later.'),
        h('p', {}, 'Where supported, later packages for the same place top up your existing eSIM. You won’t need to install it again.'),
        h('a', { class: 'om-text-link', href: '#/app/help' }, 'How setup works ', icon('arrow'))));
    return content;
  }

  function uniquePlaces(cfg) {
    return [...new Map((cfg.packages || []).map(pkg => [pkg.slug, pkg])).values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function reviewPackage(h, ctx, cfg, pkg, source) {
    let sheet;
    const addPreview = action(h, 'Add to preview', () => {
      if (pkg.priceUsd > 20 - demoSpent) return;
      demoSpent = Math.round((demoSpent + pkg.priceUsd) * 100) / 100;
      demoOrders.push({ ...pkg });
      sheet.close(); go('esims');
    });
    addPreview.disabled = pkg.priceUsd > 20 - demoSpent;
    const continueLive = action(h, 'Continue in My data', () => {
      window.WhateverData.selectPackage(pkg.code);
      sheet.close(); go('esims');
    });
    const content = h('div', { class: 'om-guide-copy' },
      h('div', { class: 'om-review-size' }, h('strong', {}, pkg.gb + ' GB'), h('span', {}, pkg.days + ' days')),
      h('dl', { class: 'om-detail-list' },
        h('div', {}, h('dt', {}, 'Coverage'), h('dd', {}, pkg.name)),
        h('div', {}, h('dt', {}, 'Required data credit'), h('dd', {}, money(pkg.priceUsd)))),
      h('p', {}, 'Check that your phone supports eSIMs and is unlocked before redeeming. You’ll need an internet connection for setup.'),
      preview ? h('div', { class: 'om-inline-note' }, 'Preview only. Adding this package changes the sample account. It does not issue an eSIM or request a wallet signature.') : !launched(cfg) ? h('div', { class: 'om-inline-note' }, 'Catalogue preview. Weekly credit and redemption are not available yet.') : h('p', { class: 'om-muted' }, 'Your wallet will confirm the exact package before a real redemption.'),
      preview ? addPreview : launched(cfg) ? continueLive : action(h, 'See the setup guide', () => { sheet.close(); go('help'); }),
      preview && addPreview.disabled ? h('p', { class: 'om-form-message' }, 'This sample account needs more credit for that package. Choose a smaller plan or restart the preview.') : null,
      h('p', { class: 'om-muted' }, 'Package validity and the weekly credit reset follow separate rules. The activation window depends on the provider.'));
    sheet = dialog(h, pkg.name + ' data plan', content, source);
  }

  function plans(h, ctx, cfg) {
    if (!cfg) return unavailable(h, ctx, 'Plans need an internet connection.');
    const places = uniquePlaces(cfg);
    if (!places.some(place => place.slug === selectedSlug)) selectedSlug = places[0]?.slug || '';
    const results = h('div', { class: 'om-package-list' });
    const count = h('p', { class: 'om-search-result', role: 'status', 'aria-live': 'polite' });
    const search = h('input', { id: 'om-search', type: 'search', placeholder: 'Search a country or region', autocomplete: 'off' });
    const select = h('select', { id: 'om-place' });
    const locationLabel = h('span', { class: 'om-kicker' }, 'WHERE WILL YOU USE YOUR DATA?');
    const placeTitle = h('h2', { class: 'om-place-title' });

    function paintPackages() {
      results.replaceChildren();
      const packages = cfg.packages.filter(pkg => pkg.slug === selectedSlug).sort((a, b) => a.gb - b.gb);
      if (!packages.length) { placeTitle.textContent = 'No matching places'; return; }
      if (!packages.some(pkg => pkg.code === selectedCode)) selectedCode = (packages.find(pkg => pkg.gb === 5) || packages[0]).code;
      placeTitle.textContent = packages[0].name;
      packages.forEach(pkg => {
        const chosen = pkg.code === selectedCode;
        results.appendChild(h('div', { class: 'om-package' + (chosen ? ' is-selected' : '') },
          action(h, [h('span', { class: 'om-package-amount' }, pkg.gb + ' GB'), h('span', { class: 'om-package-days' }, pkg.days + ' days'),
            h('span', { class: 'om-package-price' }, money(pkg.priceUsd), h('small', {}, 'data credit')), h('span', { class: 'om-package-check' }, chosen ? icon('check') : '')], () => { selectedCode = pkg.code; paintPackages(); }, 'om-package-select'),
          chosen ? action(h, 'Review package', event => reviewPackage(h, ctx, cfg, pkg, event.currentTarget), 'om-button om-package-review') : null));
        const button = results.lastChild.querySelector('.om-package-select');
        button.setAttribute('aria-pressed', String(chosen));
        button.setAttribute('aria-label', `${pkg.gb} GB, ${pkg.days} days, ${money(pkg.priceUsd)} data credit`);
      });
    }

    function filterPlaces() {
      const query = search.value.trim().toLocaleLowerCase();
      const matches = places.filter(place => place.name.toLocaleLowerCase().includes(query));
      select.replaceChildren(...matches.map(place => h('option', { value: place.slug }, (place.flag ? place.flag + ' ' : '') + place.name)));
      select.disabled = !matches.length;
      count.textContent = matches.length ? matches.length + (matches.length === 1 ? ' place found' : ' places found') : 'No matching country or region. Try another name.';
      if (!matches.length) { selectedSlug = ''; results.replaceChildren(); placeTitle.textContent = 'No matching places'; return; }
      if (!matches.some(place => place.slug === selectedSlug)) selectedSlug = matches[0].slug;
      select.value = selectedSlug; paintPackages();
    }
    search.addEventListener('input', filterPlaces);
    select.addEventListener('change', () => { selectedSlug = select.value; paintPackages(); });
    filterPlaces();
    return h('div', { class: 'om-plans-grid' },
      h('section', { class: 'om-panel om-plan-search' }, locationLabel,
        h('label', { for: 'om-search' }, 'Find a place'), search,
        h('label', { for: 'om-place' }, 'Choose coverage'), select, count,
        h('div', { class: 'om-location-shortcuts' }, ['united-states', 'japan', 'europe'].filter(slug => places.some(place => place.slug === slug)).map(slug => {
          const place = places.find(item => item.slug === slug);
          return action(h, slug === 'united-states' ? 'At home in the US' : place.name, () => { search.value = ''; selectedSlug = slug; filterPlaces(); }, 'om-small-button');
        })),
        h('img', { class: 'om-plan-art', src: './assets/ott/everyday-dog-world.webp', alt: 'The OTT holder walking his dog with his phone.', loading: 'lazy', width: 1200, height: 900 })),
      h('section', { class: 'om-plan-options' }, placeTitle, results,
        h('p', { class: 'om-muted' }, 'Prices show the data credit a package requires. They are not the cost of buying OTT.')));
  }

  function sampleSim(h, pkg) {
    return h('article', { class: 'om-sim-card' },
      h('div', { class: 'om-sim-top' }, h('span', { class: 'om-sim-symbol' }, icon('esims')), h('span', { class: 'om-demo-label' }, 'SAMPLE eSIM')),
      h('h2', {}, pkg.name), h('p', { class: 'om-sim-package' }, h('strong', {}, pkg.gb + ' GB'), ' · ', pkg.days + ' days'),
      h('p', { class: 'om-muted' }, 'Package size, not a live remaining-data reading.'),
      h('div', { class: 'om-sim-footer' }, h('span', {}, 'Example package'), h('a', { class: 'om-text-link', href: '#/app/help' }, 'Setup guide ', icon('arrow'))));
  }

  function esims(h, ctx, cfg) {
    if (preview && cfg) {
      const first = cfg.packages.find(pkg => pkg.slug === 'japan' && pkg.gb === 5) || cfg.packages[0];
      const samplePackages = [first, ...demoOrders].filter(Boolean);
      return h('div', {},
        h('p', { class: 'om-screen-lede' }, 'Your sample packages. Real installation details appear only after a confirmed redemption.'),
        h('div', { class: 'om-sim-list' }, samplePackages.map(pkg => sampleSim(h, pkg))),
        h('div', { class: 'om-inline-note' }, 'No usable QR codes or activation details are created in preview mode.'),
        action(h, 'Find another plan', () => go('plans'), 'om-secondary-button'));
    }
    if (launched(cfg)) {
      const container = h('div', { class: 'om-live-account' });
      window.WhateverData.renderMyData(container, ctx).then(() => {
        const title = container.querySelector('.dashboard-head h1');
        if (title) { const heading = h('h2', {}, title.textContent); title.replaceWith(heading); }
      });
      return container;
    }
    return h('section', { class: 'om-empty-state' },
      h('div', { class: 'om-empty-icon' }, icon('esims')),
      h('h2', {}, 'Your eSIMs will live here.'),
      h('p', {}, cfg ? 'OTT has not launched yet. Once redemption is available, this is where you’ll find your packages and installation details.' : 'Connect to the internet to load your account. Installation guidance is still available in Help.'),
      cfg ? action(h, 'Explore a sample account', () => enterPreview(ctx)) : action(h, 'Try again', () => ctx.refresh()),
      h('a', { class: 'om-text-link', href: '#/app/help' }, 'See how eSIM setup works ', icon('arrow')));
  }

  function help(h) {
    const guide = h('div', { class: 'om-setup-guide' });
    const ios = action(h, 'iPhone', () => { helpPlatform = 'iphone'; paintGuide(); }, 'om-platform-button');
    const android = action(h, 'Android', () => { helpPlatform = 'android'; paintGuide(); }, 'om-platform-button');
    function paintGuide() {
      const iphone = helpPlatform === 'iphone';
      ios.setAttribute('aria-pressed', String(iphone)); android.setAttribute('aria-pressed', String(!iphone));
      const steps = iphone ? [
        ['Get connected first', 'Use Wi-Fi or your existing mobile connection. Your iPhone must support eSIMs and be unlocked.'],
        ['Open your eSIM in OTT', 'After redeeming, open eSIMs and reveal your installation details with your wallet.'],
        ['Add the eSIM', 'If an iPhone install link is provided, open it and follow Apple’s prompts. On iOS 17.4 or later, you can also press and hold the QR code in Safari and choose Add eSIM.'],
        ['Choose your data line', 'In Settings, open Cellular or Mobile Data and choose the new eSIM for mobile data. Keep your existing line for calls and texts. Follow the provider’s roaming instructions.'],
      ] : [
        ['Get connected first', 'Use Wi-Fi or your existing mobile connection. Check that your phone supports eSIMs and is unlocked.'],
        ['Open your eSIM in OTT', 'After redeeming, open eSIMs and reveal your installation details with your wallet.'],
        ['Add the eSIM in Settings', 'On Pixel, go to Network & internet, SIMs, Add SIM, then Set up an eSIM. On other Android phones, look for Add eSIM in SIM settings. Use the provider link where supported, scan the QR from another screen, or enter the manual details.'],
        ['Choose your data line', 'Select the new eSIM for mobile data. Keep your existing line for calls and texts. Follow the provider’s roaming instructions.'],
      ];
      guide.replaceChildren(h('ol', { class: 'om-steps' }, steps.map(([title, copy], index) => h('li', {},
        h('span', { class: 'om-step-number', 'aria-hidden': 'true' }, String(index + 1).padStart(2, '0')),
        h('div', {}, h('h3', {}, title), h('p', {}, copy))))),
      h('a', { class: 'om-text-link', href: iphone ? 'https://support.apple.com/en-gb/118669' : 'https://support.google.com/pixelphone/answer/16115470?hl=en', target: '_blank', rel: 'noopener' }, iphone ? 'Apple’s eSIM setup guide ↗' : 'Google’s eSIM setup guide ↗'));
    }
    paintGuide();
    return h('div', { class: 'om-help-grid' },
      h('section', { class: 'om-panel' }, h('h2', {}, 'Set up your eSIM'),
        h('p', { class: 'om-screen-lede' }, 'OTT gives you the installation details. Your phone confirms and completes setup.'),
        h('div', { class: 'om-platform-switch', role: 'group', 'aria-label': 'Phone type' }, ios, android), guide),
      h('section', { class: 'om-panel om-help-notes' },
        h('img', { src: './assets/ott/faq-clay-help.webp', alt: '', loading: 'lazy', width: 720, height: 720 }),
        h('h2', {}, 'Before you connect'),
        h('details', {}, h('summary', {}, 'Can I set it up on the same phone?'), h('p', {}, 'Use the provider’s installation link if one is available. Otherwise, use manual details or display the QR on another screen. Supported iPhones can also add an eSIM from a QR shown in Safari.')),
        h('details', {}, h('summary', {}, 'Does weekly credit become cash?'), h('p', {}, 'No. Credit can be spent on available data packages. It cannot be withdrawn, and unused weekly credit expires at the weekly reset.')),
        h('details', {}, h('summary', {}, 'Will the app show my remaining GB?'), h('p', {}, 'It shows package sizes and order details. Live remaining-data readings are not available in this version.')),
        h('details', {}, h('summary', {}, 'Why can’t I connect my wallet here?'), h('p', {}, 'This first version connects through wallets that provide an in-app browser. Direct mobile wallet connection is still being built. Open the app link in your wallet’s browser to connect.')),
        h('a', { class: 'om-text-link', href: '#/status' }, 'Check programme status ', icon('arrow'))));
  }

  function unavailable(h, ctx, message) {
    return h('section', { class: 'om-empty-state' }, icon('help'), h('h2', {}, 'You’re offline, or OTT couldn’t load.'),
      h('p', {}, message), action(h, 'Try again', () => ctx.refresh()), h('a', { class: 'om-text-link', href: '#/app/help' }, 'Open the setup guide ', icon('arrow')));
  }

  async function render(view, ctx, requestedScreen) {
    const { h } = ctx;
    const screen = SCREENS.includes(requestedScreen) ? requestedScreen : 'home';
    const shell = h('div', { class: 'om-shell' });
    const installButton = action(h, [icon('download'), h('span', {}, 'Add to phone')], event => install(h, event.currentTarget), 'om-install-button');
    const header = h('header', { class: 'om-header' },
      h('a', { class: 'om-brand', href: '#/', 'aria-label': 'OTT website' }, 'OT+T', h('span', {}, 'THE DATA APP')),
      installButton);
    const nav = h('nav', { class: 'om-nav', 'aria-label': 'App navigation' }, SCREENS.map(name => h('a', {
      href: name === 'home' ? '#/app' : '#/app/' + name,
      class: name === screen ? 'is-active' : '', 'aria-current': name === screen ? 'page' : null,
    }, icon(name), h('span', {}, LABELS[name]))), h('a', { class: 'om-website-link', href: '#/' }, 'Visit the website ↗'));
    const body = h('div', { class: 'om-body' });
    const heading = h('div', { class: 'om-heading' }, h('div', {}, h('span', { class: 'om-kicker' }, 'TOUCH GRASS. STAY ONLINE.'),
      h('h1', {}, { home: 'Your data, anywhere.', plans: 'Find your connection.', esims: 'Your eSIMs.', help: 'Let’s get you online.' }[screen])),
      h('span', { class: 'om-status-pill' }, 'Loading'));
    const contents = h('div', { class: 'om-content' }, h('p', { class: 'om-loading', role: 'status' }, 'Loading OTT…'));
    shell.append(header, nav, body); body.append(heading, contents); view.appendChild(shell);
    window.OTTPwa?.register?.();
    let cfg = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch('./config/esim.json', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Configuration unavailable');
      const json = await response.json();
      if (!Array.isArray(json.packages)) throw new Error('Catalogue unavailable');
      cfg = json;
    } catch { /* No saved financial state is used as an offline substitute. */ }
    finally { clearTimeout(timeout); }
    if (!ctx.isCurrent() || !view.contains(shell)) return;
    heading.querySelector('.om-status-pill').textContent = cfg ? launched(cfg) ? 'Programme configured' : 'Prelaunch' : 'Offline';
    if (preview && cfg) body.insertBefore(previewBanner(h, ctx), contents);
    const screenContent = screen === 'plans' ? plans(h, ctx, cfg) : screen === 'esims' ? esims(h, ctx, cfg) : screen === 'help' ? help(h) : cfg ? home(h, ctx, cfg) : unavailable(h, ctx, 'Credit and orders need a live connection. The setup guide still works.');
    contents.replaceChildren(screenContent);
    if (!preview && cfg && !launched(cfg)) body.appendChild(h('p', { class: 'om-prelaunch-note' }, 'Prelaunch. Weekly credit and redemption are not available yet.'));
  }

  window.OTTMobileApp = {
    render,
    dispose: () => document.querySelectorAll('.om-dialog').forEach(sheet => { sheet.close(); sheet.remove(); }),
  };
})();
