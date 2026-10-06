'use strict';
/** Public, illustrative membership story. No wallet, API or enrolment actions. */
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

  function journey(h) {
    return h('section', { class: 'section ott-journey ott-membership-journey', id: 'how-it-works' }, h('div', { class: 'wrap' },
      head(h, 'THE PLANNED MEMBERSHIP', 'Burn once. Stay connected.',
        'Burn OTT once to enrol and get your first eSIM. Collected trading fees then fund the data pool for enrolled members. No repeat burn for each top-up.'),
      h('div', { class: 'ott-member-route', 'aria-label': 'Planned membership flow' },
        h('span', {}, 'ONE ENROLMENT'), h('span', { 'aria-hidden': 'true' }, '→'),
        h('span', {}, 'FEES FUND DATA'), h('span', { 'aria-hidden': 'true' }, '→'), h('span', {}, 'MEMBERS GET CONNECTED')),
      h('div', { class: 'ott-member-enrol' },
        h('figure', { class: 'ott-member-enrol-art' },
          image(h, 'membership-burn-world.png', 'The adult clay OTT traveller stands holding an orange eSIM membership pass in one hand and an OTT token with a sculpted clay flame in the other.', { width: '1122', height: '1402' }),
          h('figcaption', {}, 'An OTT membership illustration')),
        h('div', { class: 'ott-member-enrol-copy' }, chapter(h, '01', 'GET YOUR PASS'),
          h('h3', {}, 'One burn. Your first eSIM.'),
          h('p', {}, 'Enrol once by burning OTT. Your membership starts with an eSIM for a compatible, unlocked phone.'),
          h('div', { class: 'ott-member-pass' },
            h('div', { class: 'ott-member-pass-head' }, h('strong', {}, 'OT+T'), h('span', {}, 'MEMBERSHIP PASS')),
            h('div', { class: 'ott-member-pass-body' },
              h('span', { class: 'ott-member-pass-chip', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('i'), h('i')),
              h('div', {}, h('strong', {}, 'One-time enrolment'), h('span', {}, 'Ongoing data from collected fees'))),
            h('p', { class: 'ott-member-pass-note' }, 'PLANNED · ENROLMENT NOT OPEN')),
          h('p', { class: 'ott-member-small' }, 'The burn amount, initial package and membership duration will be published before enrolment opens.'))),
      h('div', { class: 'ott-member-ongoing', role: 'list', 'aria-label': 'How fees fund ongoing data' },
        h('article', { class: 'ott-member-stop', role: 'listitem' },
          chapter(h, '02', 'FILL THE DATA POOL'),
          h('figure', { class: 'ott-member-world' }, image(h, 'journey-budget-world.webp', 'Clay OTT traveller checking the data budget over breakfast.', { width: '1024', height: '1024' })),
          h('div', { class: 'ott-member-stop-copy' }, h('h3', {}, 'Trading fees pay for data.'),
            h('p', {}, 'A published share of fees actually collected goes into a funded data pool. Unspent funds remain in the pool for future data.'),
            h('p', { class: 'ott-member-small' }, 'The fee allocation and reserve rules are still being finalised.'))),
        h('article', { class: 'ott-member-stop', role: 'listitem' },
          chapter(h, '03', 'GO SOMEWHERE'),
          h('figure', { class: 'ott-member-world' }, image(h, 'journey-connection-world.webp', 'Clay OTT traveller using his phone to find his way through Tokyo.', { width: '1024', height: '1024' })),
          h('div', { class: 'ott-member-stop-copy' }, h('h3', {}, 'Members use their data credit.'),
            h('p', {}, 'Install your eSIM privately. Then use funded credit for data at home or on your next trip, with compatible top-ups where available. No additional burn for each data package.'),
            h('p', { class: 'ott-member-small' }, 'Your allowance varies with collected fees and membership numbers. It is not unlimited data.')))),
      h('p', { class: 'ott-journey-note ott-member-launch-note' }, h('strong', {}, 'Prelaunch. '),
        'Burn membership is planned. The membership contract, escrow protection and funded phone test are not complete. ',
        h('a', { href: '#trust' }, 'See what must be ready ↗'))));
  }

  function allocation(h) {
    const disclaimerIds = 'ott-allocation-disclaimer ott-example-error';
    const fees = h('input', { id: 'ott-example-budget', type: 'number', min: '0', max: String(Number.MAX_SAFE_INTEGER / 7), step: 'any', value: '1000', inputmode: 'decimal', 'aria-describedby': disclaimerIds });
    const percent = h('input', { id: 'ott-example-percent', type: 'number', min: '0', max: '100', step: 'any', value: '80', inputmode: 'decimal', 'aria-describedby': disclaimerIds + ' ott-example-percent-help' });
    const members = h('input', { id: 'ott-example-members', type: 'number', min: '1', max: String(Number.MAX_SAFE_INTEGER), step: '1', value: '1000', inputmode: 'numeric', 'aria-describedby': disclaimerIds });
    const result = h('output', { class: 'ott-allocation-result', for: 'ott-example-budget ott-example-percent ott-example-members', 'aria-label': 'Illustrative weekly data credit', 'aria-live': 'polite' });
    const weekly = h('strong');
    const pool = h('strong', { class: 'ott-allocation-budget' });
    const memberCount = h('strong', { class: 'ott-example-member-count' });
    const reserve = h('strong');
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
        [weekly, pool, memberCount, reserve, result].forEach((el) => { el.textContent = '—'; });
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
      explanation.textContent = 'At ' + money(Number(fees.value)) + ' in daily fees and a ' + Number(percent.value) + '% example data allocation, ' + money(funded) + ' per week is shared equally across ' + count(number) + ' enrolled ' + (number === 1 ? 'user' : 'users') + ': ' + money(funded / number) + ' in weekly data credit each.';
    }
    [fees, percent, members].forEach((input) => input.addEventListener('input', calculate));
    calculate();
    const row = (label, value, attrs = {}) => h('div', { class: 'ott-member-receipt-row', ...attrs }, h('span', {}, label), value);
    return h('section', { class: 'section ott-allocation ott-member-allocation', id: 'data-pool' }, h('div', { class: 'wrap' },
      head(h, 'FEES IN. DATA OUT.', 'A shared pool. A clear allowance.',
        'Here is one way to share a funded pool equally among enrolled users. More collected fees means more data; more members means a smaller share each.'),
      h('div', { class: 'ott-member-example' },
        h('div', { class: 'ott-member-receipt' },
          h('div', { class: 'ott-member-receipt-head' }, h('strong', {}, 'OT+T'), h('span', {}, 'THE DATA POOL / EXAMPLE')),
          h('div', { class: 'ott-member-receipt-lines', 'aria-label': 'Illustrative weekly pool calculation' },
            row('Fees collected / week', weekly), row('Allocated to data / week', pool), row('Enrolled users', memberCount),
            row('Weekly credit / user', result, { class: 'ott-member-receipt-row ott-member-receipt-total' })),
          h('p', { class: 'ott-member-reserve' }, 'Other costs and reserves / week ', reserve),
          h('span', { class: 'ott-member-example-stamp' }, 'ILLUSTRATIVE ONLY')),
        h('div', { class: 'ott-member-controls' },
          h('h3', {}, 'Try the numbers.'),
          h('p', { id: 'ott-allocation-disclaimer', class: 'ott-example-label' }, 'Example only. This is not your balance or a forecast.'),
          h('div', { class: 'ott-member-field' }, h('label', { for: 'ott-example-budget' }, 'Daily fees collected ($)'), fees),
          h('div', { class: 'ott-member-field' }, h('label', { for: 'ott-example-percent' }, 'Example data allocation (%)'), percent,
            h('p', { id: 'ott-example-percent-help' }, '80% is an example, not a final commitment.')),
          h('div', { class: 'ott-member-field' }, h('label', { for: 'ott-example-members' }, 'Enrolled users'), members), error)),
      explanation,
      h('p', { class: 'ott-member-allocation-note' }, 'Proposed equal-share example. Final allocation, credit expiry and multiple-membership rules will be published before launch. Funds must back the credit issued. ',
        h('a', { href: '#/about' }, 'Read the current programme rules ↗'))));
  }

  function trust(h) {
    const item = (number, title, detail, status) => h('li', {},
      h('span', { class: 'ott-trust-number' }, number),
      h('div', {}, h('h3', {}, title), h('p', {}, detail)), h('span', { class: 'ott-trust-state' }, status));
    return h('section', { class: 'section ott-membership-trust', id: 'trust' }, h('div', { class: 'wrap' },
      head(h, 'TRUST YOU CAN CHECK', 'Your connection. With a clear receipt.',
        'Before public enrolment, the rules, money trail and delivery protections need to be visible. These are the safeguards we plan to build.'),
      h('div', { class: 'ott-trust-layout' },
        h('aside', { class: 'ott-trust-receipt', 'aria-label': 'Illustrative enrolment receipt' },
          h('div', { class: 'ott-trust-receipt-head' }, h('strong', {}, 'OT+T'), h('span', {}, 'YOUR ENROLMENT RECEIPT')),
          h('p', { class: 'ott-trust-receipt-status' }, 'ILLUSTRATION · NO ENROLMENT SUBMITTED'),
          h('ol', { class: 'ott-trust-claim-steps' },
            h('li', {}, h('span', {}, '01'), h('div', {}, h('strong', {}, 'Tokens held in escrow'), h('p', {}, 'Planned: refundable while the first eSIM is awaiting delivery.'))),
            h('li', {}, h('span', {}, '02'), h('div', {}, h('strong', {}, 'First eSIM delivered'), h('p', {}, 'Issuance needs a defined verification and recovery process.'))),
            h('li', {}, h('span', {}, '03'), h('div', {}, h('strong', {}, 'Burn finalised. Membership recorded.'), h('p', {}, 'Planned: an on-chain receipt you can check yourself.')))),
          h('p', { class: 'ott-trust-receipt-foot' }, 'Escrow and refund protection are not live. No public burn enrolment is open.')),
        h('div', { class: 'ott-trust-ledger' },
          h('p', { class: 'ott-trust-ledger-label' }, 'BEFORE ENROLMENT OPENS'),
          h('ol', {},
            item('01', 'Publish the exact rules.', 'Burn amount, initial package, membership duration, data allocation and what happens if fees stop.', 'Terms pending'),
            item('02', 'Protect the first delivery.', 'Review escrow, the issuance check, refund timeout and recovery without a second burn.', 'Escrow planned'),
            item('03', 'Review the contract and reserves.', 'Independent contract review, multiple approvals for reserves and visible notice of important rule changes.', 'Contract review pending'),
            item('04', 'Prove the phone connection.', 'Complete a funded purchase, eSIM installation and a real mobile-data test before public enrolment.', 'Funded phone test pending')))),
      h('div', { class: 'ott-trust-visibility' },
        h('div', {}, h('h3', {}, 'Public money trail.'), h('p', {}, 'Planned: fees received, data allocation, spending, reserves and member count with timestamps. On-chain movements can be linked to an explorer; payment-provider balances must be labelled as reported figures.')),
        h('div', {}, h('h3', {}, 'Private installation.'), h('p', {}, 'Your activation code and installation details stay private. Mobile service still relies on an external supplier, even when burns and payments can be checked on-chain.'))),
      h('div', { class: 'ott-trust-footer' }, h('p', {}, 'Prelaunch. These are planned protections, not an audit badge or a refund guarantee.'),
        h('a', { class: 'ott-text-action', href: '#/status' }, 'Check launch readiness ↗'))));
  }

  window.WhateverMembershipStory = Object.freeze({ journey, allocation, trust });
})();
