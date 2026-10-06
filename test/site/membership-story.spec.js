'use strict';

const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
test.use({ serviceWorkers: 'block' });

async function story(page) {
  const network = stubNetwork(page), writes = [], errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\//.test(new URL(request.url()).pathname)) writes.push(request.url());
  });
  await page.addInitScript(() => {
    window.membershipWalletCalls = [];
    window.ethereum = { on() {}, off() {}, request: async ({ method }) => {
      window.membershipWalletCalls.push(method);
      if (method === 'eth_accounts') return [];
      throw new Error('The membership story must not connect, sign, burn or pay: ' + method);
    } };
  });
  await page.goto('/index.html#/');
  await expect(page.locator('.ott-hero-title')).toHaveText('A memecoin with a data plan.');
  return { network, writes, errors };
}
const exampleResult = page => page.getByLabel('Illustrative weekly data credit', { exact: true });
const inputs = page => ({ fees: page.getByLabel('Daily fees collected ($)', { exact: true }),
  percent: page.getByLabel('Example data allocation (%)', { exact: true }),
  members: page.getByLabel('Enrolled users', { exact: true }) });
async function openExample(page) {
  await inputs(page).fees.scrollIntoViewIfNeeded();
  await expect(inputs(page).fees).toBeVisible();
}
function noApprovalCalls(methods) {
  expect(methods).not.toContain('eth_requestAccounts');
  expect(methods).not.toContain('personal_sign');
  expect(methods).not.toContain('eth_sendTransaction');
  expect(methods).not.toContain('eth_signTypedData_v4');
}

test('the proposed one-time burn enrols for a first eSIM while collected trading fees fund future data', async ({ page }) => {
  const f = await story(page);
  await expect(page.locator('.ott-hero-sub')).toContainText('Burn once to get your eSIM.');
  await expect(page.locator('.ott-hero-sub')).toContainText('Trading fees fund your data.');
  const journey = page.locator('#how-it-works');
  await expect(journey).toContainText(/burn once/i);
  await expect(journey).toContainText(/first eSIM/i);
  await expect(journey).toContainText(/trading fees/i);
  await expect(journey).toContainText(/(?:planned|proposed)/i);
  const illustration = journey.locator('.ott-member-enrol-art img');
  await expect(illustration).toHaveAttribute('src', './assets/ott/membership-burn-world.png');
  await illustration.scrollIntoViewIfNeeded();
  await expect.poll(() => illustration.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.locator('.ott-hero-note')).toContainText(/enrolment.*(?:not open|closed)/i);
  await expect(page.getByRole('button', { name: /^Burn(?:\s|$)/i })).toHaveCount(0);
  await expect(page.locator('#ott-example-share')).toHaveCount(0);
  noApprovalCalls(await page.evaluate(() => window.membershipWalletCalls));
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('Trust opens the pending-protection section from Status and on a direct reload without wallet approval or writes', async ({ page }) => {
  const f = await story(page);
  await page.goto('/index.html#/status');
  await expect(page.locator('#view h1')).toBeVisible();
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Trust', exact: true }).click();
  await expect(page).toHaveURL(/#trust$/);
  const trust = page.locator('#trust');
  await expect(trust.getByText('Escrow planned', { exact: true })).toBeVisible();
  await expect.poll(() => trust.evaluate(section => Math.round(section.getBoundingClientRect().top))).toBeLessThan(130);
  await page.reload();
  await expect(trust.getByText('Contract review pending', { exact: true })).toBeVisible();
  await expect.poll(() => trust.evaluate(section => Math.round(section.getBoundingClientRect().top))).toBeLessThan(130);
  noApprovalCalls(await page.evaluate(() => window.membershipWalletCalls));
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('trust marks planned protections and outstanding review and phone testing without presenting completion', async ({ page }) => {
  const f = await story(page);
  const trust = page.locator('#trust');
  await expect(trust).toBeVisible();
  for (const label of ['Escrow planned', 'Contract review pending', 'Funded phone test pending']) {
    await expect(trust.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(trust.getByText(/^(?:Audited|Escrow active|Phone test passed|Fully insured|Guaranteed data)$/i)).toHaveCount(0);
  await expect(trust).toContainText(/(?:pending|planned)/i);
  noApprovalCalls(await page.evaluate(() => window.membershipWalletCalls));
  expect(f.writes).toEqual([]);
  expect(f.network.blocked).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('the fee example varies daily collection, allocation and enrolled users without becoming an account balance', async ({ page }) => {
  const f = await story(page);
  await expect(exampleResult(page)).toHaveText('$5.60');
  await expect(page.locator('.ott-example-label')).toContainText('Example only. This is not your balance or a forecast.');
  await openExample(page);
  const controls = inputs(page);
  await expect(controls.fees).toHaveValue('1000');
  await expect(controls.percent).toHaveValue('80');
  await expect(controls.members).toHaveValue('1000');
  await controls.fees.fill('2000');
  await expect(exampleResult(page)).toHaveText('$11.20');
  await controls.percent.fill('50');
  await expect(exampleResult(page)).toHaveText('$7.00');
  await controls.members.fill('500');
  await expect(exampleResult(page)).toHaveText('$14.00');
  await controls.fees.fill('0');
  await expect(exampleResult(page)).toHaveText('$0.00');
  await controls.fees.fill('1000');
  await controls.percent.fill('0');
  await expect(exampleResult(page)).toHaveText('$0.00');
  await expect(page.locator('.ott-statement-balance')).toContainText('$15.00');
  noApprovalCalls(await page.evaluate(() => window.membershipWalletCalls));
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

test('invalid fee examples refuse negative, non-finite, out-of-range and non-integer membership inputs', async ({ page }) => {
  const f = await story(page);
  await openExample(page);
  const controls = inputs(page);
  for (const [field, invalid] of [
    ['fees', ''], ['fees', '-1'], ['fees', '1e309'], ['fees', '1e16'],
    ['percent', '-1'], ['percent', '101'], ['percent', '1e309'],
    ['members', '0'], ['members', '-1'], ['members', '1.5'], ['members', '1e309'], ['members', '9007199254740992'],
  ]) {
    await controls.fees.fill('1000'); await controls.percent.fill('80'); await controls.members.fill('1000');
    await controls[field].fill(invalid);
    await expect(controls[field]).toHaveAttribute('aria-invalid', 'true');
    await expect(exampleResult(page), field + ': ' + invalid).toHaveText('—');
    await expect(page.locator('.ott-example-error')).not.toHaveText('');
    await expect(exampleResult(page)).not.toContainText(/NaN|Infinity/);
  }
  await controls.members.fill('1');
  await expect(exampleResult(page)).toHaveText('$5,600.00');
  noApprovalCalls(await page.evaluate(() => window.membershipWalletCalls));
  expect(f.writes).toEqual([]);
  expect(f.errors).toEqual([]);
});

for (const width of [320, 2538]) {
  test('the membership story and calculator stay usable at ' + width + 'px with reduced motion and keyboard input', async ({ page }) => {
    await page.setViewportSize({ width, height: width === 320 ? 844 : 1299 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const f = await story(page);
    const controls = inputs(page);
    for (const control of Object.values(controls)) {
      await expect(control).toBeVisible();
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await controls.members.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('2000');
    await expect(exampleResult(page)).toHaveText('$2.80');
    await expect(page.locator('#trust')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
    noApprovalCalls(await page.evaluate(() => window.membershipWalletCalls));
    expect(f.writes).toEqual([]);
    expect(f.errors).toEqual([]);
  });
}
