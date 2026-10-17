'use strict';
/** The public membership story and its published rules. No wallet, API or enrolment actions. */
(function () {
  const image = (h, name, alt, attrs = {}) => h('img', {
    src: './assets/ott/' + name, alt, decoding: 'async', loading: 'lazy', ...attrs,
  });
  const head = (h, label, title, body) => h('div', { class: 'ott-section-head' },
    h('span', { class: 'ott-eyebrow' }, label), h('h2', {}, title), h('p', {}, body));
  const money = (value) => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const count = (value) => value.toLocaleString('en-US');
  const chapter = (h, number, label) => h('p', { class: 'ott-member-chapter' },
    h('span', {}, number), label);
  // The published membership terms, read from config/esim.json. Every sentence that uses them
  // still reads correctly when one is missing, and none of them invents a figure.
  function terms(cfg) {
    const m = cfg && cfg.membership && typeof cfg.membership === 'object' ? cfg.membership : {};
    const burn = /^\d{1,30}$/.test(String(m.burnTokens || '')) ? Number(m.burnTokens).toLocaleString('en-US') + ' OTT' : '';
    const w = m.welcome && typeof m.welcome === 'object' ? m.welcome : null;
    const welcome = w && [w.gb, w.days, w.maxUsd].every((v) => Number.isFinite(Number(v)) && Number(v) > 0)
      ? 'any ' + Number(w.gb) + ' GB, ' + Number(w.days) + '-day plan up to ' + money(Number(w.maxUsd)) : '';
    const cap = Number.isFinite(Number(m.capMultiple)) && Number(m.capMultiple) > 0 ? Number(m.capMultiple) : null;
    const bps = Number(cfg && cfg.budgetBps);
    const share = Number.isFinite(bps) && bps > 0 && bps <= 10000 ? bps / 100 : null;
    return { burn, welcome, cap, share };
  }

  function journey(h, cfg, launched) {
    const t = terms(cfg);
    return h('section', { class: 'section ott-journey ott-membership-journey', id: 'how-it-works' }, h('div', { class: 'wrap' },
      head(h, 'THE MEMBERSHIP', 'Burn once. Stay connected.',
        'Burn ' + (t.burn || 'OTT') + ' once to join and get your first eSIM. Collected trading fees then fund weekly data for members. No repeat burn for each top-up.'),
      h('div', { class: 'ott-member-route', 'aria-label': 'Membership flow' },
        h('span', {}, 'ONE BURN'), h('span', { 'aria-hidden': 'true' }, '→'),
        h('span', {}, 'FEES FUND DATA'), h('span', { 'aria-hidden': 'true' }, '→'), h('span', {}, 'MEMBERS GET CONNECTED')),
      h('div', { class: 'ott-member-enrol' },
        h('figure', { class: 'ott-member-enrol-art' },
          image(h, 'membership-burn-world.png', 'The adult clay OTT traveller stands holding an orange eSIM membership pass in one hand and an OTT token with a sculpted clay flame in the other.', { width: '1122', height: '1402' }),
          h('figcaption', {}, 'An OTT membership illustration')),
        h('div', { class: 'ott-member-enrol-copy' }, chapter(h, '01', 'GET YOUR PASS'),
          h('h3', {}, 'One burn. Your first eSIM.'),
          h('p', {}, 'Join once by burning ' + (t.burn || 'OTT') + ' from your wallet. Your membership starts with a welcome eSIM for a compatible, unlocked phone.'),
          h('div', { class: 'ott-member-pass' },
            h('div', { class: 'ott-member-pass-head' }, h('strong', {}, 'OT+T'), h('span', {}, 'MEMBERSHIP PASS')),
            h('div', { class: 'ott-member-pass-body' },
              h('span', { class: 'ott-member-pass-chip', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i')),
              h('div', {}, h('strong', {}, 'One-time burn'), h('span', {}, 'Then a weekly share of collected fees'))),
            h('p', { class: 'ott-member-pass-note' }, launched ? (t.burn ? 'BURN ' + t.burn.toUpperCase() : 'ONE BURN') : (t.burn ? t.burn.toUpperCase() + ' · ' : '') + 'ENROLMENT OPENS AT LAUNCH')),
          h('p', { class: 'ott-member-small' }, (t.welcome ? 'Your first eSIM: ' + t.welcome + '. ' : '') + 'Membership doesn’t expire.'))),
      h('div', { class: 'ott-member-ongoing', role: 'list', 'aria-label': 'How fees fund ongoing data' },
        h('article', { class: 'ott-member-stop', role: 'listitem' },
          chapter(h, '02', 'FILL THE DATA POOL'),
          h('figure', { class: 'ott-member-world' }, image(h, 'journey-budget-world.webp', 'Clay OTT traveller checking the data budget over breakfast.', { width: '1024', height: '1024' })),
          h('div', { class: 'ott-member-stop-copy' }, h('h3', {}, 'Trading fees pay for data.'),
            h('p', {}, (t.share ? t.share + '% of the fees actually collected each week becomes the next week’s member data budget. ' : 'A published share of the fees actually collected each week becomes the member data budget. ')
              + 'The rest stays in the pool as a reserve for welcome eSIMs and payment costs.'),
            h('p', { class: 'ott-member-small' }, 'Unused weekly credit expires. The money stays in the pool for future data.'))),
        h('article', { class: 'ott-member-stop', role: 'listitem' },
          chapter(h, '03', 'GO SOMEWHERE'),
          h('figure', { class: 'ott-member-world' }, image(h, 'journey-connection-world.webp', 'Clay OTT traveller using his phone to find his way through Tokyo.', { width: '1024', height: '1024' })),
          h('div', { class: 'ott-member-stop-copy' }, h('h3', {}, 'Members use their data credit.'),
            h('p', {}, 'Install your eSIM privately. Then use your weekly credit for data at home or on your next trip, with compatible top-ups where available. No additional burn for each data package.'),
            h('p', { class: 'ott-member-small' }, 'Your weekly share follows the OTT you hold at the Monday snapshot' + (t.cap ? ', and no member gets more than ' + t.cap + '× the average' : '') + '. It is not unlimited data.')))),
      h('p', { class: 'ott-journey-note ott-member-launch-note' }, h('strong', {}, launched ? 'Before you burn. ' : 'Prelaunch. '),
        (launched ? '' : 'Enrolment opens when OTT launches. ') + 'A burn is final: tokens sent to the burn address can’t be refunded. ',
        h('a', { href: '#trust' }, 'See what happens when you burn ↗'))));
  }

  function allocation(h, cfg) {
    const t = terms(cfg);
    const disclaimerIds = 'ott-allocation-disclaimer ott-example-error';
    const fees = h('input', { id: 'ott-example-budget', type: 'number', min: '0', max: String(Number.MAX_SAFE_INTEGER / 7), step: 'any', value: '1000', inputmode: 'decimal', 'aria-describedby': disclaimerIds });
    const percent = h('input', { id: 'ott-example-percent', type: 'number', min: '0', max: '100', step: 'any', value: String(t.share || 80), inputmode: 'decimal', 'aria-describedby': disclaimerIds + ' ott-example-percent-help' });
    const members = h('input', { id: 'ott-example-members', type: 'number', min: '1', max: String(Number.MAX_SAFE_INTEGER), step: '1', value: '1000', inputmode: 'numeric', 'aria-describedby': disclaimerIds });
    const result = h('output', { class: 'ott-allocation-result', for: 'ott-example-budget ott-example-percent ott-example-members', 'aria-label': 'Illustrative weekly data credit', 'aria-live': 'polite' });
    const weekly = h('strong');
    const pool = h('strong', { class: 'ott-allocation-budget' });
    const memberCount = h('strong', { class: 'ott-example-member-count' });
    const reserve = h('strong');
    const most = h('strong', { class: 'ott-example-cap' });
    const explanation = h('p', { class: 'ott-allocation-explanation' });
    const error = h('p', { id: 'ott-example-error', class: 'ott-example-error', role: 'status' });
    const validNumber = (input, predicate) => input.value.trim() !== '' && Number.isFinite(Number(input.value)) && predicate(Number(input.value));
    function calculate() {
      const feeValid = validNumber(fees, (value) => value >= 0 && value <= Number.MAX_SAFE_INTEGER / 7);
      const percentValid = validNumber(percent, (value) => value >= 0 && value <= 100);
      const membersValid = validNumber(members, (value) => Number.isSafeInteger(value) && value >= 1);
      const valid = feeValid && percentValid && membersValid;
      fees.setAttribute('aria-invalid', String(!feeValid));
      percent.setAttribute('aria-invalid', String(!percentValid));
      members.setAttribute('aria-invalid', String(!membersValid));
      error.textContent = valid ? '' : 'Enter daily fees of $0 or more, a data allocation from 0% to 100%, and at least one whole enrolled user. Use finite values within the input limits.';
      if (!valid) {
        [weekly, pool, memberCount, reserve, result, most].forEach((el) => { el.textContent = '—'; });
        explanation.textContent = 'Complete the three example inputs to see how the funded pool could be shared.';
        return;
      }
      const collected = Number(fees.value) * 7;
      const funded = collected * (Number(percent.value) / 100);
      const number = Number(members.value);
      weekly.textContent = money(collected);
      pool.textContent = money(funded);
      memberCount.textContent = count(number);
      reserve.textContent = money(collected - funded);
      result.textContent = money(funded / number);
      // With one member there is no one to share an excess with: the cap is the whole budget.
      most.textContent = t.cap ? money(Math.min(funded, t.cap * funded / number)) : '—';
      explanation.textContent = 'At ' + money(Number(fees.value)) + ' in daily fees and a ' + Number(percent.value) + '% example data allocation, ' + money(funded) + ' per week is shared among ' + count(number) + ' ' + (number === 1 ? 'member' : 'members') + ' by holdings: ' + money(funded / number) + ' each on average'
        + (t.cap ? ', and no member gets more than ' + money(Math.min(funded, t.cap * funded / number)) + '.' : '.');
    }
    [fees, percent, members].forEach((input) => input.addEventListener('input', calculate));
    calculate();
    const row = (label, value, attrs = {}) => h('div', { class: 'ott-member-receipt-row', ...attrs }, h('span', {}, label), value);
    return h('section', { class: 'section ott-allocation ott-member-allocation', id: 'data-pool' }, h('div', { class: 'wrap' },
      head(h, 'FEES IN. DATA OUT.', 'A shared pool. A clear allowance.',
        'Here is how a funded pool is shared among members. More collected fees means more data; more members means a smaller average share.'),
      h('div', { class: 'ott-member-example' },
        h('div', { class: 'ott-member-receipt' },
          h('div', { class: 'ott-member-receipt-head' }, h('strong', {}, 'OT+T'), h('span', {}, 'THE DATA POOL / EXAMPLE')),
          h('div', { class: 'ott-member-receipt-lines', 'aria-label': 'Illustrative weekly pool calculation' },
            row('Fees collected / week', weekly), row('Allocated to data / week', pool), row('Enrolled users', memberCount),
            row('Average credit / member', result, { class: 'ott-member-receipt-row ott-member-receipt-total' }),
            t.cap ? row('Most any member gets', most) : null),
          h('p', { class: 'ott-member-reserve' }, 'Other costs and reserves / week ', reserve),
          h('span', { class: 'ott-member-example-stamp' }, 'ILLUSTRATIVE ONLY')),
        h('div', { class: 'ott-member-controls' },
          h('h3', {}, 'Try the numbers.'),
          h('p', { id: 'ott-allocation-disclaimer', class: 'ott-example-label' }, 'Example only. This is not your balance or a forecast.'),
          h('div', { class: 'ott-member-field' }, h('label', { for: 'ott-example-budget' }, 'Daily fees collected ($)'), fees),
          h('div', { class: 'ott-member-field' }, h('label', { for: 'ott-example-percent' }, 'Example data allocation (%)'), percent,
            h('p', { id: 'ott-example-percent-help' }, t.share ? 'OT+T allocates ' + t.share + '% of collected fees to member data. Try other numbers here.' : 'Try any allocation.')),
          h('div', { class: 'ott-member-field' }, h('label', { for: 'ott-example-members' }, 'Enrolled users'), members), error)),
      explanation,
      h('p', { class: 'ott-member-allocation-note' }, 'Example only. Each member’s share follows the OTT they hold at the Monday snapshot' + (t.cap ? ', capped at ' + t.cap + '× the average' : '') + '. One membership per wallet. Unused weekly credit expires. Funds must back the credit issued. ',
        h('a', { href: '#/about' }, 'Read the current programme rules ↗'))));
  }

  function trust(h, cfg, launched) {
    const t = terms(cfg);
    const item = (number, title, detail, status) => h('li', {},
      h('span', { class: 'ott-trust-number' }, number),
      h('div', {}, h('h3', {}, title), h('p', {}, detail)), h('span', { class: 'ott-trust-state' }, status));
    return h('section', { class: 'section ott-membership-trust', id: 'trust' }, h('div', { class: 'wrap' },
      head(h, 'TRUST YOU CAN CHECK', 'Your connection. With a clear receipt.',
        'A burn is final, so the rules, the money trail and what protects your first eSIM are set out here before you commit tokens.'),
      h('div', { class: 'ott-trust-layout' },
        h('aside', { class: 'ott-trust-receipt', 'aria-label': 'Illustrative enrolment receipt' },
          h('div', { class: 'ott-trust-receipt-head' }, h('strong', {}, 'OT+T'), h('span', {}, 'YOUR ENROLMENT RECEIPT')),
          h('p', { class: 'ott-trust-receipt-status' }, 'ILLUSTRATION · NO ENROLMENT SUBMITTED'),
          h('ol', { class: 'ott-trust-claim-steps' },
            h('li', {}, h('span', {}, '01'), h('div', {}, h('strong', {}, 'You confirm, then burn ' + (t.burn || 'OTT')), h('p', {}, 'Your wallet sends it to the burn address. It can’t be undone or refunded.'))),
            h('li', {}, h('span', {}, '02'), h('div', {}, h('strong', {}, 'Membership recorded on-chain'), h('p', {}, 'The burn is a public transaction you can check yourself on the explorer.'))),
            h('li', {}, h('span', {}, '03'), h('div', {}, h('strong', {}, 'Claim your welcome eSIM'), h('p', {}, 'If issuing it is delayed, your membership stays and you can claim later without burning again.')))),
          h('p', { class: 'ott-trust-receipt-foot' }, launched ? 'The app offers the burn only while the reserve can pay for a welcome eSIM.' : 'Enrolment opens when OTT launches. No burn can be submitted before then.')),
        h('div', { class: 'ott-trust-ledger' },
          h('p', { class: 'ott-trust-ledger-label' }, 'BEFORE ENROLMENT OPENS'),
          h('ol', {},
            item('01', 'Publish the exact rules.', [t.burn ? 'Burn ' + t.burn + ' once.' : 'One burn to join.', t.welcome ? 'Welcome eSIM: ' + t.welcome + '.' : '',
              t.share ? t.share + '% of collected fees to member data.' : '', t.cap ? 'Weekly shares follow holdings, capped at ' + t.cap + '× the average.' : ''].filter(Boolean).join(' '), 'Rules published'),
            item('02', 'Protect the first delivery.', 'The app offers the burn only while the reserve can pay for a welcome eSIM. A delayed claim can be retried without another burn.', 'Reserve check built'),
            item('03', 'Launch the token.', 'Publish the coin, curve and treasury addresses. Enrolment and purchases stay closed until then.', launched ? 'Token launched' : 'Launch pending'),
            item('04', 'Prove the phone connection.', 'A supplier eSIM has been installed and used for mobile data on a real phone. OTT’s own automated purchase is verified at launch.', 'Automated test pending')))),
      h('div', { class: 'ott-trust-visibility' },
        h('div', {}, h('h3', {}, 'Public money trail.'), h('p', {}, 'The status page shows fees received, the data budget, spending and the pool balance, and the weekly ledger lists every member. Burns and other on-chain movements can be checked on the explorer; payment-provider balances are labelled as reported figures.')),
        h('div', {}, h('h3', {}, 'Private installation.'), h('p', {}, 'Your activation code and installation details stay private. Mobile service still relies on an external supplier, even when burns and payments can be checked on-chain.'))),
      h('div', { class: 'ott-trust-footer' }, h('p', {}, 'A burn is final and can’t be refunded. These are the published rules, not an audit badge or a refund guarantee.'),
        h('a', { class: 'ott-text-action', href: '#/status' }, 'Check launch readiness ↗'))));
  }

  window.WhateverMembershipStory = Object.freeze({ journey, allocation, trust });
})();
