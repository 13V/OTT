'use strict';
const { test, expect } = require('@playwright/test');
const { stubNetwork } = require('./support/network');
test.use({ serviceWorkers: 'block' });

test('sample journey selects a plan without a wallet signature or a real order', async ({ page }) => {
  stubNetwork(page);
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/api/')) writes.push(request.url()); });
  await page.addInitScript(() => {
    window.walletCalls = [];
    window.ethereum = { request: async ({ method }) => { window.walletCalls.push(method); if (method === 'eth_accounts') return []; throw new Error('Preview must not request a wallet action'); } };
  });
  await page.goto('/#/app');
  const previewAction = page.getByRole('button', { name: 'Try the app preview', exact: true });
  await expect(previewAction).toHaveCount(1);
  await expect(page.locator('.om-home-actions').getByRole('button', { name: 'Try the app preview', exact: true })).toBeVisible();
  await previewAction.click();
  await expect(page.locator('.om-balance')).toHaveText('$15.00');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Plans', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose coverage. United States', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Package size' }).getByRole('button', { name: /^5 GB/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('Preview only.');
  await expect(sheet).toContainText('It does not issue an eSIM or request a wallet signature.');
  await sheet.getByRole('button', { name: 'Add to preview', exact: true }).click();
  await expect(page.locator('.om-sim-card')).toHaveCount(2);
  await expect(page.locator('.om-preview-banner')).toContainText('No real orders.');
  await expect(page.locator('.om-sim-list')).toContainText('United States');
  await expect(page.locator('.om-content')).toContainText('No usable QR codes');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveText('$7.01');
  await page.getByRole('button', { name: 'Exit preview', exact: true }).click();
  await expect(page.locator('.om-balance')).toHaveCount(0);
  expect(await page.evaluate(() => window.walletCalls)).toEqual(['eth_accounts']);
  expect(writes).toEqual([]);
});

test('coverage picker supports keyboard selection, no matches and prelaunch package review', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/#/app/plans');
  const coverage = page.getByRole('button', { name: /^Choose coverage\./ });
  await coverage.click();
  const picker = page.getByRole('dialog');
  const search = picker.getByLabel('Search a country or region', { exact: true });
  await expect(search).toBeFocused();
  await search.fill('Atlantis');
  await expect(picker.getByRole('status')).toContainText('No matching country or region');
  await expect(picker.locator('.om-coverage-option')).toHaveCount(0);
  // An empty search lets Escape dismiss the dialog rather than clearing the native search field.
  await search.fill('');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(coverage).toBeFocused();
  await expect(coverage).toHaveAccessibleName('Choose coverage. United States');
  await coverage.click();
  await search.fill('Japan');
  await expect(picker.locator('.om-coverage-option')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(picker.getByRole('button', { name: 'Japan', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(coverage).toHaveAccessibleName('Choose coverage. Japan');
  await expect(coverage).toBeFocused();
  const sizes = page.getByRole('group', { name: 'Package size' });
  await expect(sizes.getByRole('button')).toHaveCount(3);
  const packages = require('../../site/config/esim.json').packages.filter(pkg => pkg.slug === 'japan');
  for (const pkg of packages) {
    const option = sizes.getByRole('button', { name: new RegExp('^' + pkg.gb + ' GB,') });
    await expect(option).toContainText(pkg.gb + ' GB');
    await expect(option).toContainText(pkg.days + ' days');
    await expect(option).toContainText('$' + pkg.priceUsd.toFixed(2) + ' data credit');
  }
  await sizes.getByRole('button', { name: /^10 GB/ }).click();
  await expect(sizes.getByRole('button', { name: /^10 GB/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(sizes.getByRole('button', { name: /^5 GB/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('heading', { name: '10 GB', exact: true })).toBeVisible();
  const selected = packages.find(pkg => pkg.gb === 10);
  await expect(page.getByRole('article', { name: 'Japan selected package', exact: true })).toContainText(selected.days + ' days');
  await expect(page.getByRole('article', { name: 'Japan selected package', exact: true })).toContainText('$' + selected.priceUsd.toFixed(2));
  await expect(page.getByRole('button', { name: 'Review package', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('10 GB');
  await expect(page.getByRole('dialog')).toContainText('Japan');
  await expect(page.getByRole('dialog')).toContainText('Weekly credit and redemption are not available yet.');
  await expect(page.getByRole('button', { name: 'Add to preview', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to eSIMs', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review package', exact: true })).toBeFocused();
});

test('setup guide explains the OS handoff and supports iPhone and Android', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/#/app/help');
  await expect(page.getByRole('heading', { name: 'Set up your eSIM', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
  await expect(page.locator('.om-setup-guide')).toContainText('Get connected first');
  const steps = page.getByRole('group', { name: 'Setup steps', exact: true });
  for (const [index, label] of ['Prepare', 'Your eSIM', 'Add eSIM', 'Get online'].entries()) {
    await expect(steps.getByRole('button').nth(index)).toContainText(label);
  }
  await expect(page.locator('.om-setup-guide')).toContainText('Step 1 of 4');
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Step 2: Open your eSIM in OTT', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.om-setup-guide')).toContainText('Step 2 of 4');
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(page.locator('.om-setup-guide')).toContainText('iOS 17.4');
  await expect(page.locator('.om-content')).toContainText('Your phone confirms and completes setup.');
  await page.getByRole('button', { name: 'Android', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Step 1: Get connected first', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Step 3: Add the eSIM in Settings', exact: true }).click();
  await expect(page.locator('.om-setup-guide')).toContainText('Network & internet');
  await expect(page.locator('.om-setup-guide a')).toHaveAttribute('href', 'https://support.google.com/pixelphone/answer/16115470?hl=en');
  await expect(page.locator('.om-content a[href^="https://esimsetup"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(page.locator('.om-setup-guide')).toContainText('Step 4 of 4');
  await expect(page.locator('.om-setup-guide')).toContainText('turn Wi-Fi off and load a webpage');
  const browse = page.locator('.om-setup-guide').getByRole('link', { name: 'Browse plans', exact: true });
  await expect(browse).toHaveAttribute('href', '#/app/plans');
  await browse.click();
  await expect(page).toHaveURL(/#\/app\/plans$/);
});

test('sample status and exit stay visible before content on every app screen', async ({ page }) => {
  stubNetwork(page);
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/#/app');
    await page.getByRole('button', { name: 'Try the app preview', exact: true }).click();
    for (const screen of ['Home', 'Plans', 'eSIMs', 'Help']) {
      const destination = page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: screen, exact: true });
      await destination.click();
      await expect(destination).toHaveAttribute('aria-current', 'page');
      const banner = page.locator('.om-preview-banner');
      await expect(banner).toContainText('Sample credit and eSIMs. No real orders.');
      await page.evaluate(() => document.fonts.ready);
      const bannerBox = await banner.boundingBox();
      const contentBox = await page.locator('.om-content').boundingBox();
      expect(bannerBox).not.toBeNull();
      expect(contentBox).not.toBeNull();
      expect(bannerBox.y).toBeGreaterThanOrEqual(0);
      expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(Math.min(contentBox.y, 844));
      const exit = banner.getByRole('button', { name: 'Exit preview', exact: true });
      expect(await exit.evaluate(element => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return element === hit || element.contains(hit);
      })).toBe(true);
    }
    await page.getByRole('button', { name: 'Exit preview', exact: true }).click();
    await expect(page.locator('.om-preview-banner')).toHaveCount(0);
  }
});

test('phone eSIM screens put account actions before artwork in prelaunch and sample modes', async ({ page }) => {
  stubNetwork(page);
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/#/app/esims');
    for (const sample of [false, true]) {
      const account = page.locator('.om-kit-account');
      const artwork = page.locator('.om-world-kit');
      const primary = sample
        ? account.getByRole('link', { name: 'See setup guide', exact: true })
        : account.getByRole('button', { name: 'Explore a sample account', exact: true });
      await expect(primary).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const accountBox = await account.boundingBox();
      const artworkBox = await artwork.boundingBox();
      const primaryBox = await primary.boundingBox();
      const navBox = await page.getByRole('navigation', { name: 'App navigation' }).boundingBox();
      expect(accountBox.y).toBeLessThan(artworkBox.y);
      expect(primaryBox.y).toBeGreaterThanOrEqual(0);
      expect(primaryBox.y + primaryBox.height).toBeLessThanOrEqual(navBox.y);
      expect(await account.evaluate(element => !!(element.compareDocumentPosition(document.querySelector('.om-world-kit')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
      if (!sample) await primary.click();
    }
    await page.getByRole('button', { name: 'Exit preview', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Explore a sample account', exact: true })).toBeVisible();
  }
});

test('missing mobile wallet opens an honest handoff instead of pretending to connect', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/#/app');
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Mobile wallet connection has not been enabled on this deployment yet.');
  await expect(page.getByRole('button', { name: 'Copy app link', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBe(null);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeFocused();
});

test('declining a wallet connection leaves the app usable and a later connection never asks for a signature', async ({ page }) => {
  stubNetwork(page);
  const address = '0x4444444444444444444444444444444444444444';
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/api/')) writes.push(request.url()); });
  await page.addInitScript(address => {
    window.fixtureConnectionMethods = [];
    window.declineFixtureConnection = true;
    window.ethereum = { request: async ({ method }) => {
      window.fixtureConnectionMethods.push(method);
      if (method === 'eth_accounts') return [];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_requestAccounts') {
        if (window.declineFixtureConnection) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        return [address];
      }
      throw new Error('A prelaunch connection must not request a signature');
    } };
  }, address);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/#/app');
  const connect = page.getByRole('button', { name: 'Connect wallet', exact: true });
  await connect.click();
  await expect(page.locator('#toasts')).toContainText('Could not connect');
  await expect(page.locator('#toasts')).toContainText('User rejected the request.');
  await expect(connect).toBeEnabled();
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBeNull();
  await page.evaluate(() => { window.declineFixtureConnection = false; });
  await connect.click();
  await expect(page.getByRole('button', { name: 'Wallet settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.OTT_STATE.account)).toBe(address);
  expect(await page.evaluate(() => window.fixtureConnectionMethods)).toEqual(['eth_accounts', 'eth_requestAccounts', 'eth_requestAccounts', 'eth_chainId']);
  expect(writes).toEqual([]);
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Plans', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review package', exact: true })).toBeEnabled();
});

test('browser back dismisses package review and returns to the previous app screen', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/#/app');
  await page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Plans', exact: true }).click();
  await page.getByRole('button', { name: 'Review package', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.om-credit-card')).toBeVisible();
});

test('live account revocation hides codes and reconnecting requires a fresh read signature', async ({ page }) => {
  stubNetwork(page);
  const address = '0x4444444444444444444444444444444444444444';
  const cfg = { ...require('../../site/config/esim.json'), coin: '0x1111111111111111111111111111111111111111', curve: '0x2222222222222222222222222222222222222222', treasury: '0x3333333333333333333333333333333333333333' };
  const week = Math.floor((Date.now() / 1000 - 345600) / 604800);
  const order = { n: 0, week, transactionId: 'fixture-only', packageCode: 'fixed_5GB_30D_US', priceUsd: 7.99,
    iccid: 'fixture-not-an-iccid', createdAt: new Date().toISOString(), stage: 'done', pending: false,
    codes: false, ac: '', qrCodeUrl: '', smdpAddress: '', matchingId: '', appleInstallUrl: '', androidInstallUrl: '' };
  const signedOrder = { ...order, codes: true, ac: 'LPA:1$smdp.example$FIXTURE-ONLY', smdpAddress: 'smdp.example', matchingId: 'FIXTURE-ONLY' };
  const standing = { ok: true, address, week, weekEnd: 345600 + (week + 1) * 604800,
    tokens: '1234000000000000000000', share: 0.01, allowanceUsd: 20, decimals: 18,
    redeemedUsd: 7.99, remainingUsd: 12.01, stale: false, orders: [order], history: [], sims: [] };
  await page.route('**/config/esim.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(cfg) }));
  const writes = [];
  await page.route('**/api/redeem**', route => {
    const request = route.request();
    if (request.method() === 'POST') writes.push(request.postDataJSON());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(request.method() === 'GET' ? standing : { ...standing, orders: [signedOrder] }) });
  });
  await page.addInitScript(address => {
    window.walletListeners = {};
    window.readSignatures = 0;
    window.ethereum = {
      request: async ({ method }) => {
        if (method === 'eth_accounts') return [];
        if (method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'personal_sign') {
          window.readSignatures++;
          if (window.deferWalletSignature) return new Promise(resolve => { window.finishWalletSignature = () => resolve('0xfixture'); });
          return '0xfixture';
        }
        throw new Error('Unexpected wallet method: ' + method);
      }, on: (event, handler) => { window.walletListeners[event] = handler; },
    };
  }, address);
  await page.goto('/#/app/esims');
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('FIXTURE-ONLY');
  expect(await page.evaluate(() => window.readSignatures)).toBe(1);
  await page.evaluate(() => window.walletListeners.accountsChanged([]));
  await expect(page.locator('.data-ac')).toHaveCount(0);
  await expect(page.locator('.data-addr')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect(page.locator('.data-ac')).toContainText('FIXTURE-ONLY');
  expect(await page.evaluate(() => window.readSignatures)).toBe(2);
  expect(writes).toHaveLength(2);
  expect(writes.every(body => !body.packageCode)).toBe(true);
  // An account change while the wallet prompt is still open must prevent the signed POST.
  await page.evaluate(() => { window.walletListeners.accountsChanged([]); window.deferWalletSignature = true; });
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Show my eSIM codes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.finishWalletSignature)).toBe('function');
  await page.evaluate(() => { window.walletListeners.accountsChanged([]); window.finishWalletSignature(); });
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
  await expect(page.locator('.data-ac')).toHaveCount(0);
  expect(writes).toHaveLength(2);
});

test('leaving the app while installation is pending cannot open a stale dialog', async ({ page }) => {
  stubNetwork(page);
  await page.goto('/#/app');
  await expect(page.locator('.om-credit-card')).toBeVisible();
  await page.evaluate(() => {
    window.OTTPwa.install = () => new Promise(resolve => { window.finishInstallation = () => resolve({ outcome: 'manual' }); });
  });
  await page.getByRole('button', { name: 'Add to phone', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.finishInstallation)).toBe('function');
  await page.goto('/#/');
  await expect(page.locator('#view h1')).toHaveText('A memecoin with a data plan.');
  await page.evaluate(async () => { window.finishInstallation(); await Promise.resolve(); });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('app screens fit phones and desktop with reachable bottom navigation', async ({ page }) => {
  stubNetwork(page);
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const screen of ['', '/plans', '/esims', '/help']) {
      await page.goto('/#/app' + screen);
      await expect(page.locator('.om-status-pill')).not.toHaveText('Loading');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const controls = await page.locator('.om-nav a:not(.om-website-link)').evaluateAll(links => links.map(link => { const rect = link.getBoundingClientRect(); return { width: rect.width, height: rect.height, x: rect.x }; }));
      expect(controls.every(rect => rect.width >= 44 && rect.height >= 44 && rect.x >= 0)).toBe(true);
      await expect(page.locator('#masthead')).toBeHidden();
      await expect(page.locator('#site-footer')).toBeHidden();
    }
  }
});

test('Home and Plans put their primary action within the first phone screen', async ({ page }) => {
  stubNetwork(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/app');
  await expect(page.locator('.om-status-pill')).not.toHaveText('Loading');
  await page.evaluate(() => document.fonts.ready);
  const actionIsOnScreen = async control => {
    const box = await control.boundingBox();
    const nav = await page.getByRole('navigation', { name: 'App navigation' }).boundingBox();
    expect(box).not.toBeNull();
    expect(nav).not.toBeNull();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(nav.y);
  };
  const previewAction = page.getByRole('button', { name: 'Try the app preview', exact: true });
  await actionIsOnScreen(previewAction);
  await previewAction.click();
  await expect(page.locator('.om-balance')).toHaveText('$15.00');
  const homeAction = page.getByRole('button', { name: 'Find a data plan', exact: true });
  await actionIsOnScreen(homeAction);
  await homeAction.click();
  await expect(page.locator('.om-status-pill')).not.toHaveText('Loading');
  await actionIsOnScreen(page.getByRole('button', { name: 'Review package', exact: true }));
});

test('the last screen control clears fixed bottom navigation on small phones', async ({ page }) => {
  stubNetwork(page);
  for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const screen of ['', '/plans', '/esims', '/help']) {
      await page.goto('/#/app' + screen);
      await expect(page.locator('.om-status-pill')).not.toHaveText('Loading');
      await page.evaluate(() => document.fonts.ready);
      const lastControl = page.locator('.om-content').locator('a:visible, button:visible, summary:visible').last();
      await lastControl.focus();
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const control = await lastControl.boundingBox();
      const nav = await page.getByRole('navigation', { name: 'App navigation' }).boundingBox();
      expect(control).not.toBeNull();
      expect(nav).not.toBeNull();
      expect(control.y).toBeGreaterThanOrEqual(0);
      expect(control.y + control.height).toBeLessThanOrEqual(nav.y);
      expect(await lastControl.evaluate(element => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return element === hit || element.contains(hit);
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

test('desktop app fills wide viewports, keeps the home title on two lines, and exposes clickable header navigation', async ({ page }) => {
  stubNetwork(page);
  for (const width of [1440, 2549]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.goto('/#/app');
    await expect(page.locator('.om-status-pill')).not.toHaveText('Loading');
    await page.evaluate(() => document.fonts.ready);
    const shell = await page.locator('.om-shell').boundingBox();
    expect(shell.width).toBeGreaterThanOrEqual(width * 0.95);
    const textLines = await page.locator('.om-home-intro h1').evaluate(heading => {
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      const positions = new Set();
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) if (rect.height > 0) positions.add(Math.round(rect.top));
      }
      return positions.size;
    });
    expect(textLines).toBe(2);
    const hitTest = async link => {
      await page.evaluate(() => scrollTo(0, 0));
      expect(await link.evaluate(element => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return element === hit || element.contains(hit);
      })).toBe(true);
    };
    for (const [label, screen] of [['Plans', '/plans'], ['eSIMs', '/esims'], ['Help', '/help'], ['Home', '']]) {
      const link = page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: label, exact: true });
      await hitTest(link);
      await link.click();
      await expect(page).toHaveURL(new RegExp('#/app' + screen + '$'));
      await expect(link).toHaveAttribute('aria-current', 'page');
    }
    const website = page.getByRole('navigation', { name: 'App navigation' }).getByRole('link', { name: 'Visit the website ↗', exact: true });
    await hitTest(website);
    await website.click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('#masthead')).toBeVisible();
  }
});
