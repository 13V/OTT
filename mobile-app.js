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
    bookmark: ['M6 3h12v18l-6-4-6 4z'],
  };
  let preview = false;
  let demoSpent = 5;
  let demoOrders = [];
  let selectedSlug = 'united-states';
  let selectedCode = '';
  let helpPlatform = 'iphone';
  let helpStep = 0;
  let dialogSequence = 0;

  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  const isAddress = value => !!window.OTTSolana && window.OTTSolana.isAddress(value);
  // The API's own rule (site/api/status.js launched()): a real address, never the all-zero key an
  // unset address looks like, and a token program that is Token or Token-2022.
  // The API's launch rule, shared through site/solana.js, so the app and the API never disagree.
  const launched = cfg => !!window.OTTSolana && window.OTTSolana.launchedConfig(cfg);
  const go = screen => { location.hash = screen === 'home' ? '#/app' : '#/app/' + screen; };

  // The connected Solana wallet is the member's account: its credit, its eSIMs, its signatures.
  function holderAddress(ctx) {
    const account = ctx.currentAccount();
    return isAddress(account) ? account : null;
  }
  function confirmedBudget(state) {
    if (state?.membership?.configured && !state.membership.member) return null;
    return state && !state.stale && Number.isFinite(state.remainingUsd) && state.remainingUsd >= 0
      && Number.isFinite(state.weekEnd) && state.weekEnd * 1000 > Date.now() ? state.remainingUsd : null;
  }
  // A member's free welcome eSIM is the first thing worth doing, so it sits right under the credit
  // pass rather than below the fold. A non-member's invitation is the pass itself. Only the API's
  // own answer drives either.
  function welcomeBanner(h, membership) {
    const welcome = membership.welcome ? 'Any ' + membership.welcome.gb + ' GB, ' + membership.welcome.days + '-day plan up to ' + money(membership.welcome.maxUsd) + '. ' : '';
    return h('section', { class: 'om-welcome-banner', 'aria-label': 'Your welcome eSIM' },
      h('span', { class: 'om-kicker' }, 'WELCOME eSIM'),
      h('h2', {}, 'Your welcome eSIM is ready to claim.'),
      h('p', { class: 'om-muted' }, welcome + 'It doesn’t use your weekly credit.'),
      action(h, [h('span', {}, 'Claim your welcome eSIM'), icon('arrow')], () => go('esims')));
  }
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
    const id = 'om-dialog-title-' + (++dialogSequence);
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

  // app.js picks the wallet: one installed wallet connects directly, several get a short list,
  // and a phone without one is offered the wallet apps' own "open in my browser" links.
  async function wallet(ctx, source) {
    source.disabled = true;
    preview = false;
    try {
      const account = await ctx.connect(null, source);
      if (account && ctx.isCurrent()) ctx.refresh();
      return account;
    } catch (error) { ctx.toast('Could not connect', error.message || 'Try again in your wallet.', 'error'); }
    finally { if (source.isConnected) source.disabled = false; }
    return null;
  }

  function walletSettings(h, ctx, source) {
    const account = ctx.currentAccount();
    const copy = action(h, 'Copy address', async () => {
      try { await navigator.clipboard.writeText(account); copy.textContent = 'Address copied'; }
      catch { copy.textContent = 'Select the address above to copy it'; }
    }, 'om-secondary-button');
    let sheet;
    const disconnect = action(h, 'Disconnect wallet', async () => {
      disconnect.disabled = true;
      sheet.close();
      try { await ctx.disconnect(); }
      catch (error) { ctx.toast('Wallet disconnected from OTT', error.message || 'You can also remove the connection in your wallet.'); }
    }, 'om-secondary-button');
    const name = window.OTTWallet?.state().wallet;
    sheet = dialog(h, 'Your wallet', h('div', { class: 'om-guide-copy' },
      h('p', { class: 'om-wallet-address' }, account),
      h('p', {}, 'Your Solana wallet' + (name ? ' (' + name + ')' : '') + ' is your OTT account. Viewing your credit does not need a signature. Joining, redemptions and installation details need your approval in the wallet.'),
      h('div', { class: 'om-wallet-actions' }, copy, disconnect,
        h('a', { class: 'om-text-link', href: (ctx.explorer?.account?.(account)) || ('https://solscan.io/account/' + account), target: '_blank', rel: 'noopener' }, 'View on Solscan ↗'))), source);
  }

  /** Installation uses only details already revealed by this wallet's signed read. */
  function openSetup(ctx, sim, source, placeName) {
    if (!ctx.isCurrent() || !source.isConnected || !ctx.currentAccount() || sim.codes !== true) return;
    const { h } = ctx;
    let platform = /Android/i.test(navigator.userAgent) ? 'android' : 'iphone';
    let step = 0;
    let sheet;
    const content = h('div', { class: 'om-guide-copy om-install-guide' });
    const safeUrl = value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
      } catch { return ''; }
    };
    // No installation URL is invented from an activation string.
    const urls = { iphone: safeUrl(sim.appleInstallUrl), android: safeUrl(sim.androidInstallUrl) };
    const ac = String(sim.ac || sim.manualCode || '');
    const parts = ac.match(/^LPA:1\$([^$\s]+)\$([^$\s]+)(?:\$.*)?$/);
    const smdp = String(sim.smdpAddress || (parts && parts[1]) || '');
    const matching = String(sim.matchingId || (parts && parts[2]) || '');
    let qr = '';
    if (ac && window.WhateverQr) {
      try { qr = window.WhateverQr.svg(ac); } catch { /* Manual fields still work when a QR cannot be drawn. */ }
    }
    // Draw supplied activation details here first, without requesting a remote QR image.
    if (!qr && sim.qrCodeUrl && (/^data:image\/(png|jpeg|webp|svg\+xml)[;,]/i.test(sim.qrCodeUrl) || safeUrl(sim.qrCodeUrl))) qr = sim.qrCodeUrl;
    function copyField(label, value) {
      const copy = action(h, 'Copy ' + label, async () => {
        if (!ctx.isCurrent() || !sheet.isConnected) return;
        try { await navigator.clipboard.writeText(value); if (copy.isConnected) copy.textContent = 'Copied'; }
        catch { if (copy.isConnected) copy.textContent = 'Select and copy'; }
      }, 'om-secondary-button');
      return h('div', { class: 'om-install-field' }, h('div', {}, h('span', {}, label), h('code', {}, value)), copy);
    }
    function paint() {
      if (!ctx.isCurrent()) { sheet?.close(); return; }
      const iphone = platform === 'iphone';
      const os = iphone ? 'iPhone' : 'Android';
      const ios = action(h, 'iPhone', () => { platform = 'iphone'; paint(); }, 'om-platform-button');
      const android = action(h, 'Android', () => { platform = 'android'; paint(); }, 'om-platform-button');
      ios.setAttribute('aria-pressed', String(iphone)); android.setAttribute('aria-pressed', String(!iphone));
      const labels = ['Prepare', 'Add eSIM', 'Get online'];
      const progress = h('ol', { class: 'om-install-progress', 'aria-label': 'eSIM setup progress' }, labels.map((label, index) =>
        h('li', { class: index === step ? 'is-current' : '', 'aria-current': index === step ? 'step' : null }, h('span', {}, String(index + 1)), label)));
      let panel;
      if (step === 0) {
        panel = h('div', { class: 'om-install-step' }, h('h3', { tabindex: '-1' }, 'Before you start'),
          h('p', {}, 'Connect to Wi-Fi or another working internet connection. Your phone needs to support eSIMs and be unlocked for other carriers.'),
          h('p', {}, 'You’re setting up your ' + placeName + ' data eSIM. Your phone will confirm the installation.'),
          h('p', { class: 'om-muted' }, 'Weekly credit expiry is separate from the package’s validity and activation rules.'));
      } else if (step === 1) {
        panel = h('div', { class: 'om-install-step' }, h('h3', { tabindex: '-1' }, 'Add the eSIM'),
          urls[platform] ? h('a', { class: 'om-button', href: urls[platform], target: '_blank', rel: 'noopener noreferrer' }, 'Open ' + os + ' installation') : null,
          h('p', {}, iphone ? 'In Settings, open Cellular or Mobile Data, then Add eSIM. Choose the QR option or enter the details manually.' : 'On Pixel, open Settings, then Network & internet, SIMs, Add SIM and Set up an eSIM. Names vary on other Android phones.'),
          qr ? h('img', { class: 'om-install-qr', src: qr, alt: 'Installation QR code for ' + placeName, width: 240, height: 240 }) : null,
          qr ? h('p', { class: 'om-muted' }, iphone ? 'In Safari on iOS 17.4 or later, touch and hold the QR, then choose Add eSIM. You can also show it on another screen and scan it.' : 'Show the QR on another screen to scan it, or use the manual details below on this phone.') : null,
          h('div', { class: 'om-install-details' }, smdp ? copyField('SM-DP+ address', smdp) : null,
            matching ? copyField('Activation code', matching) : ac ? copyField('Activation string', ac) : null),
          !qr && !ac && !smdp && !urls[platform] ? h('p', { class: 'om-inline-note' }, 'The provider hasn’t supplied installation details for this method. Try the other phone option or refresh your eSIMs.') : null,
          h('p', { class: 'om-muted' }, 'These details can install your eSIM. Keep them private.'));
      } else {
        panel = h('div', { class: 'om-install-step' }, h('h3', { tabindex: '-1' }, 'Choose it for mobile data'),
          h('p', {}, 'After your phone finishes installation, turn on this eSIM in its SIM settings and select it for mobile data. Follow the provider’s instructions if this data line needs roaming.'),
          h('p', {}, 'Use it within the package’s coverage. Your regular number can remain on your usual line.'),
          h('p', {}, 'To check the connection, turn Wi-Fi off and open a webpage with this eSIM selected for mobile data. Loading the page confirms the data line is working.'),
          h('p', { class: 'om-inline-note' }, 'OTT can’t detect whether your phone has finished installation or connected. Check your phone’s SIM settings.'),
          action(h, 'Installed but no data?', event => troubleshoot(h, event.currentTarget, platform), 'om-secondary-button om-troubleshooting-button'),
          h('a', { class: 'om-text-link', href: iphone ? 'https://support.apple.com/en-au/118669' : 'https://support.google.com/pixelphone/answer/16115470?hl=en', target: '_blank', rel: 'noopener noreferrer' }, os + ' setup support ↗'));
      }
      const back = action(h, 'Back', () => { step--; paint(); content.querySelector('h3')?.focus(); }, 'om-secondary-button');
      back.disabled = step === 0;
      const next = action(h, step === 2 ? 'Back to eSIMs' : 'Next step', () => {
        if (step === 2) { sheet.close(); return; }
        step++; paint(); content.querySelector('h3')?.focus();
      });
      content.replaceChildren(h('div', { class: 'om-platform-switch', role: 'group', 'aria-label': 'Phone type' }, ios, android), progress, panel,
        h('div', { class: 'om-step-controls' }, back, next));
    }
    paint();
    sheet = dialog(h, 'Set up your ' + placeName + ' eSIM', content, source);
  }

  function previewBanner(h, ctx) {
    return h('div', { class: 'om-preview-banner', role: 'status' },
      h('span', {}, h('strong', {}, 'App preview'), 'Sample credit and eSIMs. No real orders. No membership enrolment.'),
      action(h, 'Exit preview', () => { preview = false; demoSpent = 5; demoOrders = []; ctx.refresh(); }, 'om-small-button'));
  }

  function enterPreview(ctx) { preview = true; demoSpent = 5; demoOrders = []; ctx.refresh(); }

  function chip(h) {
    return h('span', { class: 'om-chip', 'aria-hidden': 'true' }, Array.from({ length: 9 }, () => h('span', {})));
  }

  function countryFlag(h, pkg) {
    const letters = Array.from(pkg?.flag || '');
    const code = letters.length === 2 && letters.every(letter => letter.codePointAt(0) >= 0x1f1e6 && letter.codePointAt(0) <= 0x1f1ff)
      ? letters.map(letter => String.fromCharCode(letter.codePointAt(0) - 0x1f1e6 + 97)).join('')
      : pkg?.flag?.toLowerCase();
    return /^[a-z]{2}$/.test(code || '')
      ? h('img', { class: 'om-country-flag', src: './assets/flags/' + code + '.svg', alt: '', width: 32, height: 24 })
      : h('span', { class: 'om-country-flag om-region-symbol', 'aria-hidden': 'true' }, icon('plans'));
  }

  function world(h, kind, screenClass) {
    const scenes = {
      home: ['app/app-home-world', 'The OTT holder walking his dog through a little clay park.'],
      japan: ['app/app-japan-world', 'The same OTT holder exploring a handmade clay street in Japan.'],
      kit: ['app/app-kit-world', 'The OTT holder and his dog checking a phone beside his backpack and map.'],
      travel: ['ott/coverage-airport-world', 'The OTT holder looking up at a clay airport departures board.'],
    };
    const [name, alt] = kind === 'home' && !screenClass
      ? ['ott/hero-touch-grass', 'The OTT holder and his dog on a handmade clay grass island, checking his phone.']
      : scenes[kind] || scenes.home;
    return h('div', { class: 'om-world om-world-' + (screenClass || (kind === 'japan' ? 'plans' : kind)) },
      h('img', { class: 'om-world-art', src: './assets/' + name + '.webp', alt,
        width: kind === 'home' && !screenClass ? 1122 : 1536, height: kind === 'home' && !screenClass ? 1402 : 1024,
        decoding: 'async', fetchpriority: 'high' }));
  }

  function home(h, ctx, cfg) {
    const active = launched(cfg);
    const account = ctx.currentAccount();
    const holder = holderAddress(ctx);
    const primary = preview ? action(h, ['Find a data plan', icon('arrow')], () => go('plans'))
      : active ? action(h, [account ? 'View My data' : 'Connect wallet', icon('arrow')], event => account ? go('esims') : wallet(ctx, event.currentTarget))
        : action(h, ['Try the app preview', icon('arrow')], () => enterPreview(ctx));
    const content = h('div', { class: 'om-pass-content' }, chip(h),
        h('span', { class: 'om-kicker' }, preview ? 'SAMPLE DATA CREDIT' : active ? 'YOUR WEEKLY DATA CREDIT' : 'APP PREVIEW'),
        preview ? h('p', { class: 'om-balance' }, money(Math.max(0, 20 - demoSpent)))
          : h('h2', { class: 'om-pass-title' }, active ? 'Your wallet. Your connection.' : 'Try it before launch.'),
        h('p', { class: 'om-pass-note' }, preview ? 'Example balance. No real credit.'
          : active ? 'Check your weekly credit and eSIMs.' : 'Explore a sample member account. Joining opens when OTT launches on pump.fun.'),
        preview || (active && account) ? h('div', { class: 'om-pass-action' }, primary) : null);
    const credit = h('section', { class: 'om-credit-card om-data-pass', 'aria-label': preview ? 'Sample weekly credit' : active ? 'Weekly credit' : 'App preview invitation', 'aria-live': 'polite' }, content);
    const realAccount = !preview && active && holder;
    const shortcuts = h('section', { class: 'om-holder-shortcuts', 'aria-label': 'Plans for your account' });
    function paintShortcuts(state) {
      const budget = preview ? Math.max(0, 20 - demoSpent) : confirmedBudget(state);
      const fits = budget === null ? [] : window.OTTHolderTools.fitPlans(cfg, budget);
      const saved = window.OTTHolderTools.savedPlaces(cfg);
      const seen = new Set();
      const choices = [...fits.filter(pkg => saved.includes(pkg.slug)), ...fits].filter(pkg => {
        if (seen.has(pkg.slug)) return false; seen.add(pkg.slug); return true;
      }).slice(0, 3);
      const sims = window.OTTHolderTools.publicSims(state?.sims, cfg);
      shortcuts.replaceChildren(...[
        budget !== null ? h('div', {}, h('h2', {}, preview ? 'Plans for your sample credit' : 'Plans within your credit'),
          h('p', { class: 'om-muted' }, choices.length ? 'Start with a plan your ' + (preview ? 'sample' : 'confirmed') + ' balance can cover.' : 'No packages fit this balance. You can still browse all plans.'),
          h('div', { class: 'om-shortcut-list' }, choices.map(pkg => action(h,
            [countryFlag(h, pkg), h('span', {}, pkg.name, h('small', {}, pkg.gb + ' GB · ' + money(pkg.priceUsd))), icon('arrow')],
            () => { selectedSlug = pkg.slug; selectedCode = pkg.code; go('plans'); }, 'om-shortcut-button')))) : null,
        sims.length ? h('div', {}, h('h2', {}, 'Add data for a destination'),
          h('p', { class: 'om-muted' }, 'Review a package for a place you’ve used before. The provider decides whether an existing eSIM can be topped up.'),
          h('div', { class: 'om-shortcut-list' }, sims.map(sim => {
            const pkg = cfg.packages.find(item => item.slug === sim.slug);
            return action(h, [countryFlag(h, pkg), h('span', {}, pkg.name), icon('arrow')], () => {
              selectedSlug = sim.slug; selectedCode = ''; go('plans');
            }, 'om-shortcut-button');
          }))) : null].filter(Boolean));
    }
    if (preview) paintShortcuts(null);
    if (realAccount) {
      credit.setAttribute('aria-busy', 'true');
      content.querySelector('.om-pass-title').textContent = 'Reading your credit…';
      content.querySelector('.om-pass-note').textContent = 'Checking your current weekly account.';
      primary.textContent = 'View My data';
      const update = async () => {
        let state = null;
        try { state = await window.WhateverData.loadAccount(holder); } catch { /* Live financial data never falls back to a cached sample. */ }
        if (!ctx.isCurrent() || !credit.isConnected || holderAddress(ctx) !== holder) return;
        paintShortcuts(state);
        credit.setAttribute('aria-busy', 'false');
        if (state?.membership?.configured && state.membership.member && !state.membership.welcomeClaimed) credit.after(welcomeBanner(h, state.membership));
        const title = content.querySelector('.om-pass-title, .om-balance');
        const note = content.querySelector('.om-pass-note');
        if (!state || (!state.stale && state.remainingUsd === null)) {
          title.className = 'om-pass-title'; title.textContent = 'Credit unavailable';
          note.textContent = 'We couldn’t load your current balance. Go online and try again.';
        } else if (state.membership?.configured && !state.membership.member) {
          // Weekly credit is for members. A holder who hasn't joined has none, and a $0.00
          // balance would read as a verdict on the wallet rather than an invitation.
          title.className = 'om-pass-title'; title.textContent = 'Not a member yet';
          note.textContent = state.membership.enrolmentOpen ? 'Members get a welcome eSIM and a weekly share of trading fees.' : 'Joining is closed right now.';
          primary.replaceWith(action(h, [state.membership.enrolmentOpen ? 'Join OT+T' : 'View membership', icon('arrow')], () => go('esims')));
        } else if (state.stale || confirmedBudget(state) === null) {
          title.className = 'om-pass-title'; title.textContent = 'Awaiting allocation';
          note.textContent = 'This week’s credit hasn’t been published yet. Check back after the weekly update.';
        } else {
          title.className = 'om-balance'; title.textContent = money(state.remainingUsd);
          note.textContent = state.membership?.configured && !state.membership.sharing
            ? 'Your weekly share starts at the next Monday snapshot.' : 'Available for eSIM packages. At home or abroad.';
          const details = h('dl', { class: 'om-credit-details' },
            h('div', {}, h('dt', {}, 'Allocated'), h('dd', {}, state.allocatedUsd === null ? 'Unavailable' : money(state.allocatedUsd))),
            h('div', {}, h('dt', {}, 'Used'), h('dd', {}, state.usedUsd === null ? 'Unavailable' : money(state.usedUsd))));
          content.insertBefore(details, content.querySelector('.om-pass-action'));
          const expiry = h('p', { class: 'om-credit-expiry' }, 'Unused credit expires ',
            h('time', { datetime: new Date(state.weekEnd * 1000).toISOString() }, new Date(state.weekEnd * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), '.');
          content.insertBefore(expiry, content.querySelector('.om-pass-action'));
          // Replace the old View My data handler as the primary task becomes choosing data.
          primary.replaceWith(action(h, ['Find a data plan', icon('arrow')], () => go('plans')));
        }
      };
      // Rendering is synchronous; start reads after the pass has been mounted.
      queueMicrotask(update);
    }
    const first = cfg.packages.find(pkg => pkg.slug === 'japan' && pkg.gb === 5) || cfg.packages[0];
    const connection = action(h, [countryFlag(h, preview ? first : null),
      h('span', { class: 'om-row-copy' }, h('strong', {}, preview ? 'Sample eSIM' : 'Find a data plan'),
        h('span', {}, preview ? first.name + ' · ' + first.gb + ' GB package' : 'For everyday life or your next trip.')), icon('arrow')],
    () => go(preview ? 'esims' : 'plans'), 'om-connection-row');
    connection.setAttribute('aria-label', preview ? 'View sample eSIMs' : 'Find a data plan');
    const introAction = !active && !preview ? primary
      : preview || account ? h('a', { class: 'om-text-link', href: preview ? '#/app/plans' : '#/app/esims' },
        preview ? 'Browse plans ' : 'Open my eSIMs ', icon('arrow'))
        : action(h, ['Connect wallet', icon('arrow')], event => wallet(ctx, event.currentTarget));
    const intro = h('div', { class: 'om-home-intro' },
      h('p', { class: 'om-home-eyebrow' }, 'OT+T / YOUR DATA'),
      h('h1', {}, 'Touch grass.', h('br', {}), 'Stay online.'),
      h('p', { class: 'om-home-lede' }, preview || active ? 'Check your credit. Pick a data plan.' : 'Join once with OTT.', h('br', {}), preview || active ? 'Set up your eSIM.' : 'Trading fees fund your data.'),
      h('div', { class: 'om-home-actions' }, introAction,
        h('a', { class: 'om-text-link', href: !active && !preview ? '#/about' : preview || account ? '#/app/help' : '#/app/plans' },
          !active && !preview ? 'How membership will work' : preview || account ? 'How to get online' : 'Browse plans', icon('arrow'))),
      h('p', { class: 'om-home-context' }, preview ? 'You’re exploring a sample account. No wallet needed.'
        : active ? account ? 'Your weekly credit and eSIMs belong to your wallet.' : 'Your Solana wallet is your account. Connecting does not move funds.'
          : 'Joining is not open yet. Preview only.'), credit);
    const result = h('div', { class: 'om-home-grid' },
      h('div', { class: 'om-home-feature' + (realAccount ? ' om-home-account' : preview ? ' om-home-preview' : '') }, intro,
        h('div', { class: 'om-home-visual' }, world(h, 'home'))),
      h('div', { class: 'om-home-tools' }, connection,
        !preview ? h('div', { class: 'om-wallet-row' },
          h('span', { class: 'om-row-copy' }, h('strong', {}, account ? 'Wallet connected' : 'Your wallet is your account'),
            h('span', {}, account ? account.slice(0, 4) + '…' + account.slice(-4) : 'Phantom, Solflare or another Solana wallet. Connecting does not enrol you.')),
          h('div', { class: 'om-wallet-choices' },
          action(h, account ? 'Wallet settings' : 'Connect wallet',
            event => account ? walletSettings(h, ctx, event.currentTarget) : wallet(ctx, event.currentTarget), 'om-text-button'))) : null,
        realAccount ? action(h, 'Refresh account', () => ctx.refresh(), 'om-text-button') : null,
        h('a', { class: 'om-home-footnote om-text-link', href: '#/app/help' }, 'How eSIM setup works ', icon('arrow'))), shortcuts);
    return result;
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
    const continueLive = action(h, 'Continue to eSIMs', () => {
      window.WhateverData.selectPackage(pkg.code);
      sheet.close();
      if (location.hash === '#/app/esims' && ctx.isCurrent()) ctx.refresh();
      else go('esims');
    });
    const content = h('div', { class: 'om-guide-copy' },
      h('div', { class: 'om-review-size' }, h('strong', {}, pkg.gb + ' GB'), h('span', {}, pkg.days + ' days')),
      h('dl', { class: 'om-detail-list' },
        h('div', {}, h('dt', {}, 'Coverage'), h('dd', {}, pkg.name)),
        h('div', {}, h('dt', {}, 'Required data credit'), h('dd', {}, money(pkg.priceUsd)))),
      h('p', {}, 'Check that your phone supports eSIMs and is unlocked before redeeming. You’ll need an internet connection for setup.'),
      action(h, 'Check your phone', event => checkPhone(h, event.currentTarget), 'om-secondary-button om-review-device-check'),
      preview ? h('div', { class: 'om-inline-note' }, 'Preview only. Adding this package changes the sample account. It does not issue an eSIM or request a wallet signature.')
        : !launched(cfg) ? h('div', { class: 'om-inline-note' }, 'Catalogue preview. Joining and purchases are not open yet. Package costs do not set the join amount.') : h('p', { class: 'om-muted' }, 'Your wallet will confirm the exact package before a real redemption.'),
      preview ? addPreview
        : launched(cfg) ? continueLive : action(h, 'See the setup guide', () => { sheet.close(); go('help'); }),
      preview && addPreview.disabled ? h('p', { class: 'om-form-message' }, 'This sample account needs more credit for that package. Choose a smaller plan or restart the preview.') : null,
      h('p', { class: 'om-muted' }, 'Package validity and the weekly credit reset follow separate rules. The activation window depends on the provider.'));
    content.appendChild(h('p', { class: 'om-muted' }, 'If you already have an eSIM for this destination, the provider will top it up when compatible. Otherwise, it may issue a new eSIM with new installation details.'));
    sheet = dialog(h, pkg.name + ' data plan', content, source);
  }

  function plans(h, ctx, cfg) {
    if (!cfg) return unavailable(h, ctx, 'Plans need an internet connection.');
    const places = uniquePlaces(cfg);
    if (!places.some(place => place.slug === selectedSlug)) selectedSlug = places[0]?.slug || '';
    const feature = h('section', { class: 'om-plan-feature', 'aria-label': 'Choose coverage' });
    const options = h('section', { class: 'om-plan-options', 'aria-label': 'Choose a data package' });
    const holder = !preview && launched(cfg) && holderAddress(ctx);
    let budget = preview ? Math.max(0, 20 - demoSpent) : null;
    let budgetEnd = Infinity;
    const budgetNote = h('p', { class: 'om-plan-budget', role: 'status' }, preview ? 'Sample credit: ' + money(budget) : 'Browse every package. Confirmed holder credit is required to filter by balance.');
    const fit = h('input', { type: 'checkbox', id: 'om-fits-credit' });
    fit.disabled = budget === null;
    fit.addEventListener('change', () => paintPackages());
    const filters = h('div', { class: 'om-plan-filters' + (!preview && !holder ? ' is-inactive' : '') }, budgetNote,
      h('label', { for: 'om-fits-credit' }, fit, preview ? 'Fits my sample credit' : 'Fits my credit'));
    if (!preview && !launched(cfg)) filters.hidden = true;
    const coverage = action(h, '', event => chooseCoverage(event.currentTarget), 'om-coverage-button');
    coverage.setAttribute('aria-haspopup', 'dialog');

    function paintPackages(focusCode) {
      if (budget !== null && budgetEnd <= Date.now()) { budget = null; fit.checked = false; fit.disabled = true; budgetNote.textContent = 'Credit has expired. Refresh your account for the new allocation.'; }
      const allPackages = cfg.packages.filter(pkg => pkg.slug === selectedSlug).sort((a, b) => a.gb - b.gb);
      const packages = fit.checked && budget !== null ? window.OTTHolderTools.fitPlans(cfg, budget, selectedSlug) : allPackages;
      const place = allPackages[0];
      if (!place) return;
      const saved = window.OTTHolderTools.savedPlaces(cfg);
      const save = action(h, [icon('bookmark'), saved.includes(selectedSlug) ? 'Saved' : 'Save'], () => {
        try {
          const result = window.OTTHolderTools.toggleSaved(cfg, selectedSlug);
          if (!result.persisted) ctx.toast('Saved for this visit', 'Browser storage is unavailable.');
        } catch (error) { ctx.toast('Could not save destination', error.message); }
        paintPackages();
        feature.querySelector('.om-save-destination')?.focus();
      }, 'om-secondary-button om-save-destination');
      save.setAttribute('aria-label', saved.includes(selectedSlug) ? 'Remove saved destination' : 'Save destination');
      save.setAttribute('aria-pressed', String(saved.includes(selectedSlug)));
      coverage.replaceChildren(countryFlag(h, place), h('span', { class: 'om-coverage-name' }, place.name),
        h('span', { class: 'om-coverage-chevron', 'aria-hidden': 'true' }, '⌄'));
      coverage.setAttribute('aria-label', 'Choose coverage. ' + place.name);
      feature.replaceChildren(...[h('div', { class: 'om-coverage-heading' }, coverage, save), saved.length ? h('div', { class: 'om-saved-places', role: 'group', 'aria-label': 'Saved destinations' },
        saved.map(slug => {
          const destination = places.find(item => item.slug === slug);
          const button = action(h, destination.name, () => {
            selectedSlug = slug; selectedCode = ''; paintPackages();
            feature.querySelector('.om-saved-place[aria-pressed="true"]')?.focus();
          }, 'om-saved-place');
          button.setAttribute('aria-pressed', String(slug === selectedSlug)); return button;
        })) : null].filter(Boolean));
      illustration.replaceChildren(world(h, place.slug === 'japan' ? 'japan' : place.slug === 'united-states' ? 'home' : 'travel', 'plans'));
      if (!packages.length) {
        budgetNote.hidden = false;
        options.replaceChildren(filters, h('div', { class: 'om-empty-plans' }, h('h2', {}, 'No packages fit this balance.'),
          h('p', {}, 'Choose another destination or view every package.'), action(h, 'Browse all packages', () => { fit.checked = false; paintPackages(); }, 'om-secondary-button')));
        return;
      }
      if (!packages.some(pkg => pkg.code === selectedCode)) selectedCode = (packages.find(pkg => pkg.gb === 5) || packages[0]).code;
      const pkg = packages.find(item => item.code === selectedCode);
      const budgetLabel = budget !== null ? h('p', { class: 'om-package-budget' },
        preview ? 'Sample credit ' : 'Your remaining credit ', h('strong', {}, money(budget))) : null;
      budgetNote.hidden = budget !== null;
      const sizes = h('div', { class: 'om-package-sizes', role: 'group', 'aria-label': 'Package size' }, packages.map(item => {
        const button = action(h, [h('strong', {}, item.gb + ' GB'), h('span', {}, item.days + ' days'),
          h('span', { class: 'om-option-price' }, h('span', {}, money(item.priceUsd)), ' ', h('span', {}, 'data credit'))], () => { selectedCode = item.code; paintPackages(item.code); },
          'om-size-button om-package-select' + (item.code === selectedCode ? ' is-selected' : ''));
        button.setAttribute('aria-pressed', String(item.code === selectedCode));
        button.setAttribute('aria-label', `${item.gb} GB, ${item.days} days, ${money(item.priceUsd)} data credit`);
        button.dataset.packageCode = item.code;
        return button;
      }));
      options.replaceChildren(...[filters, budgetLabel, sizes,
        h('article', { class: 'om-selected-package om-data-pass', 'aria-label': pkg.name + ' selected package' },
          h('div', { class: 'om-pass-content' }, chip(h), h('span', { class: 'om-kicker' }, pkg.name),
            h('h2', { class: 'om-package-amount' }, pkg.gb + ' GB'),
            h('p', { class: 'om-package-days' }, pkg.days + ' days'),
            h('p', { class: 'om-package-price' }, money(pkg.priceUsd), h('small', {}, ' data credit')),
            preview ? null : h('p', { class: 'om-pass-note' }, !launched(cfg) ? 'Catalogue preview' : 'Available package'),
            action(h, ['Review package', icon('arrow')], event => reviewPackage(h, ctx, cfg, pkg, event.currentTarget), 'om-button om-package-review'))),
        h('p', { class: 'om-plan-disclaimer' }, launched(cfg) ? 'Use data credit for this package. Package validity is separate from the weekly credit reset.' : 'Sample package costs. Joining once with about $5 of OTT enrols you; collected trading fees fund later data.')].filter(Boolean));
      if (focusCode) [...sizes.querySelectorAll('button')].find(button => button.dataset.packageCode === focusCode)?.focus();
    }

    function chooseCoverage(source) {
      let sheet;
      const search = h('input', { id: 'om-search', class: 'om-search', type: 'search', placeholder: 'Search a country or region', autocomplete: 'off' });
      const count = h('p', { class: 'om-search-result', role: 'status', 'aria-live': 'polite' });
      const list = h('div', { class: 'om-coverage-list', 'aria-label': 'Covered countries and regions' });
      function filterPlaces() {
        const query = search.value.trim().toLocaleLowerCase();
        const matches = places.filter(place => place.name.toLocaleLowerCase().includes(query));
        count.textContent = matches.length ? matches.length + (matches.length === 1 ? ' place found' : ' places found') : 'No matching country or region. Try another name.';
        list.replaceChildren(...matches.map(place => {
          const button = action(h, [countryFlag(h, place), h('span', {}, place.name),
            h('small', {}, place.kind === 'region' ? 'Region' : 'Country'), place.slug === selectedSlug ? icon('check') : null],
          () => { selectedSlug = place.slug; paintPackages(); sheet.close(); }, 'om-coverage-option');
          button.setAttribute('aria-label', place.name);
          button.setAttribute('aria-pressed', String(place.slug === selectedSlug));
          return button;
        }));
      }
      search.addEventListener('input', filterPlaces);
      filterPlaces();
      sheet = dialog(h, 'Where will you use your data?', h('div', { class: 'om-coverage-dialog' },
        h('label', { for: 'om-search' }, 'Search a country or region'), search, count, list), source);
      search.focus();
    }
    const illustration = h('div', { class: 'om-plan-illustration' });
    paintPackages();
    if (holder) queueMicrotask(async () => {
      let state = null;
      try { state = await window.WhateverData.loadAccount(holder); } catch { /* No estimate replaces unavailable credit. */ }
      if (!ctx.isCurrent() || !options.isConnected || holderAddress(ctx) !== holder) return;
      budget = confirmedBudget(state);
      budgetEnd = budget === null ? Infinity : state.weekEnd * 1000;
      fit.disabled = budget === null;
      const notMember = !!(state && state.membership && state.membership.configured && !state.membership.member);
      budgetNote.textContent = notMember ? 'Weekly credit is for members. Join OT+T on the eSIMs screen to share next week’s budget.'
        : budget === null ? 'Current credit is unavailable. Browse all packages or refresh your account.' : 'Confirmed remaining credit: ' + money(budget);
      if (budget === null) fit.checked = false;
      paintPackages();
    });
    return h('div', { class: 'om-plans-grid' }, feature, options, illustration);
  }

  function sampleSim(h, pkg) {
    return h('article', { class: 'om-sim-card om-data-pass' }, h('div', { class: 'om-pass-content' }, chip(h),
      h('div', { class: 'om-pass-heading' }, countryFlag(h, pkg), h('h2', {}, pkg.name)),
      h('p', { class: 'om-sim-package' }, h('strong', {}, pkg.gb + ' GB package'), h('span', {}, pkg.days + ' days')),
      h('span', { class: 'om-demo-label' }, 'SAMPLE eSIM'),
      h('a', { class: 'om-button', href: '#/app/help' }, 'See setup guide ', icon('arrow'))));
  }

  function esims(h, ctx, cfg) {
    if (preview && cfg) {
      const first = cfg.packages.find(pkg => pkg.slug === 'japan' && pkg.gb === 5) || cfg.packages[0];
      const samplePackages = [first, ...demoOrders].filter(Boolean);
      return h('div', { class: 'om-kit-layout' },
        h('div', { class: 'om-kit-account' },
          h('div', { class: 'om-sim-list' }, samplePackages.map(pkg => sampleSim(h, pkg))),
          h('div', { class: 'om-kit-links' },
            h('details', {}, h('summary', {}, 'Package details'),
              h('p', {}, 'These are sample package sizes, not live remaining-data readings. Real installation details appear after a confirmed redemption.')),
            h('a', { class: 'om-connection-row', href: '#/app/help' }, icon('help'), 'How to add an eSIM', icon('arrow'))),
          h('p', { class: 'om-plan-disclaimer' }, 'Illustration only. No active eSIM. No usable QR codes or activation details are created in preview mode.'),
          action(h, 'Find another plan', () => go('plans'), 'om-text-button')), world(h, 'kit'));
    }
    if (launched(cfg)) {
      const container = h('div', { class: 'om-live-account' });
      window.WhateverData.renderMyData(container, ctx).then(() => {
        const title = container.querySelector('.dashboard-head h1');
        if (title) { const heading = h('h2', {}, title.textContent); title.replaceWith(heading); }
      });
      return container;
    }
    return h('div', { class: 'om-kit-layout' },
      h('div', { class: 'om-kit-account' }, h('section', { class: 'om-empty-state om-data-pass' }, h('div', { class: 'om-pass-content' }, chip(h),
        h('span', { class: 'om-kicker' }, 'YOUR CONNECTION KIT'), h('h2', {}, 'A place for your data.'),
        h('p', {}, cfg ? 'OTT is still in prelaunch. Try a sample account to see how packages and setup work.' : 'Go online to load your account. The setup guide still works.'),
        cfg ? action(h, 'Explore a sample account', () => enterPreview(ctx)) : action(h, 'Try again', () => ctx.refresh()))),
      h('a', { class: 'om-home-footnote om-text-link', href: '#/app/help' }, 'See how eSIM setup works ', icon('arrow'))), world(h, 'kit'));
  }

  function help(h, cfg) {
    const guide = h('div', { class: 'om-setup-guide' });
    const ios = action(h, 'iPhone', () => { helpPlatform = 'iphone'; helpStep = 0; paintGuide(); }, 'om-platform-button');
    const android = action(h, 'Android', () => { helpPlatform = 'android'; helpStep = 0; paintGuide(); }, 'om-platform-button');
    function paintGuide() {
      const iphone = helpPlatform === 'iphone';
      ios.setAttribute('aria-pressed', String(iphone)); android.setAttribute('aria-pressed', String(!iphone));
      const steps = iphone ? [
        ['Get connected first', 'Use Wi-Fi or your existing mobile connection. Your iPhone must support eSIMs and be unlocked.'],
        ['Open your eSIM in OTT', 'After redeeming, open eSIMs and reveal your installation details with your wallet.'],
        ['Add the eSIM', 'If an iPhone install link is provided, open it and follow Apple’s prompts. On iOS 17.4 or later, you can also press and hold the QR code in Safari and choose Add eSIM.'],
        ['Choose your data line', 'In Settings, open Cellular or Mobile Data and choose the new eSIM for mobile data. Keep your existing line for calls and texts. Follow the provider’s roaming instructions. Within coverage, turn Wi-Fi off and load a webpage to check the new connection.'],
      ] : [
        ['Get connected first', 'Use Wi-Fi or your existing mobile connection. Check that your phone supports eSIMs and is unlocked.'],
        ['Open your eSIM in OTT', 'After redeeming, open eSIMs and reveal your installation details with your wallet.'],
        ['Add the eSIM in Settings', 'On Pixel, go to Network & internet, SIMs, Add SIM, then Set up an eSIM. On other Android phones, look for Add eSIM in SIM settings. Use the provider link where supported, scan the QR from another screen, or enter the manual details.'],
        ['Choose your data line', 'Select the new eSIM for mobile data. Keep your existing line for calls and texts. Follow the provider’s roaming instructions. Within coverage, turn Wi-Fi off and load a webpage to check the new connection.'],
      ];
      const step = Math.min(helpStep, steps.length - 1);
      const labels = ['Prepare', 'Your eSIM', 'Add eSIM', 'Get online'];
      const progress = h('div', { class: 'om-step-progress', role: 'group', 'aria-label': 'Setup steps' }, steps.map(([title], index) => {
        const button = action(h, [h('span', {}, String(index + 1)), h('span', {}, labels[index])], () => { helpStep = index; paintGuide(); guide.querySelectorAll('.om-step-progress button')[index].focus(); }, 'om-step-tab');
        button.setAttribute('aria-label', 'Step ' + (index + 1) + ': ' + title);
        button.setAttribute('aria-pressed', String(index === step));
        return button;
      }));
      const back = action(h, 'Back', () => { helpStep--; paintGuide(); guide.querySelector('.om-step-controls button').focus(); }, 'om-secondary-button');
      back.disabled = step === 0;
      const next = step < steps.length - 1
        ? action(h, ['Next step', icon('arrow')], () => { helpStep++; paintGuide(); guide.querySelectorAll('.om-step-progress button')[helpStep].focus(); })
        : h('a', { class: 'om-button', href: preview || launched(cfg) ? '#/app/esims' : '#/app/plans' },
          preview ? 'View sample eSIMs ' : launched(cfg) ? 'Open my eSIMs ' : 'Browse plans ', icon('arrow'));
      guide.replaceChildren(progress, h('p', { class: 'om-step-count' }, 'Step ' + (step + 1) + ' of ' + steps.length),
        h('ol', { class: 'om-steps', start: step + 1, 'aria-live': 'polite' }, h('li', {},
          h('span', { class: 'om-step-number', 'aria-hidden': 'true' }, String(step + 1).padStart(2, '0')),
          h('div', {}, h('h3', {}, steps[step][0]), h('p', {}, steps[step][1])))),
        h('div', { class: 'om-step-controls' }, back, next),
      h('a', { class: 'om-text-link', href: iphone ? 'https://support.apple.com/en-gb/118669' : 'https://support.google.com/pixelphone/answer/16115470?hl=en', target: '_blank', rel: 'noopener' }, iphone ? 'Apple’s eSIM setup guide ↗' : 'Google’s eSIM setup guide ↗'));
    }
    paintGuide();
    return h('div', { class: 'om-help-grid' },
      h('section', { class: 'om-panel om-guide-panel', 'aria-label': 'eSIM setup guide' },
        h('p', { class: 'om-screen-lede' }, 'OTT gives you the installation details. Your phone confirms and completes setup.'),
        action(h, 'Check your phone', event => checkPhone(h, event.currentTarget), 'om-secondary-button om-device-check-button'),
        action(h, 'Installed but no data?', event => troubleshoot(h, event.currentTarget, helpPlatform), 'om-secondary-button om-troubleshooting-button'),
        h('div', { class: 'om-platform-switch', role: 'group', 'aria-label': 'Phone type' }, ios, android), guide),
      h('section', { class: 'om-panel om-help-notes' },
        h('img', { src: './assets/ott/faq-clay-help.webp', alt: '', loading: 'lazy', width: 720, height: 720 }),
        h('h2', {}, 'Before you connect'),
        h('details', {}, h('summary', {}, 'How will I get an eSIM with OTT?'), h('p', {}, 'Membership starts with one send of about $5 of OTT to Solana’s burn address, which enrols you and includes your first eSIM. After that, collected trading fees fund members’ data through a shared pool. Holding tokens or connecting a wallet alone does not enrol you.' + (launched(cfg) ? '' : ' Joining opens when OTT launches.')), h('a', { class: 'om-text-link', href: '#/about' }, 'Read the membership plan ', icon('arrow'))),
        h('details', {}, h('summary', {}, 'Do I pay again for every top-up?'), h('p', {}, 'No. Joining is a one-time send, and membership doesn’t expire. Weekly data is then funded by collected trading fees and spent as credit. The credit changes with fees and the number of members; unlimited data is not promised.')),
        h('details', {}, h('summary', {}, 'What happens if my welcome eSIM is delayed?'), h('p', {}, 'Your membership is recorded on-chain the moment your join confirms, and it stays yours. If the welcome eSIM can’t be issued straight away, for example while the reserve is being topped up, claim it later from eSIMs without sending OTT again. The OTT you sent can’t be refunded.')),
        h('details', {}, h('summary', {}, 'Can I set it up on the same phone?'), h('p', {}, 'Use the provider’s installation link if one is available. Otherwise, use manual details or display the QR on another screen. Supported iPhones can also add an eSIM from a QR shown in Safari.')),
        h('details', {}, h('summary', {}, launched(cfg) ? 'Does weekly credit become cash?' : 'Can I withdraw the data balance?'), h('p', {}, launched(cfg) ? 'No. Credit can be spent on available data packages. It cannot be withdrawn, and unused weekly credit expires at the weekly reset.' : 'The proposed balance is for mobile data, not cash withdrawals. The final membership terms will explain how balances are allocated and whether unused amounts accumulate or expire. The preview uses example figures.')),
        h('details', {}, h('summary', {}, 'Will the app show my remaining GB?'), h('p', {}, 'It shows package sizes and order details. Live remaining-data readings are not available in this version.')),
        h('details', {}, h('summary', {}, 'How do I connect my wallet?'), h('p', {}, 'Tap Connect wallet on Home. OTT works with Solana wallets such as Phantom and Solflare. On a phone, open OTT inside your wallet app’s browser; OTT offers a link that does this. Connecting does not move funds. Joining, redemptions and installation details each ask for your approval in the wallet. You can disconnect in Wallet settings.')),
        h('a', { class: 'om-text-link', href: '#/status' }, 'Check programme status ', icon('arrow'))));
  }

  function troubleshoot(h, source, initialPlatform) {
    let platform = initialPlatform || (/Android/i.test(navigator.userAgent) ? 'android' : 'iphone');
    const content = h('div', { class: 'om-guide-copy om-troubleshooting' });
    function paint() {
      const iphone = platform === 'iphone';
      const platforms = h('div', { class: 'om-platform-switch', role: 'group', 'aria-label': 'Phone type' }, ['iphone', 'android'].map(key => {
        const button = action(h, key === 'iphone' ? 'iPhone' : 'Android', () => {
          platform = key; paint(); content.querySelector('[aria-pressed="true"]').focus();
        }, 'om-platform-button');
        button.setAttribute('aria-pressed', String(platform === key));
        return button;
      }));
      const support = (label, href) => h('a', { class: 'om-text-link', href, target: '_blank', rel: 'noopener noreferrer' }, label + ' ↗');
      content.replaceChildren(
        h('p', {}, 'Check these settings on your phone. OTT cannot detect whether your eSIM is installed or connected.'),
        ...(preview ? [h('p', { class: 'om-inline-note' }, 'Preview only. Sample eSIMs cannot connect to a mobile network.')] : []),
        platforms,
        h('ol', { class: 'om-device-checklist' },
          h('li', {}, h('h3', {}, 'Select the installed data eSIM'), h('p', {}, iphone
            ? 'In Settings → Cellular or Mobile Data, enable the installed eSIM with Turn On This Line. Under Cellular Data, select that eSIM.'
            : 'In Settings → Network & internet → SIMs, select the installed eSIM. Check Use SIM and Mobile data, and choose it for mobile data. Names vary on other Android phones.')),
          h('li', {}, h('h3', {}, 'Check coverage and validity'), h('p', {}, 'Use the package inside its coverage and follow its activation and validity instructions. OTT shows package details, not live remaining-data readings.')),
          h('li', {}, h('h3', {}, 'Follow the provider’s roaming instructions'), h('p', {}, 'Change roaming only for this data eSIM if its provider requires it. Leave your regular line’s roaming settings alone.')),
          h('li', {}, h('h3', {}, 'Test this data line'), h('p', {}, 'Turn Wi-Fi off and load a webpage. If it still does not load, turn Wi-Fi back on and contact your eSIM provider with the error shown in your phone’s settings.'))),
        h('p', { class: 'om-muted' }, 'Keep your QR and activation code private when asking for help.'),
        iphone ? support('Apple’s cellular data guide', 'https://support.apple.com/en-us/118227')
          : support('Google Pixel mobile data guide', 'https://support.google.com/pixelphone/answer/2926415?hl=en'),
        iphone ? support('Apple’s roaming guide', 'https://support.apple.com/en-us/109037')
          : support('Google Pixel troubleshooting', 'https://support.google.com/pixelphone/answer/14116080?hl=en'));
    }
    paint();
    dialog(h, 'Installed but no data?', content, source);
  }

  function checkPhone(h, source) {
    let device = /Android/i.test(navigator.userAgent) ? 'pixel' : 'iphone';
    const content = h('div', { class: 'om-guide-copy om-device-guide' });
    const devices = { iphone: 'iPhone', pixel: 'Google Pixel', samsung: 'Samsung Galaxy' };
    function support(title, href) {
      return h('a', { class: 'om-text-link', href, target: '_blank', rel: 'noopener noreferrer' }, title + ' ↗');
    }
    function paint() {
      const chooser = h('div', { class: 'om-device-switch', role: 'group', 'aria-label': 'Device to check' }, Object.entries(devices).map(([key, name]) => {
        const button = action(h, name, () => { device = key; paint(); content.querySelector('[aria-pressed="true"]').focus(); }, 'om-platform-button');
        button.setAttribute('aria-pressed', String(device === key));
        return button;
      }));
      const path = device === 'iphone' ? 'Settings → Cellular or Mobile Data → Add eSIM'
        : device === 'pixel' ? 'Settings → Network & internet → SIMs → Add SIM → Set up an eSIM'
          : 'Settings → Connections → SIM manager → Add eSIM';
      content.replaceChildren(
        h('p', {}, 'Do these checks before choosing a real package. You can check now, while OTT is in prelaunch.'), chooser,
        h('ol', { class: 'om-device-checklist' },
          h('li', {}, h('h3', {}, 'Find the eSIM option'), h('p', { class: 'om-settings-path' }, path),
            h('p', {}, device === 'samsung' ? 'Older Galaxy software may say SIM card manager or Add mobile plan. Support varies by model, region and carrier.' : 'Look for this option without starting an installation. Support varies by model and region.'),
            support(devices[device] + ' eSIM guidance', device === 'iphone' ? 'https://support.apple.com/en-us/118669'
              : device === 'pixel' ? 'https://support.google.com/pixelphone/answer/16115470?hl=en'
                : 'https://www.samsung.com/us/support/answer/ANS10001619/')),
          h('li', {}, h('h3', {}, 'Check your carrier lock'),
            device === 'iphone' ? h('p', {}, 'Open Settings → General → About. Under Carrier Lock, look for “No SIM restrictions”.')
              : h('p', {}, 'Ask your current carrier whether this phone is unlocked for another provider’s data eSIM. An Add eSIM option alone does not confirm that it is unlocked.'),
            device === 'iphone' ? support('Apple’s carrier lock guide', 'https://support.apple.com/en-us/109316') : null),
          h('li', {}, h('h3', {}, 'Keep a connection for setup'), h('p', {}, 'Use Wi-Fi or another working internet connection when adding the eSIM. Keep your current line until the new data line works.'))),
        h('p', { class: 'om-inline-note' }, 'OTT cannot detect your phone’s eSIM support or carrier lock. If an option is missing or you’re unsure, confirm your exact model with the manufacturer and carrier before redeeming.'));
    }
    paint();
    dialog(h, 'Check your phone', content, source);
  }

  function unavailable(h, ctx, message) {
    return h('section', { class: 'om-empty-state' }, icon('help'), h('h2', {}, 'You’re offline, or OTT couldn’t load.'),
      h('p', {}, message), action(h, 'Try again', () => ctx.refresh()), h('a', { class: 'om-text-link', href: '#/app/help' }, 'Open the setup guide ', icon('arrow')));
  }

  async function render(view, ctx, requestedScreen) {
    const { h } = ctx;
    const screen = SCREENS.includes(requestedScreen) ? requestedScreen : 'home';
    const shell = h('div', { class: 'om-shell om-screen-' + screen });
    const installButton = action(h, [icon('download'), h('span', {}, 'Add to phone')], event => install(h, event.currentTarget), 'om-install-button');
    const status = h('span', { class: 'om-status-pill' }, 'Loading');
    const header = h('header', { class: 'om-header' },
      h('a', { class: 'om-brand', href: '#/app', 'aria-label': 'OTT app home' },
        h('img', { class: 'om-brand-art', src: './assets/app/app-clay-logo.webp', alt: 'OT+T', width: 1860, height: 845, decoding: 'async' })),
      h('div', { class: 'om-header-actions' }, status, installButton));
    const nav = h('nav', { class: 'om-nav', 'aria-label': 'App navigation' }, SCREENS.map(name => h('a', {
      href: name === 'home' ? '#/app' : '#/app/' + name,
      class: name === screen ? 'is-active' : '', 'aria-current': name === screen ? 'page' : null,
    }, icon(name), h('span', {}, LABELS[name]))), h('a', { class: 'om-website-link', href: '#/' }, 'Visit the website ↗'));
    const body = h('div', { class: 'om-body' });
    const heading = screen === 'home' ? null : h('div', { class: 'om-heading' },
      h('p', { class: 'om-home-eyebrow' }, 'OT+T / ' + LABELS[screen].toUpperCase()),
      h('h1', {}, { plans: 'Find your data plan.', esims: 'Your eSIMs.', help: 'Set up your eSIM' }[screen]));
    const contents = h('div', { class: 'om-content' }, h('p', { class: 'om-loading', role: 'status' }, 'Loading OTT…'));
    shell.append(header, nav, body); if (heading) body.append(heading); body.append(contents); view.appendChild(shell);
    window.OTTPwa?.register?.();
    let cfg = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch('./config/esim.json', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Configuration unavailable');
      const json = await response.json();
      if (!Array.isArray(json.packages)) throw new Error('Catalogue unavailable');
      const packages = json.packages.filter(pkg => pkg && ['code', 'slug', 'name'].every(key => typeof pkg[key] === 'string' && pkg[key].trim())
        && Number.isFinite(pkg.gb) && pkg.gb > 0 && Number.isFinite(pkg.priceUsd) && pkg.priceUsd > 0 && Number.isInteger(pkg.days) && pkg.days > 0);
      if (!packages.length) throw new Error('Catalogue unavailable');
      cfg = { ...json, packages };
    } catch { /* No saved financial state is used as an offline substitute. */ }
    finally { clearTimeout(timeout); }
    if (!ctx.isCurrent() || !view.contains(shell)) return;
    status.textContent = cfg ? preview ? 'Preview' : launched(cfg) ? 'Configured' : 'Prelaunch' : 'Offline';
    const screenContent = screen === 'plans' ? plans(h, ctx, cfg) : screen === 'esims' ? esims(h, ctx, cfg) : screen === 'help' ? help(h, cfg) : cfg ? home(h, ctx, cfg) : unavailable(h, ctx, 'Credit and orders need a live connection. The setup guide still works.');
    contents.replaceChildren(screenContent);
    if (preview && cfg) body.insertBefore(previewBanner(h, ctx), contents);
    else if (cfg && !launched(cfg) && screen !== 'home') body.insertBefore(h('p', { class: 'om-prelaunch-note' }, 'Membership enrolment is not open. Preview only.'), contents);
  }

  window.OTTMobileApp = {
    render, openSetup,
    reviewDestination(ctx, cfg, slug, source) {
      if (!ctx.isCurrent() || !source.isConnected) return;
      const packages = cfg.packages.filter(pkg => pkg.slug === slug).sort((a, b) => a.priceUsd - b.priceUsd);
      const pkg = packages[0];
      if (!pkg) return;
      selectedSlug = slug; selectedCode = pkg.code;
      reviewPackage(ctx.h, ctx, cfg, pkg, source);
    },
    dispose: () => document.querySelectorAll('.om-dialog').forEach(sheet => { sheet.close(); sheet.remove(); }),
  };
})();
