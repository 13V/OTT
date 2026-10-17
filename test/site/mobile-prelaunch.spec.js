'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
const { installWallet } = require('./support/wallet');
const { S, COIN, TREASURY, TOKEN_2022, INCINERATOR, BURN_ACCOUNT, ata } = require('./support/solana');
const CFG = require('../../site/config/esim.json');
const json = body => ({ contentType: 'application/json', body: JSON.stringify(body) });
test.use({ serviceWorkers: 'block' });

test('device checks work before launch without a wallet approval, installation link or order', async ({ page }) => {
  stubNetwork(page);
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/api/')) writes.push(request.url()); });
  // A Solana wallet is installed but never approved here: device checks must not ask it for anything.
  const wallet = await installWallet(page, { connect: 'reject', sign: 'reject', send: 'reject' });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/#/app/help');
  const check = page.getByRole('button', { name: 'Check your phone', exact: true });
  await check.click();
  const sheet = page.getByRole('dialog', { name: 'Check your phone', exact: true });
  await expect(sheet).toContainText('while OTT is in prelaunch');
  await expect(sheet).toContainText('No SIM restrictions');
  await expect(sheet).toContainText('OTT cannot detect your phone’s eSIM support or carrier lock.');
  await expect(sheet.getByRole('link', { name: 'Apple’s carrier lock guide ↗', exact: true })).toHaveAttribute('href', 'https://support.apple.com/en-us/109316');
  const devices = sheet.getByRole('group', { name: 'Device to check', exact: true });
  await devices.getByRole('button', { name: 'Google Pixel', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(devices.getByRole('button', { name: 'Google Pixel', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('.om-settings-path')).toHaveText('Settings → Network & internet → SIMs → Add SIM → Set up an eSIM');
  await expect(sheet).toContainText('An Add eSIM option alone does not confirm that it is unlocked.');
  await expect(sheet.getByRole('link', { name: 'Google Pixel eSIM guidance ↗', exact: true })).toHaveAttribute('href', 'https://support.google.com/pixelphone/answer/16115470?hl=en');
  await devices.getByRole('button', { name: 'Samsung Galaxy', exact: true }).click();
  await expect(devices.getByRole('button', { name: 'Samsung Galaxy', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('.om-settings-path')).toHaveText('Settings → Connections → SIM manager → Add eSIM');
  await expect(sheet.getByRole('link', { name: 'Samsung Galaxy eSIM guidance ↗', exact: true })).toHaveAttribute('href', 'https://www.samsung.com/us/support/answer/ANS10001619/');
  await expect(sheet.locator('a[href^="https://esimsetup"]')).toHaveCount(0);
  expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(check).toBeFocused();
  expect(wallet.calls()).toEqual([]);
  expect(writes).toEqual([]);
});

test('an empty or invalid catalogue shows a recoverable state and keeps the setup guide usable', async ({ page }) => {
  stubNetwork(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let packages = [];
  await page.route('**/config/esim.json', route => route.fulfill(json({ ...CFG, packages })));
  await page.goto('/#/app');
  await expect(page.locator('.om-status-pill')).toHaveText('Offline');
  await expect(page.getByRole('heading', { name: 'You’re offline, or OTT couldn’t load.', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try the app preview', exact: true })).toHaveCount(0);
  packages = [null, {}, { ...CFG.packages[0], priceUsd: -1 }, { ...CFG.packages[0], days: 0 }];
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.om-status-pill')).toHaveText('Offline');
  await page.getByRole('link', { name: 'Open the setup guide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check your phone', exact: true })).toBeVisible();
  packages = [null, {}, ...CFG.packages];
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('.om-status-pill')).toHaveText('Prelaunch');
  await page.getByRole('button', { name: 'Try the app preview', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$15.00');
  expect(errors).toEqual([]);
});

// Solana's all-zero key (the system program's address) is what an unset address looks like, so a
// config carrying it is a placeholder, as is a token program that is neither Token nor Token-2022,
// or launch addresses only partly filled in. The API refuses all three as not launched, and the
// app must not advertise them as a configured programme either.
const ZERO = S.PROGRAMS.system;
const LAUNCH = { coin: COIN, tokenProgram: TOKEN_2022, treasury: TREASURY, membership: { ...CFG.membership, burnAccount: BURN_ACCOUNT } };
for (const [name, launch] of [
  ['the all-zero key as the coin and treasury', { coin: ZERO, tokenProgram: TOKEN_2022, treasury: ZERO, membership: { ...CFG.membership, burnAccount: ata(INCINERATOR, ZERO) } }],
  ['the all-zero key as the treasury', { ...LAUNCH, treasury: ZERO }],
  ['a token program that is not Token or Token-2022', { ...LAUNCH, tokenProgram: ZERO }],
  ['no incinerator account yet', { ...LAUNCH, membership: { ...CFG.membership, burnAccount: '' } }],
]) {
  test('placeholder launch addresses (' + name + ') never make the app advertise a configured programme', async ({ page }) => {
    stubNetwork(page);
    await page.route('**/config/esim.json', route => route.fulfill(json({ ...CFG, ...launch })));
    await page.goto('/#/app/plans');
    await expect(page.locator('.om-status-pill')).toHaveText('Prelaunch');
    await expect(page.locator('.om-prelaunch-note')).toHaveText('Membership enrolment is not open. Preview only.');
    await page.getByRole('button', { name: 'Review package', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Catalogue preview. Joining and purchases are not open yet.');
    await expect(page.getByRole('button', { name: 'Continue to eSIMs', exact: true })).toHaveCount(0);
  });
}

test('a complete Solana launch config is what makes the app advertise a configured programme', async ({ page }) => {
  stubNetwork(page);
  await page.route('**/config/esim.json', route => route.fulfill(json({ ...CFG, ...LAUNCH })));
  await page.goto('/#/app/plans');
  await expect(page.locator('.om-status-pill')).toHaveText('Configured');
  await expect(page.locator('.om-prelaunch-note')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Your wallet will confirm the exact package before a real redemption.');
  await expect(page.getByRole('button', { name: 'Continue to eSIMs', exact: true })).toHaveCount(1);
});
