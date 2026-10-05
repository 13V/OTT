'use strict';
/** An interactive example of My data. It never reads a wallet or places an order. */
(function () {
  function render(h, configured) {
    const credit = h('div', { class: 'ott-ap-view ott-ap-credit', id: 'account-credit-example' },
      h('div', { class: 'ott-ap-credit-card ott-statement-balance' },
        h('span', { class: 'ott-ap-label' }, 'Remaining weekly credit'),
        h('strong', { class: 'ott-ap-money' }, '$15.00'),
        h('p', {}, 'Ready for your next data package.'),
        h('div', { class: 'ott-ap-credit-track', 'aria-hidden': 'true' }, h('span')),
        h('div', { class: 'ott-ap-credit-stats' },
          h('span', {}, 'Allocated ', h('strong', {}, '$20.00')),
          h('span', {}, 'Used ', h('strong', {}, '$5.00')))),
      h('div', { class: 'ott-ap-reset' },
        h('span', { class: 'ott-ap-reset-symbol', 'aria-hidden': 'true' }, '↻'),
        h('div', {}, h('strong', {}, 'Credit has a weekly reset'), h('p', {}, 'Unused weekly credit expires at the weekly reset.'))));

    const sim = h('div', { class: 'ott-ap-view ott-ap-sims', id: 'account-esim-example', hidden: true },
      h('div', { class: 'ott-ap-esim-card' },
        h('div', { class: 'ott-ap-esim-top' },
          h('span', { class: 'ott-ap-label' }, 'Sample eSIM'),
          h('span', { class: 'ott-ap-package-label' }, 'Data only')),
        h('div', { class: 'ott-ap-destination' },
          h('img', { src: './assets/flags/jp.svg', alt: '', width: '36', height: '27' }),
          h('h3', {}, 'Japan')),
        h('div', { class: 'ott-ap-package-size' }, h('strong', {}, '5'), h('span', {}, 'GB')),
        h('div', { class: 'ott-ap-package-bottom' },
          h('span', {}, 'Package validity'), h('strong', {}, '30 days')),
        h('div', { class: 'ott-ap-sim-chip', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'))),
      h('div', { class: 'ott-ap-reset' },
        h('span', { class: 'ott-ap-reset-symbol', 'aria-hidden': 'true' }, 'i'),
        h('div', {}, h('strong', {}, 'Your eSIM has its own expiry'), h('p', {}, 'Package validity is separate from the weekly credit reset. Check activation rules before redeeming.'))));

    const tabs = h('div', { class: 'ott-ap-switch', role: 'group', 'aria-label': 'Sample account view' });
    const choose = (name) => {
      credit.hidden = name !== 'credit';
      sim.hidden = name !== 'sims';
      creditButton.setAttribute('aria-pressed', String(name === 'credit'));
      simButton.setAttribute('aria-pressed', String(name === 'sims'));
    };
    const creditButton = h('button', { type: 'button', 'aria-pressed': 'true', 'aria-controls': credit.id, onclick: () => choose('credit') }, 'Weekly credit');
    const simButton = h('button', { type: 'button', 'aria-pressed': 'false', 'aria-controls': sim.id, onclick: () => choose('sims') }, 'eSIMs', h('span', { class: 'ott-ap-count', 'aria-hidden': 'true' }, '1'));
    tabs.append(creditButton, simButton);

    const statement = h('div', { class: 'ott-statement ott-ap-console', 'aria-label': 'Sample My data account' },
      h('div', { class: 'ott-ap-console-head' },
        h('strong', { class: 'ott-ap-brand' }, 'OT+T'),
        h('span', { class: 'ott-ap-demo-wallet' }, h('span', { 'aria-hidden': 'true' }), 'Demo wallet')),
      h('p', { class: 'ott-ap-example-label' }, 'SAMPLE ACCOUNT. EXAMPLE ONLY.'),
      tabs,
      h('div', { class: 'ott-ap-content', 'aria-live': 'polite', 'aria-atomic': 'true' }, credit, sim),
      h('p', { class: 'ott-ap-footnote' }, 'These figures show an example, not your wallet balance.'));

    return h('section', { class: 'section ott-account-preview', 'aria-labelledby': 'account-preview-title' },
      h('div', { class: 'wrap ott-ap-wrap' },
        h('div', { class: 'ott-ap-header' },
          h('div', {}, h('span', { class: 'ott-eyebrow' }, 'MY DATA'), h('h2', { id: 'account-preview-title' }, 'Your wallet.', h('br'), 'Your data.')),
          h('div', { class: 'ott-ap-intro' },
            h('p', {}, configured ? 'See your remaining credit and manage the eSIMs linked to your wallet.' : 'Explore plans, example credit and eSIM setup in the app preview. No wallet needed. No real orders.'),
            h('a', { class: 'ott-primary-action', href: configured ? '#/data' : '#/app' }, configured ? 'Open My data' : 'Explore the app', h('span', { 'aria-hidden': 'true' }, ' ↗')))),
        h('div', { class: 'ott-ap-product' },
          h('figure', { class: 'ott-ap-world' },
            h('img', { src: './assets/ott/mydata-lounge-world.webp', alt: 'Our clay holder checking his phone in an orange armchair before heading out, with his dog curled at his feet.', width: '1254', height: '1254', loading: 'lazy', decoding: 'async' })),
          h('div', { class: 'ott-ap-device' },
            h('div', { class: 'ott-ap-device-top', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
            statement,
            h('div', { class: 'ott-ap-device-bottom', 'aria-hidden': 'true' }, h('span'))))));
  }
  window.WhateverAccountPreview = { render };
}());
