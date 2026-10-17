'use strict';
/**
 * A weekly redemption whose answer is lost or unconfirmed. The order may already be paid, so the
 * page never offers a second purchase for it: it checks the existing order with a GET, allows only
 * an explicit retry of the same plan and slot, and keeps installation details private.
 */
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
const { installWallet, walletAddress } = require('./support/wallet');
const { COIN, TREASURY, TOKEN_2022, INCINERATOR, BURN_ACCOUNT, addressFrom, signatureFrom } = require('./support/solana');
test.use({ serviceWorkers: 'block' });

const ADDRESS = walletAddress();
const WEEK = Math.floor((Date.now() / 1000 - 345600) / 604800);
const WEEK_END = 345600 + (WEEK + 1) * 604800;
const CATALOGUE = require('../../site/config/esim.json');
const CFG = { ...CATALOGUE, chain: 'solana', coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY,
  membership: { ...CATALOGUE.membership, burnAccount: BURN_ACCOUNT } };
const JOIN_UNITS = '180000000000';
const MEMBERSHIP = { configured: true, coin: COIN, tokenProgram: TOKEN_2022, decimals: 6, burnOwner: INCINERATOR, burnAccount: BURN_ACCOUNT,
  burnUsd: 5, requirement: { week: WEEK, burnTokens: '180000', burnUnits: JOIN_UNITS, priceUsd: 0.0000278 }, burned: JOIN_UNITS,
  welcome: CATALOGUE.membership.welcome, capMultiple: 3, member: true, sharing: true,
  memberSince: { at: Math.floor(Date.now() / 1000) - 86400, slot: 399000000, tx: signatureFrom('recovery join') },
  welcomeOrder: null, enrolment: { open: true, reason: '' } };
const STANDING = { ok: true, address: ADDRESS, week: WEEK, weekEnd: WEEK_END,
  tokens: '1000000000', decimals: 6, share: 0.01, allowanceUsd: 10, redeemedUsd: 0,
  remainingUsd: 10, stale: false, allowancesWeek: WEEK, orders: [], history: [], sims: [], membership: MEMBERSHIP };
const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });

async function fixture(page, behaviour = {}) {
  stubNetwork(page);
  await page.route('**/config/esim.json', route => route.fulfill(json(CFG)));
  await page.route('**/data/allowances.json', route => route.fulfill(json({ chain: 'solana', week: WEEK, weekEnd: WEEK_END, decimals: 6,
    coin: COIN, tokenProgram: TOKEN_2022, memberTokens: '100000000000', members: { [ADDRESS]: { burned: JOIN_UNITS, since: MEMBERSHIP.memberSince } },
    wallets: { [ADDRESS]: { tokens: STANDING.tokens, share: 0.01, allowanceUsd: 10, member: true } } })));
  return installWallet(page, { trusted: true, ...behaviour });
}
function order(body, pending = true) {
  const pkg = CFG.packages.find(value => value.code === body.packageCode);
  return { n: body.n, week: WEEK, packageCode: pkg.code, transactionId: 'fixture-order-' + body.n,
    priceUsd: pkg.priceUsd, iccid: pending ? '' : 'fixture-iccid', stage: pending ? 'invoiced' : 'done', pending,
    codes: false, ac: '', createdAt: new Date().toISOString() };
}

test('a lost accepted response recovers the existing order with a GET and no second purchase', async ({ page }) => {
  const wallet = await fixture(page); await page.setViewportSize({ width: 390, height: 844 });
  const posts = [];
  let standing = STANDING;
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'GET') return route.fulfill(json(standing));
    const body = route.request().postDataJSON(); posts.push(body);
    const accepted = order(body);
    standing = { ...STANDING, orders: [accepted], redeemedUsd: accepted.priceUsd, remainingUsd: 10 - accepted.priceUsd };
    return route.abort('failed');
  });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeDisabled();
  await expect(page.locator('#f-place')).toBeDisabled();
  await expect(page.locator('.data-redeem .data-order-progress')).toHaveAttribute('data-phase', 'checking');
  await expect(page.locator('.data-redeem .data-order-progress')).not.toContainText('The provider is issuing your data package.');
  await page.getByRole('button', { name: 'Check existing order', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toHaveCount(0);
  await expect(page.locator('.data-sims')).toContainText('Paying the invoice');
  expect(posts).toHaveLength(1);
  // The one purchase carried this wallet's signature over the plan and slot it names.
  expect(posts[0].message).toContain('Plan: ' + posts[0].packageCode);
  expect(posts[0].message).toContain('Slot: 0');
  expect(wallet.verify(posts[0].message, posts[0].signature)).toBe(true);
  expect(wallet.calls('signMessage')).toHaveLength(1);
  expect(wallet.calls('signAndSendTransaction')).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('fixture-order');
});

test('checking an unseen order permits only an explicit retry of the same plan and slot', async ({ page }) => {
  const wallet = await fixture(page);
  const posts = [];
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'GET') return route.fulfill(json(STANDING));
    const body = route.request().postDataJSON(); posts.push(body);
    if (posts.length === 1) return route.abort('failed');
    const accepted = order(body, false);
    return route.fulfill(json({ ok: true, order: accepted, remainingUsd: 10 - accepted.priceUsd, sims: [] }));
  });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: /^Redeem / }).click();
  await page.getByRole('button', { name: 'Check existing order', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same order', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeDisabled();
  await expect(page.locator('#f-place')).toBeDisabled();
  expect(posts).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry same order', exact: true }).click();
  await expect(page.locator('.data-sims')).toContainText('fixture-iccid');
  expect(posts).toHaveLength(2);
  expect(posts[1].n).toBe(posts[0].n); expect(posts[1].packageCode).toBe(posts[0].packageCode);
  // A redemption signature is never reused: the retry was approved again in the wallet.
  expect(wallet.calls('signMessage')).toHaveLength(2);
  expect(posts.every(body => wallet.verify(body.message, body.signature))).toBe(true);
});

test('a declined signature leaves the plan retryable without sending a purchase', async ({ page }) => {
  const wallet = await fixture(page, { sign: 'reject' });
  let posts = 0;
  await page.route('**/api/redeem**', route => {
    if (route.request().method() !== 'GET') posts++;
    return route.fulfill(json(STANDING));
  });
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.locator('.data-redeem')).toContainText('Could not redeem: The request was not approved in your wallet.');
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeEnabled();
  await expect(page.locator('#f-place')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toHaveCount(0);
  expect(posts).toBe(0);
  expect(wallet.calls('signMessage')).toHaveLength(1);
});

test('route changes preserve the unconfirmed plan and mismatched reads cannot unlock it', async ({ page }) => {
  await fixture(page);
  let foreign = false, posts = 0;
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'POST') { posts++; return route.abort('failed'); }
    return route.fulfill(json(foreign ? { ...STANDING, address: addressFrom('foreign wallet'),
      orders: [{ ...order({ packageCode: CFG.packages[0].code, n: 0 }), ac: 'PRIVATE-FOREIGN-CODE' }] } : STANDING));
  });
  await page.goto('/#/app/esims');
  await page.locator('#f-place').selectOption('australia');
  await page.getByRole('button', { name: /^Redeem / }).click();
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Help', exact: true }).click();
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toBeVisible();
  await expect(page.locator('#f-place')).toHaveValue('australia');
  foreign = true;
  await page.getByRole('button', { name: 'Check existing order', exact: true }).click();
  await expect(page.locator('.data-order-recovery')).toContainText('could not be checked');
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeDisabled();
  await expect(page.locator('body')).not.toContainText('PRIVATE-FOREIGN-CODE');
  expect(posts).toBe(1);
});

test('leaving the account during wallet approval cancels a purchase before dispatch', async ({ page }) => {
  const wallet = await fixture(page);
  let posts = 0;
  await page.route('**/api/redeem**', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill(json(STANDING));
  });
  await page.goto('/#/app/esims');
  wallet.behave({ sign: 'hold' });
  await page.getByRole('button', { name: /^Redeem / }).click();
  await expect(page.getByRole('status', { name: 'Order progress', exact: true })).toHaveAttribute('data-phase', 'wallet');
  await expect.poll(() => wallet.calls('signMessage').length).toBe(1);
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Help', exact: true }).click();
  wallet.behave({ sign: 'approve' });
  expect(wallet.release('signMessage')).toBe(1);
  await expect(page.getByRole('heading', { name: 'Set up your eSIM', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'eSIMs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your eSIMs.', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Redeem / })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Check existing order', exact: true })).toHaveCount(0);
  expect(posts).toBe(0);
});

test('connected eSIMs precede expandable holdings details on phones and desktop', async ({ page }) => {
  await fixture(page);
  const existing = order({ packageCode: 'fixed_1GB_7D_AU', n: 0 }, false);
  await page.route('**/api/redeem**', route => route.fulfill(json({ ...STANDING, orders: [existing] })));
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 844 : 1000 });
    await page.goto('/#/app/esims');
    await page.reload();
    await expect(page.locator('.data-sims')).toBeVisible();
    await expect(page.locator('.data-account-details')).not.toHaveAttribute('open', '');
    expect(await page.locator('.data-sims').evaluate(element => !!(element.compareDocumentPosition(document.querySelector('.data-account-details')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await page.locator('.data-account-details > summary').click();
    await expect(page.locator('.data-headline')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
