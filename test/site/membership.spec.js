'use strict';
/**
 * Membership in the account panel: join by sending this week's amount of OTT to the incinerator,
 * then claim the welcome eSIM.
 *
 * The send cannot be undone, so most of what is held here is restraint: no transaction before an
 * explicit, permanent-sounding confirmation; exactly one transfer of this week's amount from the
 * wallet's own OTT account into the incinerator's when one is sent; no second send while the first
 * is confirming or once an earlier one is on chain; and a closed enrolment that offers no button
 * at all. The welcome claim then signs exactly the message docs/membership.md specifies and posts
 * the join as its proof. The wallet, the Solana RPC and /api/redeem are all stubbed, so each
 * assertion names the value it expects.
 */
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork, BLOCKHASH } = require('./support/network.js');
const { installWallet, TX_SIGNATURE, walletAddress } = require('./support/wallet.js');
const { S, COIN, TREASURY, TOKEN_2022, INCINERATOR, BURN_ACCOUNT, ata, addressFrom, signatureFrom, joinTransactionResult } = require('./support/solana.js');

const ADDR = walletAddress();
const HOLDER_ACCOUNT = ata(ADDR, COIN);
const EARLIER_TX = signatureFrom('earlier join');
const JOIN_TX = signatureFrom('remembered join');
const JOIN_TOKENS = '180000';
const JOIN_UNITS = '180000000000';
const BALANCE = '250000000000';

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
  chain: 'solana', coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY, budgetBps: 8000,
  membership: { burnUsd: 5, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, capMultiple: 3, welcome: WELCOME },
  provider: 'wholesale', packages: PACKAGES,
  brand: { name: 'OT+T', full: 'Onchain Telephone + Telegraph', ticker: 'OTT', since: '2026' },
};
const REQUIREMENT = { week: CUR_WEEK, burnTokens: JOIN_TOKENS, burnUnits: JOIN_UNITS, priceUsd: 0.0000278 };
const LEDGER = {
  asOf: NOW_S, slot: 400000000, chain: 'solana', week: CUR_WEEK, weekStart: CUR_WEEK_END - WEEK_S, weekEnd: CUR_WEEK_END,
  coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, treasury: TREASURY, budgetUsd: 400, budgetSource: 'creator fees collected in week ' + (CUR_WEEK - 1),
  membership: { burnUsd: 5, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, capMultiple: 3, requirement: REQUIREMENT,
    requirements: { [CUR_WEEK]: JOIN_UNITS }, members: 0, cursor: null },
  members: {}, joins: {}, holders: 0, memberTokens: '0', wallets: {},
};

const membership = (extra) => Object.assign({
  configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT, burnUsd: 5,
  requirement: REQUIREMENT, burned: '0', welcome: WELCOME, capMultiple: 3, member: false, memberSince: null, sharing: false,
  welcomeOrder: null, enrolment: { open: true, reason: '' },
}, extra);
const SINCE = { at: NOW_S - 86400, slot: 399000000, tx: EARLIER_TX };
const standing = (extra) => Object.assign({
  ok: true, address: ADDR, week: CUR_WEEK, weekEnd: CUR_WEEK_END,
  tokens: '250000000000', share: 0.3, allowanceUsd: 0, decimals: 6,
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
const joinStorage = (page) => page.evaluate((a) => localStorage.getItem('ott-membership-join:' + a), ADDR);

/**
 * The chain as the page reads it. `balance` is the holder's OTT account (null: there is none);
 * `statuses` is the sequence of answers for the join's signature status (the last one repeats,
 * null meaning not landed yet); `signatures`/`transactions` answer the earlier-join check.
 */
function stubChain(page, { balance = BALANCE, statuses = [{ confirmationStatus: 'confirmed', err: null }], signatures = [], transactions = {} } = {}) {
  let statusCalls = 0;
  const network = stubNetwork(page, {
    balance,
    signatures: { [BURN_ACCOUNT]: signatures },
    transactions,
    statuses: () => statuses[Math.min(statusCalls++, statuses.length - 1)],
  });
  return { network, statusCalls: () => statusCalls, asked: (method) => network.requests.filter((r) => r.method === method) };
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

async function confirmJoin(card, label = '180,000 OTT') {
  await card.getByRole('button', { name: 'Join: burn ' + label }).click();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await card.getByRole('button', { name: 'Burn ' + label }).click();
}

const u64le = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const u32le = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };

test('a non-member sees how to join, and nothing is sent before an explicit confirmation that the burn is permanent', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const wallet = await installWallet(page, { trusted: true });
  stubChain(page);
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await expect(card.locator('h3')).toHaveText('Join OT+T');
  await expect(card).toContainText('Burn 180,000 OTT (about $5.00) once to become a member.');
  await expect(card).toContainText('The amount is set from OTT’s price each Monday');
  await expect(card).toContainText('any 1 GB, 7-day plan up to $4.00');
  await expect(card).toContainText('no member gets more than 3× the average share');
  await expect(card).toContainText('It can’t be undone or refunded.');
  await expect(card.getByRole('link', { name: 'Get OTT on pump.fun' })).toHaveAttribute('href', 'https://pump.fun/coin/' + COIN);
  // Weekly credit is for members: no weekly picker for a holder who has not joined.
  await expect(mine.locator('.data-redeem')).toHaveCount(0);

  await card.getByRole('button', { name: 'Join: burn 180,000 OTT' }).click();
  await expect(card.locator('h3')).toHaveText('Burn 180,000 OTT?');
  await expect(card).toContainText('Burned tokens are gone for good. This can’t be undone or refunded.');
  await expect(card.locator('.data-burn-address')).toHaveText(BURN_ACCOUNT);
  const burn = card.getByRole('button', { name: 'Burn 180,000 OTT' });
  await expect(burn).toBeDisabled();
  await card.getByLabel('I understand the burn is permanent and can’t be refunded.').check();
  await expect(burn).toBeEnabled();
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.locator('h3')).toHaveText('Join OT+T');
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
  expect(errors).toEqual([]);
});

test('the join sends exactly this week’s amount from the wallet’s OTT account to the incinerator’s, waits for it to confirm and opens the welcome claim', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const wallet = await installWallet(page, { trusted: true });
  const chain = stubChain(page, { statuses: [null, null, { confirmationStatus: 'confirmed', err: null }] });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await confirmJoin(card);
  await expect(card.locator('h3')).toHaveText('Claim your welcome eSIM', { timeout: 15000 });
  await expect(page.locator('#toasts')).toContainText('Membership confirmed');

  const sent = wallet.calls('signAndSendTransaction');
  expect(sent).toHaveLength(1);
  expect(sent[0].chain).toBe('solana:mainnet');
  const tx = sent[0].transaction;
  expect(tx.signatures).toBe(1);
  expect(tx.blockhash).toBe(BLOCKHASH);
  // The wallet pays the fee and is the only signer.
  expect(tx.accounts[0]).toEqual({ address: ADDR, signer: true, writable: true });
  expect(tx.accounts.filter((a) => a.signer).map((a) => a.address)).toEqual([ADDR]);
  expect(tx.instructions.map((ix) => ix.program)).toEqual([S.PROGRAMS.computeBudget, S.PROGRAMS.computeBudget, S.PROGRAMS.associatedToken, TOKEN_2022]);
  // A small priority fee: 40,000 compute units at 50,000 micro-lamports each.
  expect(tx.instructions[0].data).toEqual(Buffer.concat([Buffer.from([2]), u32le(40000)]));
  expect(tx.instructions[1].data).toEqual(Buffer.concat([Buffer.from([3]), u64le(50000)]));
  // CreateIdempotent of the incinerator's OTT account: a no-op once it exists.
  expect(tx.instructions[2]).toEqual({ program: S.PROGRAMS.associatedToken, accounts: [ADDR, BURN_ACCOUNT, INCINERATOR, COIN, S.PROGRAMS.system, TOKEN_2022], data: Buffer.from([1]) });
  // TransferChecked of exactly this week's amount, at the coin's 6 decimals, from the wallet's own account.
  expect(tx.instructions[3]).toEqual({ program: TOKEN_2022, accounts: [HOLDER_ACCOUNT, COIN, BURN_ACCOUNT, ADDR], data: Buffer.concat([Buffer.from([12]), u64le(JOIN_UNITS), Buffer.from([6])]) });
  expect(tx.accounts.find((a) => a.address === INCINERATOR)).toMatchObject({ signer: false, writable: false });

  // The balance check read the wallet's own OTT account before anything was sent.
  expect(chain.asked('getTokenAccountBalance').map((r) => r.params[0])).toEqual([HOLDER_ACCOUNT]);
  expect(chain.statusCalls()).toBeGreaterThanOrEqual(3);
  expect(chain.asked('getSignatureStatuses').every((r) => r.params[0].length === 1 && r.params[0][0] === TX_SIGNATURE)).toBe(true);
  // The confirmed signature is public chain data, kept so a reload cannot invite a second send.
  expect(await joinStorage(page)).toBe(TX_SIGNATURE);
  // Only the welcome-eligible plans are offered, alphabetically.
  await expect(card.locator('#f-welcome-plan option')).toHaveText(['Europe · $1.19', 'Germany · $1.99', 'Japan · $2.99']);
  expect(errors).toEqual([]);
});

test('join details from the API that disagree with the published config are refused before the wallet is asked', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const wallet = await installWallet(page, { trusted: true });
  stubChain(page);
  const attacker = addressFrom('attacker');
  const rounds = [
    // Another wallet's OTT account instead of the incinerator's.
    { m: membership({ burnAccount: ata(attacker, COIN) }), label: '180,000 OTT' },
    // An account owned by someone other than the incinerator, even with a matching config entry.
    { m: membership({ burnOwner: attacker }), label: '180,000 OTT' },
    // Three percent of the supply: over the two percent any week's amount may be.
    { m: membership({ requirement: Object.assign({}, REQUIREMENT, { burnTokens: '30000000', burnUnits: '30000000000000' }) }), label: '30,000,000 OTT' },
    // Another token program than the published one.
    { m: membership({ tokenProgram: S.PROGRAMS.token }), label: '180,000 OTT' },
    // Decimals that disagree with the coin's own.
    { m: membership({ decimals: 9 }), label: '180,000 OTT' },
  ];
  await stubApi(page, rounds.map((r) => standing({ membership: r.m })));
  for (const [i, round] of rounds.entries()) {
    const mine = i === 0 ? await openData(page) : (await page.reload(), page.locator('.data-mine'));
    const card = mine.locator('.data-membership');
    await confirmJoin(card, round.label);
    await expect(card).toContainText('don’t match this site’s published settings, so nothing was sent');
  }
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
  expect(errors).toEqual([]);
});

test('the welcome claim signs exactly the welcome message and posts the join as its proof', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(({ addr, tx }) => localStorage.setItem('ott-membership-join:' + addr, tx), { addr: ADDR, tx: JOIN_TX });
  const wallet = await installWallet(page, { trusted: true });
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

  const signs = wallet.calls('signMessage');
  expect(signs).toHaveLength(1);
  const lines = signs[0].message.split('\n');
  expect(lines.slice(0, 4)).toEqual(['OT+T — claim my welcome eSIM', 'Site: ' + new URL(page.url()).host, 'Wallet: ' + ADDR, 'Plan: fixed_1GB_7D_DE']);
  expect(lines[4]).toMatch(/^Issued: \d{10}$/);
  expect(lines).toHaveLength(5);
  expect(api.posts).toHaveLength(1);
  const post = api.posts[0];
  expect(post).toEqual({ address: ADDR, message: lines.join('\n'), signature: post.signature, welcome: true, packageCode: 'fixed_1GB_7D_DE', joinTx: JOIN_TX });
  // The signature is the wallet's ed25519 signature over exactly that message, as the API checks it.
  expect(wallet.verify(post.message, post.signature)).toBe(true);
  // The welcome eSIM is listed with its codes, which the signed claim returned for that profile.
  const sim = mine.locator('.data-sim').filter({ hasText: 'ICCID ' + ICCID });
  await expect(sim.locator('.data-welcome-badge')).toHaveText('WELCOME');
  await expect(sim.locator('.data-ac')).toHaveText(simWithCodes.ac);
  await expect(sim.getByRole('link', { name: 'Install on iPhone' })).toHaveAttribute('href', simWithCodes.appleInstallUrl);
  expect(errors).toEqual([]);
});

test('a member listed by the ledger claims without a join proof, and an already-claimed answer reloads the account', async ({ page }) => {
  const wallet = await installWallet(page, { trusted: true });
  stubChain(page);
  const member = membership({ member: true, memberSince: SINCE, sharing: true, burned: JOIN_UNITS });
  const claimed = membership({ member: true, memberSince: SINCE, sharing: true, burned: JOIN_UNITS, welcomeOrder: welcomeOrder() });
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
  expect(api.posts[0]).not.toHaveProperty('joinTx');
  expect(api.posts[0]).toMatchObject({ welcome: true, packageCode: 'fixed_1GB_7D_EUROPE', address: ADDR });
  expect(wallet.verify(api.posts[0].message, api.posts[0].signature)).toBe(true);
  await expect(mine.locator('.data-sim .data-welcome-badge')).toHaveText('WELCOME');
});

test('closed enrolment shows its reason and offers no way to burn', async ({ page }) => {
  await installWallet(page, { trusted: true });
  stubChain(page);
  await stubApi(page, [standing({ membership: membership({ enrolment: { open: false, reason: 'The reserve is too low to pay for a welcome eSIM right now. Try again after the next top-up.' } }) })]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await expect(card).toContainText('Joining is closed right now. The reserve is too low to pay for a welcome eSIM right now.');
  await expect(card).toContainText('Members burn 180,000 OTT (about $5.00) once');
  await expect(page.getByRole('button', { name: /burn/i })).toHaveCount(0);
  await expect(mine.locator('.data-redeem')).toHaveCount(0);
});

test('a week without a join amount yet says so and offers no way to burn', async ({ page }) => {
  await installWallet(page, { trusted: true });
  stubChain(page);
  await stubApi(page, [standing({ membership: membership({ requirement: null, enrolment: { open: false, reason: 'This week’s join amount isn’t set yet. Try again shortly.' } }) })]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await expect(card).toContainText('Joining is closed right now. This week’s join amount isn’t set yet.');
  await expect(card).toContainText('Members burn about $5.00 of OTT once');
  await expect(page.getByRole('button', { name: /burn/i })).toHaveCount(0);
});

test('a short balance, or no OTT account at all, is refused before the wallet is asked', async ({ page }) => {
  const wallet = await installWallet(page, { trusted: true });
  const balance = { value: '50000000000' };
  stubNetwork(page, { methods: { getTokenAccountBalance: () => balance.value === null
    ? { error: { code: -32602, message: 'Invalid param: could not find account' } }
    : { context: { slot: 400000000 }, value: { amount: balance.value, decimals: 6, uiAmountString: '50000' } } } });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await confirmJoin(card);
  await expect(card.locator('.hint')).toHaveText('This wallet holds 50,000 OTT in its OTT account. Joining burns 180,000 OTT.');
  // The send stays off until the holder starts again; cancelling is still possible.
  await expect(card.getByRole('button', { name: 'Burn 180,000 OTT' })).toBeDisabled();
  await card.getByRole('button', { name: 'Cancel' }).click();

  balance.value = null;
  await confirmJoin(card);
  await expect(card.locator('.hint')).toHaveText('This wallet holds 0 OTT in its OTT account. Joining burns 180,000 OTT.');
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
});

test('a declined wallet approval says nothing was sent and leaves the confirmation ready to try again', async ({ page }) => {
  const wallet = await installWallet(page, { trusted: true, send: 'reject' });
  stubChain(page);
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await confirmJoin(card);
  await expect(card.locator('.hint')).toHaveText('The burn wasn’t approved. Nothing was sent.');
  await expect(card.getByRole('button', { name: 'Burn 180,000 OTT' })).toBeEnabled();
  expect(wallet.calls('signAndSendTransaction')).toHaveLength(1);
  expect(await joinStorage(page)).toBeNull();
});

test('a wallet that cannot send the join explains why, and nothing is remembered', async ({ page }) => {
  const wallet = await installWallet(page, { trusted: true, send: 'error' });
  stubChain(page);
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await confirmJoin(card);
  await expect(card.locator('.hint')).toHaveText('Could not burn: Transaction simulation failed: insufficient funds for fee.');
  await expect(card.getByRole('button', { name: 'Burn 180,000 OTT' })).toBeEnabled();
  expect(wallet.calls('signAndSendTransaction')).toHaveLength(1);
  expect(await joinStorage(page)).toBeNull();
});

test('a join that fails on chain says no OTT was burned and offers joining again', async ({ page }) => {
  await installWallet(page, { trusted: true });
  stubChain(page, { statuses: [{ confirmationStatus: 'confirmed', err: { InstructionError: [3, { Custom: 1 }] } }] });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await confirmJoin(card);
  await expect(card).toContainText('The burn transaction failed on chain, so no OTT was burned. You can try again.');
  await expect(card.getByRole('button', { name: 'Join: burn 180,000 OTT' })).toBeVisible();
  expect(await joinStorage(page)).toBeNull();
});

test('a join that has not confirmed yet is never offered again, only checked', async ({ page }) => {
  await page.clock.install();
  const wallet = await installWallet(page, { trusted: true });
  stubChain(page, { statuses: [null] });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await confirmJoin(card);
  await expect(card.locator('.hint')).toHaveText('Waiting for the burn to confirm on Solana…');
  // Each poll waits on a (stubbed) network answer before it schedules the next one, so the clock
  // moves a poll interval at a time until the page gives up waiting.
  await expect.poll(async () => {
    await page.clock.runFor(1600);
    return card.locator('h3').textContent();
  }, { timeout: 30000, intervals: [20] }).toBe('Your burn is confirming');
  await expect(card).toContainText('Don’t burn again');
  const link = card.locator('.data-burn-tx a');
  await expect(link).toHaveText(TX_SIGNATURE.slice(0, 8) + '…' + TX_SIGNATURE.slice(-8));
  await expect(link).toHaveAttribute('href', 'https://solscan.io/tx/' + TX_SIGNATURE);
  await expect(card.getByRole('button', { name: 'Check burn status' })).toBeVisible();
  await expect(card.getByRole('button', { name: /^(?:Join|Burn)/ })).toHaveCount(0);
  expect(wallet.calls('signAndSendTransaction')).toHaveLength(1);
});

test('an earlier join already on chain is found instead of asking for a second one', async ({ page }) => {
  const wallet = await installWallet(page, { trusted: true });
  const chain = stubChain(page, {
    signatures: [{ signature: EARLIER_TX, slot: 400000100, blockTime: NOW_S - 600, err: null, confirmationStatus: 'confirmed' }],
    transactions: { [EARLIER_TX]: joinTransactionResult({ signature: EARLIER_TX, wallet: ADDR, amount: JOIN_UNITS }) },
  });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await confirmJoin(card);
  await expect(mine.locator('.data-membership h3')).toHaveText('Claim your welcome eSIM');
  await expect(page.locator('#toasts')).toContainText('Membership found');
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
  const query = chain.asked('getSignaturesForAddress')[0];
  expect(query.params[0]).toBe(BURN_ACCOUNT);
  expect(query.params[1]).toMatchObject({ limit: 25 });
  expect(chain.asked('getTransaction')[0].params).toEqual([EARLIER_TX, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  expect(await joinStorage(page)).toBe(EARLIER_TX);
});

test('another wallet’s join, a join too small, or a failed one is not taken for this wallet’s', async ({ page }) => {
  const wallet = await installWallet(page, { trusted: true });
  const other = signatureFrom('another wallet'), small = signatureFrom('too small'), failed = signatureFrom('failed');
  stubChain(page, {
    signatures: [other, small, failed].map((signature, i) => ({ signature, slot: 400000100 + i, blockTime: NOW_S - 600, err: null, confirmationStatus: 'confirmed' })),
    transactions: {
      [other]: joinTransactionResult({ signature: other, wallet: addressFrom('someone else'), amount: JOIN_UNITS }),
      [small]: joinTransactionResult({ signature: small, wallet: ADDR, amount: '179999999999' }),
      [failed]: joinTransactionResult({ signature: failed, wallet: ADDR, amount: JOIN_UNITS, err: { InstructionError: [3, { Custom: 1 }] } }),
    },
  });
  await stubApi(page, [standing()]);
  const mine = await openData(page);
  const card = mine.locator('.data-membership');
  await confirmJoin(card);
  await expect(card.locator('h3')).toHaveText('Claim your welcome eSIM', { timeout: 15000 });
  await expect(page.locator('#toasts')).toContainText('Membership confirmed');
  expect(wallet.calls('signAndSendTransaction')).toHaveLength(1);
  expect(await joinStorage(page)).toBe(TX_SIGNATURE);
});

test('a rejected join proof is forgotten and the wallet is shown how to join again', async ({ page }) => {
  await page.addInitScript(({ addr, tx }) => localStorage.setItem('ott-membership-join:' + addr, tx), { addr: ADDR, tx: JOIN_TX });
  await installWallet(page, { trusted: true });
  stubChain(page);
  await stubApi(page, [standing()], () => [{ ok: false, error: 'the join transaction was not found or did not send enough OTT' }, 409]);
  const mine = await openData(page);
  await mine.locator('.data-membership').getByRole('button', { name: /^Claim / }).click();
  await expect(page.locator('#toasts')).toContainText('the join transaction was not found or did not send enough OTT');
  await expect(mine.locator('.data-membership h3')).toHaveText('Join OT+T');
  expect(await joinStorage(page)).toBeNull();
});

test('an API that reports no membership keeps the weekly flow and never mentions burning', async ({ page }) => {
  await installWallet(page, { trusted: true });
  stubChain(page);
  await stubApi(page, [standing({ membership: { configured: false }, allowanceUsd: 20, remainingUsd: 20 })]);
  const mine = await openData(page);
  await expect(mine.locator('.data-redeem')).toHaveCount(1);
  await expect(mine.locator('.data-membership')).toHaveCount(0);
  await expect(mine).not.toContainText(/burn/i);
});

test('the app home invites a non-member to join instead of showing a $0.00 balance', async ({ page }) => {
  await installWallet(page, { trusted: true });
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
  await installWallet(page, { trusted: true });
  stubChain(page);
  await stubApi(page, [standing({ allowanceUsd: 12, remainingUsd: 12, membership: membership({ member: true, memberSince: SINCE, sharing: true }) })]);
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
