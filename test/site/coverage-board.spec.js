'use strict';
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork } = require('./support/network.js');
const catalogue = require('../../site/config/esim.json');
const deployment = require('../../site/vercel.json');

const places = [...new Map(catalogue.packages.map((entry) => [entry.slug, entry])).values()];
const response = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const countryCode = (flag) => Array.from(flag).map((char) => String.fromCharCode(char.codePointAt(0) - 0x1f1e6 + 97)).join('');

async function openBoard(page) {
  const details = page.locator('#coverage');
  await expect(details).toBeAttached();
  if (!await details.evaluate((element) => element.open)) await details.locator('summary').click();
  await expect(page.locator('.ott-airport-board')).toBeVisible();
}

test('airport coverage board contains each configured place once and keyboard selection only changes the preview', async ({ page }) => {
  stubNetwork(page);
  const flagResponses = new Map();
  let atlasStatus = null;
  const writes = [];
  page.on('response', (res) => {
    if (res.url().includes('/assets/flags/')) flagResponses.set(new URL(res.url()).pathname, res.status());
    if (res.url().endsWith('/assets/ott/clay-alphabet.webp')) atlasStatus = res.status();
  });
  page.on('request', (req) => {
    if (req.method() !== 'GET' && new URL(req.url()).pathname.startsWith('/api/')) writes.push(req.url());
  });
  await page.goto('/index.html#/');
  expect(await page.evaluate(() => window.WhateverClayType.ready)).toBe(true);
  expect(atlasStatus).toBe(200);
  await expect(page.locator('html')).toHaveClass(/ott-clay-ready/);
  await expect(page.locator('#coverage summary')).toContainText('See where your data works');
  await expect(page.locator('#coverage summary span')).toHaveText(places.length + ' places');
  await openBoard(page);
  const board = page.locator('.ott-airport-board');
  await expect(board.locator('.cov-item')).toHaveCount(places.length);
  await expect(board.locator('.cov-name')).toHaveText(places.filter((item) => item.kind === 'country').sort((a, b) => a.name.localeCompare(b.name)).concat(places.filter((item) => item.kind === 'region').sort((a, b) => a.name.localeCompare(b.name))).map((item) => item.name));
  for (const kind of ['country', 'region']) {
    const group = board.locator('.ott-coverage-group').filter({ has: page.getByRole('heading', { name: kind === 'country' ? 'Countries' : 'Regions', exact: true }) });
    await expect(group.locator('.cov-item')).toHaveCount(places.filter((item) => item.kind === kind).length);
  }
  for (const place of places) {
    const button = board.getByRole('button', { name: place.name, exact: true });
    await expect(button).toHaveCount(1);
    await expect(button).toHaveAccessibleName(place.name);
    const decoration = button.locator('.cov-name .ott-clay-label');
    await expect(decoration).toBeVisible();
    await expect(decoration).toHaveAttribute('aria-hidden', 'true');
    await expect(decoration.locator('.ott-clay-glyph')).toHaveCount(place.name.replace(/\s/g, '').length);
    expect(await decoration.locator('.ott-clay-glyph').first().evaluate((glyph) => {
      const box = glyph.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(glyph).backgroundImage.includes('/assets/ott/clay-alphabet.webp');
    })).toBe(true);
    if (place.kind !== 'country') continue;
    await button.scrollIntoViewIfNeeded();
    const flag = button.locator('img.cov-flag');
    const pathname = '/assets/flags/' + countryCode(place.flag) + '.svg';
    await expect(flag).toHaveAttribute('src', '.' + pathname);
    await expect(flag).toHaveAttribute('alt', '');
    await expect.poll(() => flag.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(flagResponses.get(pathname)).toBe(200);
  }
  const germany = board.getByRole('button', { name: 'Germany', exact: true });
  await germany.focus();
  await expect(germany).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Germany');
  await expect(page.locator('#plan-place')).toHaveValue('germany');
  await expect(page.locator('.ott-plan-details')).not.toHaveAttribute('open', '');
  expect(writes).toEqual([]);
  expect(page.url()).not.toMatch(/#\/(data|status)$/);
});

test('failed clay alphabet leaves readable country names and working keyboard coverage selection', async ({ page }) => {
  stubNetwork(page);
  await page.route('**/assets/ott/clay-alphabet.webp', (route) => route.abort());
  await page.goto('/index.html#/');
  expect(await page.evaluate(() => window.WhateverClayType.ready)).toBe(false);
  await expect(page.locator('html')).not.toHaveClass(/ott-clay-ready/);
  await openBoard(page);
  const germany = page.locator('.ott-airport-board').getByRole('button', { name: 'Germany', exact: true });
  await expect(germany).toHaveCount(1);
  await expect(germany).toHaveAccessibleName('Germany');
  await expect(germany.locator('.ott-clay-readable')).toBeVisible();
  await expect(germany.locator('.ott-clay-readable')).toHaveText('Germany');
  await expect(germany.locator('.ott-clay-label')).toBeHidden();
  await germany.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Germany');
  await expect(page.locator('#plan-place')).toHaveValue('germany');
  await expect(page.locator('.ott-plan-details')).not.toHaveAttribute('open', '');
});

test('clay country names remain visible and selectable under the production Content Security Policy', async ({ page }) => {
  stubNetwork(page);
  const policy = deployment.headers.flatMap((entry) => entry.headers).find((header) => header.key === 'Content-Security-Policy').value;
  await page.addInitScript(() => {
    window.clayPolicyViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => window.clayPolicyViolations.push(event.violatedDirective));
  });
  await page.route('**/index.html', async (route) => {
    const result = await route.fetch();
    await route.fulfill({ response: result, headers: { ...result.headers(), 'content-security-policy': policy } });
  });
  await page.goto('/index.html#/');
  expect(await page.evaluate(() => window.WhateverClayType.ready)).toBe(true);
  await openBoard(page);
  const board = page.locator('.ott-airport-board');
  const dimensions = await board.locator('.ott-clay-glyph').evaluateAll((glyphs) => glyphs.map((glyph) => {
    const rect = glyph.getBoundingClientRect();
    const style = getComputedStyle(glyph);
    return { width: rect.width, height: rect.height, sized: style.backgroundSize !== 'auto' };
  }));
  expect(dimensions.length).toBeGreaterThan(100);
  expect(dimensions.every((glyph) => glyph.width > 0 && glyph.height > 0 && glyph.sized)).toBe(true);
  const germany = board.getByRole('button', { name: 'Germany', exact: true });
  await expect(germany.locator('.ott-clay-label')).toBeVisible();
  await germany.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Germany');
  expect(await page.evaluate(() => window.clayPolicyViolations)).toEqual([]);
});

test('airport board follows a restricted catalogue without inventing countries or packages', async ({ page }) => {
  stubNetwork(page);
  const restricted = Object.assign({}, catalogue, { packages: catalogue.packages.filter((entry) => ['germany', 'europe'].includes(entry.slug)) });
  await page.route('**/config/esim.json', (route) => route.fulfill(response(restricted)));
  await page.goto('/index.html#/');
  await openBoard(page);
  const board = page.locator('.ott-airport-board');
  await expect(page.locator('#coverage summary span')).toHaveText('2 places');
  await expect(board.getByRole('button')).toHaveCount(2);
  await expect(board.getByRole('button', { name: 'United States', exact: true })).toHaveCount(0);
  await expect(board.getByRole('button', { name: 'Japan', exact: true })).toHaveCount(0);
  await expect(board.locator('img.cov-flag')).toHaveCount(1);
  await board.getByRole('button', { name: 'Germany', exact: true }).click();
  await expect(page.locator('.ott-coverage-result h3')).toHaveText('Germany');
  await expect(page.locator('#plan-place')).toHaveValue('germany');
  await page.locator('.ott-plan-details summary').click();
  await expect(page.locator('.plan-card')).toHaveCount(restricted.packages.filter((entry) => entry.slug === 'germany').length);
});

test('phone and tablet airport boards keep full names, usable buttons and locally loaded typography', async ({ page }) => {
  const network = stubNetwork(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/index.html#/');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => window.WhateverClayType.ready)).toBe(true);
    await openBoard(page);
    await expect(page.locator('.ott-airport-scene')).toBeVisible();
    await expect(page.locator('.ott-airport-backdrop img')).toBeVisible();
    for (const place of places) {
      const button = page.locator('.ott-airport-board').getByRole('button', { name: place.name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();
      const dimensions = await button.evaluate((element) => {
        const name = element.querySelector('.cov-name');
        const style = getComputedStyle(name);
        const rect = element.getBoundingClientRect();
        return { height: rect.height, left: rect.left, right: rect.right, clipped: name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1, ellipsis: style.textOverflow === 'ellipsis' };
      });
      expect(dimensions.height).toBeGreaterThanOrEqual(44);
      expect(dimensions.left).toBeGreaterThanOrEqual(0);
      expect(dimensions.right).toBeLessThanOrEqual(width);
      expect(dimensions.clipped, place.name + ' should be fully readable at ' + width + 'px').toBe(false);
      expect(dimensions.ellipsis).toBe(false);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const type = await page.evaluate(() => ({
      displayLoaded: document.fonts.check('800 32px "Bricolage Grotesque"'),
      bodyLoaded: document.fonts.check('400 16px "Instrument Sans"'),
      displayFamily: getComputedStyle(document.querySelector('.ott-hero-title')).fontFamily,
      bodyFamily: getComputedStyle(document.body).fontFamily,
      fontUrls: performance.getEntriesByType('resource').filter((resource) => /\.woff2(?:\?|$)/.test(resource.name)).map((resource) => resource.name),
    }));
    expect(type.displayLoaded).toBe(true);
    expect(type.bodyLoaded).toBe(true);
    expect(type.displayFamily).toContain('Bricolage Grotesque');
    expect(type.bodyFamily).toContain('Instrument Sans');
    expect(type.fontUrls.some((url) => url.includes('BricolageGrotesque'))).toBe(true);
    expect(type.fontUrls.some((url) => url.includes('InstrumentSans'))).toBe(true);
    expect(type.fontUrls.every((url) => url.startsWith(new URL(page.url()).origin + '/fonts/'))).toBe(true);
  }
  expect(errors).toEqual([]);
  expect(network.blocked).toEqual([]);
});
