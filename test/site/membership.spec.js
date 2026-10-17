'use strict';
/**
 * Membership in the account panel: join by burning OTT, then claim the welcome eSIM.
 *
 * The burn cannot be undone, so most of what is held here is restraint: no transaction before an
 * explicit, permanent-sounding confirmation; exactly transfer(burnAddress, burnUnits) on the coin
 * when one is sent; no second burn while the first is confirming or once an earlier one is on
 * chain; and a closed enrolment that offers no button at all. The welcome claim then signs exactly
 * the message docs/membership.md specifies and posts the burn as its proof. Every value the page
 * could act on (the wallet, the chain RPC, /api/redeem) is stubbed so each assertion names it.
 */
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork, hexWord } = require('./support/network.js');

const ADDR = '0x4ca685f4a1cd39ba0d0f1cd06b3f2b0f5b7cdd11';
const COIN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x3333333333333333333333333333333333333333';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const BURN = '0x000000000000000000000000000000000000dEaD';
const BURN_UNITS = (100000n * 10n ** 18n).toString();
const BURN_TX = '0x' + 'b1'.repeat(32);
const EARLIER_TX = '0x' + 'e4'.repeat(32);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word = (value) => String(value).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const BURN_DATA = '0xa9059cbb' + word(BURN) + word(BigInt(BURN_UNITS).toString(16));

const WEEK_S = 604800;
const ANCHOR = 345600;
const NOW_S = Math.floor(Date.now() / 1000);
const CUR_WEEK = Math.floor((NOW_S - ANCHOR) / WEEK_S);
const CUR_WEEK_END = ANCHOR + (CUR_WEEK + 1) * WEEK_S;

// Three welcome-eligible plans (1 GB, 7 days, at most $4) and two that are not: the Global plan
// is over the price cap, and the 5 GB plan is the wrong size.
const PACKAGES = [
  { code: 'fixed_1GB_7D_EUROPE', slug: 'europe', name: 'Europe', kind: 'region', gb: 1, days: 7, priceUsd: 1.19, regions: '38 countries' },
  { code: 'fixed_1GB_7D_GLOBAL', slug: 'global', name: 'Global', kind: 'region', gb: 1, days: 7, priceUsd: 8.99, regions: '105 countries' },
  { code: 'fixed_1GB_7D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 1, days: 7, priceUsd: 1.99, regions: 'DE', flag: '🇩🇪' },
  { code: 'fixed_5GB_30D_DE', slug: 'germany', name: 'Germany', kind: 'country', gb: 5, days: 30, priceUsd: 3.49, regions: 'DE', flag: '🇩🇪' },
  { code: 'fixed_1GB_7D_JP', slug: 'japan', name: 'Japan', kind: 'country', gb: 1, days: 7, priceUsd: 2.99, regions: 'JP', flag: '🇯🇵' },
];
const WELCOME = { gb: 1, days: 7, maxUsd: 4 };
const CONFIG = {
  coin: COIN, curve: CURVE, treasury: TREASURY, pair: USDG, taxBps: 1000, budgetBps: 8000,
  membership: { burnTokens: '100000', burnAddress: BURN, capMultiple: 3, welcome: WELCOME },
  provider: 'wholesale', packages: PACKAGES,
  brand: { name: 'OT+T', full: 'Onchain Telephone + Telegraph', ticker: 'OTT', since: '2026' },
};
const LEDGER = {
  asOf: NOW_S, block: 64200000, week: CUR_WEEK, weekStart: CUR_WEEK_END - WEEK_S, weekEnd: CUR_WEEK_END,
  snapshotBlock: 64100000, coin: COIN, curve: CURVE, budgetUsd: 400, budgetSource: 'tax collected in week ' + (CUR_WEEK - 1),
  circulating: '812345678000000000000000', decimals: 18, holders: 214, wallets: {}, members: {},
};

const membership = (extra) => Object.assign({
  configured: true, burnTokens: '100000', burnUnits: BURN_UNITS, burnAddress: BURN, coin: COIN,
  welcome: WELCOME, capMultiple: 3, member: false, memberSinceBlock: null, sharing: false,
  welcomeOrder: null, enrolment: { open: true, reason: '' },
}, extra);
const standing = (extra) => Object.assign({
  ok: true, address: ADDR, week: CUR_WEEK, weekEnd: CUR_WEEK_END,
  tokens: (250000n * 10n ** 18n).toString(), share: 0.3, allowanceUsd: 0, decimals: 18,
  redeemedUsd: 0, remainingUsd: 0, stale: false, allowancesWeek: CUR_WEEK, poolUsd: 120,
  orders: [], history: [], sims: [], membership: membership(),
}, extra);
const ICCID = '8900000000000000077';
const welcomeOrder = (extra) => Object.assign({
  n: 0, week: null, welcome: true, transactionId: 'ott-' + 'a'.repeat(32), packageCode: 'fixed_1GB_7D_DE', priceUsd: 1.99,
  iccid: ICCID, topupOf: '', toppedUp: false, createdAt: '2026-10-17T00:00:00Z', pending: false, stage: 'done', note: '',
  qrCodeUrl: '', ac: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '', codes: false,
}, extra);
const simWithCodes = {
  iccid: ICCID, slug: 'germany', createdAt: '2026-10-17T00:00:00Z', qrCodeUrl: '', ac: 'LPA:1$smdp.provider.example$WELCOME',
  manualCode: '', smdpAddress: 'smdp.provider.example', matchingId: 'WELCOME',
  appleInstallUrl: 'https://esimsetup.apple.com/es?a=welcome', androidInstallUrl: '', codes: true,
};

const json = (body, status) => ({ status: status || 200, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * A wallet that records every request. `send` decides what eth_sendTransaction does: return the
 * fixture hash, or refuse the way a person declining in their wallet does (code 4001).
 */
function stubWallet(page, { send = 'hash' } = {}) {
  return page.addInitScript(({ addr, send, hash }) => {
    window.__eth = [];
    window.ethereum = {
      on() {}, removeListener() {},
      request: async ({ method, params }) => {
        window.__eth.push({ method, params });
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'personal_sign') return '0x' + 'ab'.repeat(65);
        if (method === 'eth_sendTransaction') {
          if (send === 'reject') { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
          return hash;
        }
        return null;
      },
    };
  }, { addr: ADDR, send, hash: BURN_TX });
}

/**
 * The chain as the page reads it. `balance` answers balanceOf; `receipts` is the sequence of
 * eth_getTransactionReceipt answers (the last one repeats); `logs` answers eth_getLogs.
 */
function stubChain(page, { balance = 250000n * 10n ** 18n, receipts = [null, { status: '0x1' }], head = 0x1234567, logs = [] } = {}) {
  const rpc = [];
  let receiptCalls = 0;
  const network = stubNetwork(page, {
    calls: { '0x70a08231': hexWord(balance) },
    methods: {
      eth_blockNumber: () => '0x' + head.toString(16),
      eth_getLogs: (req) => { rpc.push(req); return logs; },
      eth_getTransactionReceipt: (req) => {
        rpc.push(req);
        const answer = receipts[Math.min(receiptCalls++, receipts.length - 1)];
        return answer ? Object.assign({ transactionHash: req.params[0], blockNumber: '0x3d3e1f0' }, answer) : null;
      },
    },
  });
  return { network, rpc, receiptCalls: () => receiptCalls };
}

/** /api/redeem: GET answers the standings in turn (the last repeats); POST is recorded and answered by `post`. */
async function stubApi(page, standings, post) {
  const posts = [];
  let gets = 0;
  await page.route('**/api/redeem**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') { const body = standings[Math.min(gets++, standings.length - 1)]; return route.fulfill(json(body)); }
    const body = JSON.parse(request.postData() || '{}');
    posts.push(body);
    const [answer, status] = post ? post(body) : [{ ok: false, error: 'no POST expected' }, 500];
    return route.fulfill(json(answer, status));
  });
  return { posts, gets: () => gets };
}

async function openData(page, { config = CONFIG, ledger = LEDGER } = {}) {
  await page.route('**/config/esim.json', (r) => r.fulfill(json(config)));
  await page.route('**/data/allowances.json', (r) => r.fulfill(json(ledger)));
  await page.route('**/data/treasury.json', (r) => r.fulfill({ status: 404, body: 'no treasury reading' }));
  await page.goto('/index.html#/data');
  const mine = page.locator('.data-mine');
  await expect(mine).toContainText(ADDR);
  return mine;
}
const walletCalls = (page, method) => page.evaluate((m) => window.__eth.filter((c) => c.method === m), method);
const decodeHex = (hex) => Buffer.from(hex.slice(2), 'hex').toString('utf8');

test('a non-member sees how to join, and nothing is sent before an explicit confirmation that the burn is permanent', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await stubWallet(page);
  stubChain(page);
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await expect(card.locator('h3')).toHaveText('Join OT+T');
  await expect(card).toContainText('Burn 100,000 OTT once to become a member.');
  await expect(card).toContainText('any 1 GB, 7-day plan up to $4.00');
  await expect(card).toContainText('no member gets more than 3× the average share');
  await expect(card).toContainText('It can’t be undone or refunded.');
  // Weekly credit is for members: no weekly picker for a holder who has not joined.
  await expect(mine.locator('.data-redeem')).toHaveCount(0);

  await card.getByRole('button', { name: 'Join: burn 100,000 OTT' }).click();
  await expect(card.locator('h3')).toHaveText('Burn 100,000 OTT?');
  await expect(card).toContainText('Burned tokens are gone for good. This can’t be undone or refunded.');
  await expect(card).toContainText(BURN);
  const burn = card.getByRole('button', { name: 'Burn 100,000 OTT' });
  await expect(burn).toBeDisabled();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await expect(burn).toBeEnabled();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.locator('h3')).toHaveText('Join OT+T');
  expect(await walletCalls(page, 'eth_sendTransaction')).toEqual([]);
  expect(errors).toEqual([]);
});

test('the burn sends exactly transfer(burnAddress, burnUnits) to the coin, waits for its receipt and opens the welcome claim', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await stubWallet(page);
  const chain = stubChain(page, { receipts: [null, null, { status: '0x1' }] });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await card.getByRole('button', { name: 'Join: burn 100,000 OTT' }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await card.getByRole('button', { name: 'Burn 100,000 OTT' }).click();
  await expect(card.locator('h3')).toHaveText('Claim your welcome eSIM', { timeout: 15000 });
  await expect(page.locator('#toasts')).toContainText('Membership confirmed');

  const sent = await walletCalls(page, 'eth_sendTransaction');
  expect(sent).toEqual([{ method: 'eth_sendTransaction', params: [{ from: ADDR, to: COIN, data: BURN_DATA, value: '0x0' }] }]);
  expect(chain.receiptCalls()).toBeGreaterThanOrEqual(3);
  expect(chain.rpc.filter((r) => r.method === 'eth_getTransactionReceipt').every((r) => r.params[0] === BURN_TX)).toBe(true);
  // The confirmed hash is public chain data, kept so a reload cannot invite a second burn.
  expect(await page.evaluate((a) => localStorage.getItem('ott-membership-burn:' + a), ADDR)).toBe(BURN_TX);
  // Only the welcome-eligible plans are offered, alphabetically.
  await expect(card.locator('#f-welcome-plan option')).toHaveText(['Europe · $1.19', 'Germany · $1.99', 'Japan · $2.99']);
  expect(errors).toEqual([]);
});

test('burn details from the API that disagree with the published config are refused before the wallet is asked', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await stubWallet(page);
  stubChain(page);
  // One answer redirects the burn to another address; the next asks for ten times the amount.
  const attacker = '0x' + '6'.repeat(40);
  await stubApi(page, [standing({ membership: membership({ burnAddress: attacker }) }),
    standing({ membership: membership({ burnUnits: (1000000n * 10n ** 18n).toString() }) })]);
  for (const round of [0, 1]) {
    const mine = round === 0 ? await openData(page) : (await page.reload(), page.locator('.data-mine'));
    const card = mine.locator('.data-membership');
    await card.getByRole('button', { name: 'Join: burn 100,000 OTT' }).click();
    await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
    await card.getByRole('button', { name: 'Burn 100,000 OTT' }).click();
    await expect(card).toContainText('don’t match this site’s published settings, so nothing was sent');
  }
  expect(await walletCalls(page, 'eth_sendTransaction')).toEqual([]);
  expect(errors).toEqual([]);
});

test('the welcome claim signs exactly the welcome message and posts the burn as its proof', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(({ addr, tx }) => localStorage.setItem('ott-membership-burn:' + addr, tx), { addr: ADDR, tx: BURN_TX });
  await stubWallet(page);
  stubChain(page);
  const issued = welcomeOrder({ codes: true, ac: simWithCodes.ac, smdpAddress: simWithCodes.smdpAddress, matchingId: 'WELCOME', appleInstallUrl: simWithCodes.appleInstallUrl });
  const api = await stubApi(page, [standing()], () => [{ ok: true, order: issued, sims: [simWithCodes] }]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await expect(card.locator('h3')).toHaveText('Claim your welcome eSIM');
  await card.locator('#f-welcome-plan').selectOption('fixed_1GB_7D_DE');
  await card.getByRole('button', { name: 'Claim Germany · 1 GB — $1.99' }).click();
  await expect(mine.locator('.data-membership h3')).toHaveText('You’re a member');
  await expect(page.locator('#toasts')).toContainText('Welcome eSIM ready');

  const signs = await walletCalls(page, 'personal_sign');
  expect(signs).toHaveLength(1);
  const lines = decodeHex(signs[0].params[0]).split('\n');
  expect(lines.slice(0, 4)).toEqual(['OT+T — claim my welcome eSIM', 'Site: ' + new URL(page.url()).host, 'Wallet: ' + ADDR, 'Plan: fixed_1GB_7D_DE']);
  expect(lines[4]).toMatch(/^Issued: \d{10}$/);
  expect(lines).toHaveLength(5);
  expect(api.posts).toEqual([{ address: ADDR, message: lines.join('\n'), signature: '0x' + 'ab'.repeat(65), welcome: true, packageCode: 'fixed_1GB_7D_DE', burnTx: BURN_TX }]);
  // The welcome eSIM is listed with its codes, which the signed claim returned for that profile.
  const sim = mine.locator('.data-sim').filter({ hasText: 'ICCID ' + ICCID });
  await expect(sim.locator('.data-welcome-badge')).toHaveText('WELCOME');
  await expect(sim.locator('.data-ac')).toHaveText(simWithCodes.ac);
  await expect(sim.getByRole('link', { name: 'Install on iPhone' })).toHaveAttribute('href', simWithCodes.appleInstallUrl);
  expect(errors).toEqual([]);
});

test('a member listed by the ledger claims without a burn proof, and an already-claimed answer reloads the account', async ({ page }) => {
  await stubWallet(page);
  stubChain(page);
  const member = membership({ member: true, memberSinceBlock: 64000000, sharing: true });
  const claimed = membership({ member: true, memberSinceBlock: 64000000, sharing: true, welcomeOrder: welcomeOrder() });
  const api = await stubApi(page, [standing({ membership: member, allowanceUsd: 12, remainingUsd: 12 }),
    standing({ membership: claimed, allowanceUsd: 12, remainingUsd: 12, sims: [Object.assign({}, simWithCodes, { ac: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', codes: false })] })],
  () => [{ ok: false, error: 'your welcome eSIM has already been claimed' }, 409]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await expect(card).toContainText('You’re in this week’s split.');
  // Members keep the weekly picker.
  await expect(mine.locator('.data-redeem')).toHaveCount(1);
  await card.getByRole('button', { name: /^Claim Europe/ }).click();
  await expect(page.locator('#toasts')).toContainText('Welcome eSIM already claimed');
  await expect(mine.locator('.data-membership h3')).toHaveText('You’re a member');
  expect(api.posts).toHaveLength(1);
  expect(api.posts[0]).not.toHaveProperty('burnTx');
  expect(api.posts[0]).toMatchObject({ welcome: true, packageCode: 'fixed_1GB_7D_EUROPE' });
  await expect(mine.locator('.data-sim .data-welcome-badge')).toHaveText('WELCOME');
});

test('closed enrolment shows its reason and offers no way to burn', async ({ page }) => {
  await stubWallet(page);
  stubChain(page);
  await stubApi(page, [standing({ membership: membership({ enrolment: { open: false, reason: 'The reserve can’t pay for a welcome eSIM right now.' } }) })]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await expect(card).toContainText('Joining is closed right now. The reserve can’t pay for a welcome eSIM right now.');
  await expect(page.getByRole('button', { name: /burn/i })).toHaveCount(0);
  await expect(mine.locator('.data-redeem')).toHaveCount(0);
});

test('a short balance is refused before the wallet is asked, and a declined approval sends nothing', async ({ page }) => {
  await stubWallet(page, { send: 'reject' });
  const balance = { value: 50000n * 10n ** 18n };
  stubChain(page, { balance: balance.value });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await card.getByRole('button', { name: 'Join: burn 100,000 OTT' }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await card.getByRole('button', { name: 'Burn 100,000 OTT' }).click();
  await expect(card.locator('.hint')).toHaveText('This wallet holds 50,000 OTT. Joining burns 100,000 OTT.');
  expect(await walletCalls(page, 'eth_sendTransaction')).toEqual([]);
});

test('a declined wallet approval says nothing was sent and leaves the confirmation ready to try again', async ({ page }) => {
  await stubWallet(page, { send: 'reject' });
  stubChain(page);
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await card.getByRole('button', { name: 'Join: burn 100,000 OTT' }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await card.getByRole('button', { name: 'Burn 100,000 OTT' }).click();
  await expect(card.locator('.hint')).toHaveText('The burn wasn’t approved. Nothing was sent.');
  await expect(card.getByRole('button', { name: 'Burn 100,000 OTT' })).toBeEnabled();
  expect(await walletCalls(page, 'eth_sendTransaction')).toHaveLength(1);
  expect(await page.evaluate((a) => localStorage.getItem('ott-membership-burn:' + a), ADDR)).toBeNull();
});

test('a failed burn receipt says no OTT was burned and offers joining again', async ({ page }) => {
  await stubWallet(page);
  stubChain(page, { receipts: [{ status: '0x0' }] });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await card.getByRole('button', { name: 'Join: burn 100,000 OTT' }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await card.getByRole('button', { name: 'Burn 100,000 OTT' }).click();
  await expect(card).toContainText('The burn transaction failed on chain, so no OTT was burned. You can try again.');
  await expect(card.getByRole('button', { name: 'Join: burn 100,000 OTT' })).toBeVisible();
  expect(await page.evaluate((a) => localStorage.getItem('ott-membership-burn:' + a), ADDR)).toBeNull();
});

test('a burn that has not confirmed yet is never offered again, only checked', async ({ page }) => {
  await page.clock.install();
  await stubWallet(page);
  stubChain(page, { receipts: [null] });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await card.getByRole('button', { name: 'Join: burn 100,000 OTT' }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await card.getByRole('button', { name: 'Burn 100,000 OTT' }).click();
  await expect(card.locator('.hint')).toHaveText('Waiting for the burn to confirm on Robinhood Chain…');
  // Each poll waits on a (stubbed) network answer before it schedules the next one, so the clock
  // moves a poll interval at a time until the page gives up waiting.
  await expect.poll(async () => {
    await page.clock.runFor(1600);
    return card.locator('h3').textContent();
  }, { timeout: 30000, intervals: [20] }).toBe('Your burn is confirming');
  await expect(card).toContainText('Don’t burn again');
  await expect(card).toContainText('Transaction ' + BURN_TX);
  await expect(card.getByRole('button', { name: 'Check burn status' })).toBeVisible();
  await expect(card.getByRole('button', { name: /^(?:Join|Burn)/ })).toHaveCount(0);
  expect(await walletCalls(page, 'eth_sendTransaction')).toHaveLength(1);
});

test('an earlier burn already on chain is found instead of asking for a second one', async ({ page }) => {
  await stubWallet(page);
  const chain = stubChain(page, {
    head: LEDGER.block + 5000,
    logs: [{ address: COIN, topics: [TRANSFER_TOPIC, '0x' + word(ADDR), '0x' + word(BURN)], data: '0x' + word(BigInt(BURN_UNITS).toString(16)),
      transactionHash: EARLIER_TX, blockNumber: '0x' + (LEDGER.block + 10).toString(16), logIndex: '0x0', removed: false }],
  });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await card.getByRole('button', { name: 'Join: burn 100,000 OTT' }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await card.getByRole('button', { name: 'Burn 100,000 OTT' }).click();
  await expect(mine.locator('.data-membership h3')).toHaveText('Claim your welcome eSIM');
  await expect(page.locator('#toasts')).toContainText('Membership found');
  expect(await walletCalls(page, 'eth_sendTransaction')).toEqual([]);
  const query = chain.rpc.find((r) => r.method === 'eth_getLogs');
  expect(query.params[0]).toMatchObject({ address: COIN, topics: [TRANSFER_TOPIC, '0x' + word(ADDR), ['0x' + word(BURN), '0x' + word('0x0')]] });
  expect(Number(query.params[0].fromBlock)).toBe(LEDGER.block + 1);
  expect(await page.evaluate((a) => localStorage.getItem('ott-membership-burn:' + a), ADDR)).toBe(EARLIER_TX);
});

test('a rejected burn proof is forgotten and the wallet is shown how to join again', async ({ page }) => {
  await page.addInitScript(({ addr, tx }) => localStorage.setItem('ott-membership-burn:' + addr, tx), { addr: ADDR, tx: BURN_TX });
  await stubWallet(page);
  stubChain(page);
  await stubApi(page, [standing()], () => [{ ok: false, error: 'the burn transaction was not found or did not burn enough OTT' }, 409]);
  const mine = await openData(page);
  await mine.locator('.data-membership').getByRole('button', { name: /^Claim / }).click();
  await expect(page.locator('#toasts')).toContainText('the burn transaction was not found or did not burn enough OTT');
  await expect(mine.locator('.data-membership h3')).toHaveText('Join OT+T');
  expect(await page.evaluate((a) => localStorage.getItem('ott-membership-burn:' + a), ADDR)).toBeNull();
});

test('without a membership block the account panel keeps the weekly flow', async ({ page }) => {
  await stubWallet(page);
  stubChain(page);
  const config = Object.assign({}, CONFIG);
  delete config.membership;
  await stubApi(page, [standing({ membership: { configured: false }, allowanceUsd: 20, remainingUsd: 20 })]);
  const mine = await openData(page, { config });
  await expect(mine.locator('.data-redeem')).toHaveCount(1);
  await expect(mine.locator('.data-membership')).toHaveCount(0);
  await expect(mine).not.toContainText(/burn/i);
});

test('the app home invites a non-member to join instead of showing a $0.00 balance', async ({ page }) => {
  await stubWallet(page);
  stubChain(page);
  await stubApi(page, [standing()]);
  await page.route('**/config/esim.json', (r) => r.fulfill(json(CONFIG)));
  await page.route('**/data/allowances.json', (r) => r.fulfill(json(LEDGER)));
  await page.goto('/index.html#/app');
  await expect(page.locator('.om-pass-title')).toHaveText('Not a member yet');
  await expect(page.locator('.om-credit-card')).not.toContainText('$0.00');
  // The pass is the invitation; there is no second join prompt further down.
  await expect(page.locator('.om-welcome-banner')).toHaveCount(0);
  await page.locator('.om-credit-card').getByRole('button', { name: 'Join OT+T' }).click();
  await expect(page).toHaveURL(/#\/app\/esims$/);
  await expect(page.locator('.data-membership h3')).toHaveText('Join OT+T');
  // A non-member's panel leads with joining, not a $0.00 credit card or zero tiles.
  await expect(page.locator('.credit-summary')).toHaveCount(0);
  await expect(page.locator('.data-membership')).not.toContainText('null');
});

test('the app home puts a member\'s unclaimed welcome eSIM right under the credit pass', async ({ page }) => {
  await stubWallet(page);
  stubChain(page);
  await stubApi(page, [standing({ allowanceUsd: 12, remainingUsd: 12, membership: membership({ member: true, memberSinceBlock: 64000000, sharing: true }) })]);
  await page.route('**/config/esim.json', (r) => r.fulfill(json(CONFIG)));
  await page.route('**/data/allowances.json', (r) => r.fulfill(json(LEDGER)));
  await page.goto('/index.html#/app');
  const banner = page.locator('.om-credit-card + .om-welcome-banner');
  await expect(banner).toContainText('Your welcome eSIM is ready to claim.');
  await expect(banner).toContainText('Any 1 GB, 7-day plan up to $4.00.');
  await banner.getByRole('button', { name: 'Claim your welcome eSIM' }).click();
  await expect(page).toHaveURL(/#\/app\/esims$/);
  await expect(page.locator('.data-membership h3')).toHaveText('Claim your welcome eSIM');
});
