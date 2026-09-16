'use strict';
/**
 * Every route renders, and does so with the heading and title app.js promises it. The whole site
 * is one page with a hash router, so "the route rendered" means the view has the heading that
 * route owns — not merely that navigation happened. Modelled on whatever.fun's own
 * test/site/routes.spec.js, cut down to the three routes this site actually has.
 */
// package.json's devDependency is @playwright/test; a sandbox with no npm install instead has the
// base `playwright` package on NODE_PATH, whose `playwright/test` subpath is the same test runner.
// Trying the real package first means a normal `npm install` changes nothing about this file.
let pwTest;
try { pwTest = require('@playwright/test'); } catch (e) { pwTest = require('playwright/test'); }
const { test, expect } = pwTest;
const { stubNetwork } = require('./support/network.js');

const PAGES = [
  { hash: '#/', heading: 'Mobile data in 28 places, just for holding OTT.', title: 'OT+T — hold the coin, fly with data' },
  { hash: '#/status', heading: 'Everything, and whether it is running.', title: 'Status — OT+T' },
  { hash: '#/about', heading: 'How this works', title: 'How this works — OT+T' },
];

for (const page_ of PAGES) {
  test(`${page_.hash} renders without throwing`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
    stubNetwork(page);

    await page.goto('/index.html' + page_.hash);
    await expect(page.locator('#view h1')).toHaveText(page_.heading);
    await expect(page).toHaveTitle(page_.title);
    expect(errors).toEqual([]);
  });
}

test('an unknown hash falls back to home', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || e)));
  stubNetwork(page);

  await page.goto('/index.html#/nowhere');
  await expect(page.locator('#view h1')).toHaveText('Mobile data in 28 places, just for holding OTT.');
  await expect(page).toHaveTitle('OT+T — hold the coin, fly with data');
  await expect(page.locator('#nav a[data-route="home"]')).toHaveClass(/active/);
  expect(errors).toEqual([]);
});
