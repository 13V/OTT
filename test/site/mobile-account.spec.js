'use strict';
/**
 * The app's account screens with a live (stubbed) programme: Home shows only the credit the API
 * confirms, never a figure borrowed from the published ledger, and installation codes appear only
 * for a signature the connected wallet gave just now. The wallet is a Wallet Standard fake with a
 * real ed25519 key (test/site/support/wallet.js), so a signature the page posts can be checked
 * the way the API checks it.
 */
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
const { installWallet, walletAddress } = require('./support/wallet');
const { COIN, TREASURY, TOKEN_2022, INCINERATOR, BURN_ACCOUNT, addressFrom, signatureFrom } = require('./support/solana');

test.use({ serviceWorkers: 'block' });

const ADDRESS = walletAddress();
const WEEK = Math.floor((Date.now() / 1000 - 345600) / 604800);
const WEEK_END = 345600 + (WEEK + 1) * 604800;
const PUBLISHED = require('../../site/config/esim.json');
const CFG = { ...PUBLISHED, chain: 'solana', coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY,
  membership: { ...PUBLISHED.membership, burnAccount: BURN_ACCOUNT } };
const ORDER = { n: 0, week: WEEK, transactionId: 'fixture-only', packageCode: 'fixed_5GB_30D_US', priceUsd: 7.99,
  iccid: 'fixture-not-an-iccid', createdAt: new Date().toISOString(), stage: 'done', pending: false,
  codes: false, ac: '', qrCodeUrl: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '' };
// A member in this week's split, as /api/redeem reports one.
const MEMBERSHIP = { configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT,
  burnUsd: 5, requirement: { week: WEEK, burnTokens: '180000', burnUnits: '180000000000', priceUsd: 0.0000278 }, burned: '180000000000',
  welcome: { gb: 1, days: 7, maxUsd: 4 }, capMultiple: 3, member: true,
  memberSince: { at: WEEK_END - 604800 - 86400 * 3, slot: 399000000, tx: signatureFrom('member join') }, sharing: true,
  welcomeOrder: null, enrolment: { open: true, reason: '' } };
const STANDING = { ok: true, address: ADDRESS, week: WEEK, weekEnd: WEEK_END, tokens: '1234000000',
  share: 0.01, allowanceUsd: 20, decimals: 6, redeemedUsd: 7.99, remainingUsd: 12.01, stale: false, allowancesWeek: WEEK, poolUsd: 120,
  orders: [ORDER], history: [], sims: [], membership: MEMBERSHIP };
const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });

/** The launched programme and a Solana wallet; `trusted` means the site already has its approval and reconnects it on load. */
async function accountFixture(page, { trusted = true } = {}) {
  stubNetwork(page);
  await page.route('**/config/esim.json', route => route.fulfill(json(CFG)));
  // A published allowance alone cannot say how much has already been spent.
  await page.route('**/data/allowances.json', route => route.fulfill(json({ week: WEEK, weekEnd: WEEK_END, decimals: 6,
    wallets: { [ADDRESS]: { tokens: STANDING.tokens, share: 0.01, allowanceUsd: 999, member: true } } })));
  return installWallet(page, { trusted });
}

test('Home shows confirmed API credit and expiry without requesting a wallet signature', async ({ page }) => {
  const wallet = await accountFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  await page.route('**/api/redeem**', route => { requests.push(route.request().method()); return route.fulfill(json(STANDING)); });
  await page.goto('/#/app');
  await expect(page.locator('.om-balance')).toHaveText('$12.01');
  await expect(page.locator('.om-credit-details')).toContainText('Allocated$20.00');
  await expect(page.locator('.om-credit-details')).toContainText('Used$7.99');
  await expect(page.locator('.om-credit-expiry time')).toHaveAttribute('datetime', new Date(WEEK_END * 1000).toISOString());
  const primary = await page.locator('.om-credit-card').getByRole('button', { name: 'Find a data plan', exact: true }).boundingBox();
  const nav = await page.getByRole('navigation', { name: 'App navigation' }).boundingBox();
  expect(primary.y + primary.height).toBeLessThanOrEqual(nav.y);
  await expect(page.locator('.om-credit-card')).not.toContainText('Sample');
  await expect(page.locator('.om-credit-card')).not.toContainText('GB');
  // The only wallet call is the silent reconnect of a wallet this site already had.
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: true }]);
  expect(requests.every(method => method === 'GET')).toBe(true);
  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  const settings = page.getByRole('dialog');
  await expect(settings).toContainText(ADDRESS);
  await expect(settings).toContainText('Your Solana wallet (Phantom) is your OTT account.');
  await expect(settings.getByRole('link', { name: 'View on Solscan ↗' })).toHaveAttribute('href', 'https://solscan.io/account/' + ADDRESS);
  await page.getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBeNull();
  expect(wallet.calls().map(call => call.method)).toEqual(['connect', 'disconnect']);
  // Disconnecting forgets the wallet: a reload does not reconnect it, even silently.
  await page.reload();
  await expect(page.locator('.om-credit-card')).toBeVisible();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
  expect(wallet.calls().map(call => call.method)).toEqual(['connect', 'disconnect']);
});

/**
 * Refresh the account and wait until Home has painted the answer to that refresh: the read is
 * sent only once the new credit pass is on the page, which is busy until the answer is in.
 */
async function refreshAccount(page, served) {
  const before = served.count;
  await page.getByRole('button', { name: 'Refresh account', exact: true }).click();
  await expect.poll(() => served.count).toBeGreaterThan(before);
  await expect(page.locator('.om-credit-card')).toHaveAttribute('aria-busy', 'false');
}

test('stale or expired allocations never appear as spendable Home credit', async ({ page }) => {
  await accountFixture(page);
  let response = { ...STANDING, stale: true, remainingUsd: 100 };
  const served = { count: 0 };
  await page.route('**/api/redeem**', route => { served.count++; return route.fulfill(json(response)); });
  await page.goto('/#/app');
  await expect(page.locator('.om-pass-title')).toHaveText('Awaiting allocation');
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.om-credit-expiry')).toHaveCount(0);
  response = { ...STANDING, stale: false, weekEnd: Math.floor(Date.now() / 1000) - 60 };
  await refreshAccount(page, served);
  await expect(page.locator('.om-pass-title')).toHaveText('Awaiting allocation');
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.om-credit-expiry')).toHaveCount(0);
});

test('unavailable or mismatched API responses never borrow a balance from the published allowance', async ({ page }) => {
  await accountFixture(page);
  let response = null;
  const served = { count: 0 };
  await page.route('**/api/redeem**', route => { served.count++; return response ? route.fulfill(json(response)) : route.fulfill({ status: 503, body: 'API unavailable' }); });
  await page.goto('/#/app');
  await expect(page.locator('.om-pass-title')).toHaveText('Credit unavailable');
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.om-credit-expiry')).toHaveCount(0);
  await expect(page.locator('.om-credit-card')).not.toContainText('$999');
  // An answer for another wallet is refused, including one that differs from this address only
  // in letter case: Solana addresses are case-sensitive, so it is a different account.
  for (const address of [addressFrom('another wallet'), ADDRESS.toLowerCase(), ADDRESS.toUpperCase()]) {
    response = { ...STANDING, address };
    await refreshAccount(page, served);
    await expect(page.locator('.om-pass-title')).toHaveText('Credit unavailable');
    await expect(page.locator('.om-balance')).toHaveCount(0);
  }
  // The same answer for this exact address is accepted, so the refusals above are about the address.
  response = STANDING;
  await refreshAccount(page, served);
  await expect(page.locator('.om-balance')).toHaveText('$12.01');
  await expect(page.locator('.om-credit-card')).not.toContainText('$999');
});

test('a member with no OTT at the snapshot sees zero credit and can browse plans without a signature or order', async ({ page }) => {
  const wallet = await accountFixture(page);
  await page.setViewportSize({ width: 360, height: 800 });
  const requests = [];
  await page.route('**/api/redeem**', route => {
    requests.push(route.request().method());
    return route.fulfill(json({ ...STANDING, tokens: '0', share: 0, allowanceUsd: 0, redeemedUsd: 0,
      remainingUsd: 0, orders: [], history: [], sims: [], membership: { ...MEMBERSHIP, sharing: false } }));
  });
  await page.goto('/#/app');
  await expect(page.locator('.om-balance')).toHaveText('$0.00');
  await expect(page.locator('.om-pass-note')).toHaveText('Your weekly share starts at the next Monday snapshot.');
  await expect(page.locator('.om-credit-card')).not.toContainText('Sample');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.locator('.data-mine')).toContainText('Your weekly share starts at the next Monday snapshot, from the OTT this wallet holds then.');
  await expect(page.getByRole('button', { name: /^Redeem / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show my eSIM codes', exact: true })).toHaveCount(0);
  await expect(page.locator('.data-qr')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Your wallet will confirm the exact package before a real redemption.');
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: true }]);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(method => method === 'GET')).toBe(true);
});

test('codes that arrive after the wallet disconnects are never shown, and reconnecting needs a fresh signature', async ({ page }) => {
  // Not trusted yet: the holder connects with the button, which shares the account and signs nothing.
  const wallet = await accountFixture(page, { trusted: false });
  let releaseCodes;
  const pendingCodes = new Promise(resolve => { releaseCodes = resolve; });
  const posts = [];
  const signed = { ...STANDING, orders: [{ ...ORDER, codes: true, ac: 'LPA:1$smdp.example$FIXTURE-ONLY',
    smdpAddress: 'smdp.example', matchingId: 'FIXTURE-ONLY' }] };
  await page.route('**/api/redeem**', async route => {
    if (route.request().method() === 'GET') return route.fulfill(json(STANDING));
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) await pendingCodes;
    return route.fulfill(json(signed));
  });
  await page.goto('/#/app');
  expect(wallet.calls()).toEqual([]);
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$12.01');
  expect(wallet.calls()).toEqual([{ method: 'connect', silent: false }]);
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  // The holder leaves and disconnects while the signed read is still in flight.
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Wallet settings', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
  releaseCodes();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  await expect(page.locator('.data-ac')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('FIXTURE-ONLY');
  await page.locator('.om-home-actions').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$12.01');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('FIXTURE-ONLY');
  // Each read needed its own approval in the wallet, and each checks out for this wallet. (Two
  // reads within the same second sign the same text, so the proof is the prompt, not the text.)
  expect(wallet.calls('signMessage')).toHaveLength(2);
  expect(posts).toHaveLength(2);
  expect(posts.every(body => !body.packageCode && body.address === ADDRESS && wallet.verify(body.message, body.signature))).toBe(true);
  expect(wallet.calls('signMessage').map(call => call.message)).toEqual(posts.map(body => body.message));
  expect(posts.map(body => body.message.split('\n')[0])).toEqual(['OT+T — show my eSIM codes', 'OT+T — show my eSIM codes']);
});

test('configured external backend handles both public and authorized reads without a local API fallback', async ({ page }) => {
  const wallet = await accountFixture(page);
  const origin = 'https://api.fixture.example';
  await page.route('**/config/app.json', route => route.fulfill(json({ apiBaseUrl: origin })));
  const remoteRequests = [];
  const localRequests = [];
  await page.route(origin + '/api/redeem**', route => {
    const request = route.request();
    remoteRequests.push({ url: request.url(), method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null });
    const signed = { ...STANDING, orders: [{ ...ORDER, codes: true, ac: 'LPA:1$smdp.example$EXTERNAL-FIXTURE' }] };
    return route.fulfill(json(request.method() === 'POST' ? signed : STANDING));
  });
  await page.route(url => url.hostname === '127.0.0.1' && url.pathname === '/api/redeem', route => {
    localRequests.push(route.request().url()); return route.fulfill({ status: 500, body: 'A local fallback must not be used.' });
  });
  await page.goto('/#/app');
  await expect(page.locator('.om-balance')).toHaveText('$12.01');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('EXTERNAL-FIXTURE');
  const reads = remoteRequests.filter(request => request.method === 'GET');
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every(request => new URL(request.url).searchParams.get('address') === ADDRESS)).toBe(true);
  const authorized = remoteRequests.filter(request => request.method === 'POST');
  expect(authorized).toHaveLength(1);
  expect(new URL(authorized[0].url).origin).toBe(origin);
  expect(authorized[0].body.message).toContain('Site: ' + new URL(page.url()).host);
  expect(authorized[0].body.message).toContain('Wallet: ' + ADDRESS);
  expect(wallet.verify(authorized[0].body.message, authorized[0].body.signature)).toBe(true);
  expect(authorized[0].body).not.toHaveProperty('packageCode');
  expect(localRequests).toEqual([]);
});

test('invalid backend origins stop authorization before asking the wallet to sign', async ({ page }) => {
  const wallet = await accountFixture(page);
  const posts = [];
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'POST') posts.push(route.request().postDataJSON());
    return route.fulfill(json(STANDING));
  });
  await page.goto('/#/app/esims');
  const reveal = page.getByRole('button', { name: 'Show my eSIM codes', exact: true });
  await expect(reveal).toBeVisible();
  for (const apiBaseUrl of ['http://api.fixture.example', 'https://user:password@api.fixture.example',
    'https://api.fixture.example/?token=fixture', 'https://api.fixture.example/ott']) {
    await page.evaluate(apiBaseUrl => window.OTTClientConfig.configure({ apiBaseUrl }), apiBaseUrl);
    await reveal.click();
    await expect(page.locator('.data-sims .hint')).toContainText('backend address is invalid');
    expect(wallet.calls('signMessage')).toEqual([]);
  }
  expect(posts).toEqual([]);
  await expect(page.locator('.data-ac')).not.toContainText('FIXTURE-ONLY');
});
