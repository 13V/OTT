# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OT+T (ticker OTT) is a prelaunch programme that turns a memecoin's trading tax into mobile data. The coin is planned on Pons on Robinhood Chain (chain id 4663) with a 10% creator tax. Each week, the previous week's tax (USDG) becomes a dollar budget, split among holders by their share of the circulating supply. Holders spend it on eSIM bundles that the backend buys over Bitcoin Lightning. Credit is in dollars, not gigabytes, and expires at the end of the week.

Nothing has launched. `coin`, `curve` and `treasury` in `site/config/esim.json` are empty, and production redemption is off (`REDEMPTIONS_ENABLED=0`). README.md explains the economics and the reasons behind most design decisions.

Names you will meet:
- **wholesale** is the adapter for the Lightning-paid eSIM supplier (nadanada, `https://nadanada.me/api/v2`). Docs and test fakes call it `provider.example`.
- **whatever.fun** and the `window.Whatever*` globals are leftovers from the launchpad this code was extracted from.

## Commands

Use Node 22, as CI does. The site has no build step and the backend tests use no test framework.

```sh
npm ci
npm run lint                  # every .js parses, every config/data JSON parses, the two addresses.json copies match
npm test                      # offline backend suite: runs every test/*.test.js in sequence
node test/redeem.test.js      # one backend suite (most have an alias too, e.g. npm run test:redeem)
npm run test:site             # Playwright browser suite, served by test/site/support/server.js
npm run test:site -- routes.spec.js     # one spec file
npm run test:site -- -g "unknown hash"  # tests whose title matches
npm run serve                 # static site/ on http://127.0.0.1:4174 (no API)
npm run serve:api             # /api/redeem, /api/status, /api/auth on http://127.0.0.1:3000; a non-loopback HOST forces production mode
npm run build:wallet          # rebuild the committed site/vendor/walletconnect.js from scripts/wallet-sdk-entry.mjs
npm run check:prelaunch -- --remote   # read-only checks against the deployed backend
```

CI (`.github/workflows/verify.yml`) runs three jobs:
- lint and `npm test`;
- the browser suite with `--workers=2`;
- on Windows, `npm run test:operator-credentials` and `npm run test:operator-phone`.

**Backend tests** are standalone scripts with a small `check()` helper. They print `ok`/`FAIL` lines and exit non-zero on failure; there is no filter for a single case, so run the whole file. Each file sets up its adapters through `process.env` at the top (`ESIM_PROVIDER`, `LN_PAYER=mock`, `STORE=memory`, `WHOLESALE_ALLOW_MEMORY_STORE=1`, …), which is why every suite runs in its own process. Add a new test file to the `test` script chain in package.json, and give it its own `test:<name>` script.

**Browser specs** call `stubNetwork(page)` from `test/site/support/network.js`. It answers chain RPC locally and aborts any other off-origin request. Specs that touch the API stub it with `page.route`.

**Claude Code cloud sandbox:** the preinstalled Chromium (141) doesn't match the lockfile's Playwright 1.63 (Chromium 153), and `playwright install` should not be run there. Point the config at the local binary:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npm run test:site
```

With that browser, one test fails: `mobile-app.spec.js` "the last screen control clears fixed bottom navigation on small phones". It measures right after `scrollTo()`, while the page root has `scroll-behavior: smooth`, so the scroll hasn't happened yet. It passes in CI.

### Commands with real-world effects

Don't run these unless asked:
- `npm run claim` or `npm run fund` without `--dry-run` signs and sends transactions with `PRIVATE_KEY`.
- `node scripts/test-esim.js --purchase` makes a paid operator purchase.
- `npm run deploy:pages` pushes the committed `site/` to the public `gh-pages` branch.
- `npm run catalogue -- --write` rewrites the reviewed catalogue. The deployed backend's catalogue fingerprint must match the frontend's.

`npm run allowances` and `npm run treasury` only rewrite the local `site/data/*.json`; they never move funds.

## Architecture

Three parts share the repo:

1. **Static front end: `site/`.** Plain files, with no framework or bundler. GitHub Pages serves it at https://13v.github.io/OTT/, and it is published only by `npm run deploy:pages`. Pages serves it under `/OTT/`, so URLs inside `site/` stay relative.
2. **API: `site/api/*.js`.** These are Vercel functions. The Vercel project's Root Directory is `site`, and every push to `main` deploys production. `scripts/serve-api.js` runs the same handlers as a plain Node server, which `render.yaml` uses. The front end calls the API at `apiBaseUrl` from `site/config/app.json`.
3. **Keepers: `scripts/`.** Scheduled workflows run them and commit the regenerated `site/data/*.json` to `main`:
   - `data.yml`, every 30 minutes: `allowances.js` and `treasury.js`, plus alerts opened as GitHub issues when the pool is low, the site is unhealthy or a keeper fails.
   - `claim.yml`, daily: `claim.js` sweeps the fee escrow, `fund.js` moves USDG to the Lightning wallet (Across → FixedFloat → Blink), then `treasury.js` runs.

### Data flow

`scripts/allowances.js` builds the weekly ledger:
- It works out balances at the week's first block by folding the coin's `Transfer` logs. It deliberately avoids archive `eth_call`, which this chain's public RPCs can't be relied on to answer.
- It sums the USDG that the curve paid into the fee escrow during the previous week; that is the budget.
- It writes `site/data/allowances.json`, stamped with its `week`.

`/api/redeem` fetches that file over HTTP (`ALLOWANCES_URL`), never from a bundled copy. If the file's `week` isn't the current week, every wallet's spendable credit counts as zero. `site/config/esim.json` (coin, terms and the package catalogue) is bundled into the functions through `includeFiles` in `site/vercel.json`.

### Redemption (`site/api/redeem.js`)

- `GET ?address=` returns a wallet's public standing, without activation codes. A signed `POST` either returns the codes (a read) or places an order (`packageCode` plus slot `n`).
- EVM sign-in is a per-request EIP-191 `personal_sign` over a labelled message, valid for 10 minutes. The message names the action, and for a redemption also the plan and slot, so one signature authorises one order. The client builds this message in `site/esim.js` and `checkMessage()` validates it, so change both together.
- **There is no wallet database.** A wallet's nth order in week w has the id `transactionIdFor(address, w, n)`, which is `'ott-' + keccak(address:w:n)`. Standing is found by calling `provider.find()` for n = 0, 1, … until one is missing. Changing that formula, or the week constants in `_lib/week.js`, loses every past order.
- Re-sending a filled slot with the same package returns the existing order. A slot that doesn't match the ledger gets a 409.

### Adapters

Environment variables choose the adapters, and production fails closed:
- **Provider** (`ESIM_PROVIDER`, in `site/api/_lib/providers/`): `mock` (the default; refused in production), `wholesale` (what production uses), or `esimaccess` (an alternative reseller).
- **Lightning payer** (`LN_PAYER`, in `site/api/_lib/payers/`): `blink` (default) or `mock`.
- **Store** (`site/api/_lib/store.js`): Upstash Redis over REST (`KV_REST_API_URL` / `KV_REST_API_TOKEN`, keys prefixed by `STORE_PREFIX`, default `wf:`), or `STORE=memory`. Atomic compare-and-set and compare-and-delete run as Lua `EVAL` scripts.
- **Production** means `NODE_ENV=production` or `VERCEL_ENV=production`. It refuses the mock provider, the mock payer and the memory store, and requires a configured sign-in host (`SIGNIN_HOST` for the Pages frontend). New orders also need `REDEMPTIONS_ENABLED` set to exactly `1`; outside production it defaults to on.

`providers/wholesale.js` keeps one Redis record per transaction id:
- The record moves `claiming → invoiced → paid → done`. It is claimed with SET NX and paid under a lease, so a crash resumes the order instead of paying twice.
- Before paying, it decodes the bolt11 invoice (`_lib/bolt11.js`) and checks the payment hash and the amount against Blink's BTC price.
- An unpaid invoice doesn't count as a redemption (`find()` returns null), so an outage never uses up a holder's credit.
- A holder gets one eSIM profile per place. Later bundles for the same place top up that profile's ICCID (`simFor()`).

### Solana sign-in (`site/api/auth.js`)

This is Phantom sign-in-with-Solana (SIWS). The API issues single-use challenges and 30-minute sessions, both stored in the Redis store. `_lib/wallet-links.js` links a Solana identity to one Robinhood Chain wallet. Solana accounts have no holder credit; credit and redemption are EVM-only.

### Front end

- `site/index.html` is the only page. Every script is an IIFE that exposes one `window.*` global, loaded in a fixed order.
- `site/app.js` is the hash router:
  - `#/` → `home.js`
  - `#/data` → `esim.js` (holder dashboard and redeem flow)
  - `#/status` → `status.js`
  - `#/holders` → `holders.js`
  - `#/about` → drawn by `app.js` itself
  - `#/app/{home,plans,esims,help}` → `mobile-app.js` (the installable PWA)
- The router hands each route module a `ctx` object: the `h()` DOM helper, RPC calls that rotate over the `rpcs` endpoints in `config/addresses.json`, wallet `connect`, and `isCurrent()` for dropping stale async renders.
- `site/client-config.js` only allows API calls to `./api/{redeem,status,auth}` at the configured origin.

## Rules that span several files

- **Nothing under `site/` may require a file outside `site/`**, because Vercel deploys only that directory. Scripts may import from `site/api/_lib/`, but not the other way round. That is why these duplicates exist:
  - `site/api/_lib/keccak.js` and `secp256k1.js` are verbatim copies of the files in `scripts/`. Re-copy rather than editing one side.
  - `config/addresses.json` must be byte-identical to `site/config/addresses.json`; lint fails otherwise.
  - `site/esim.js` carries its own browser copy of the week arithmetic in `site/api/_lib/week.js` (weeks run Monday 00:00 UTC to Monday). `test/week.test.js` loads `esim.js` under Node with only a bare `window` global and checks the copies agree, so keep `esim.js` free of DOM access at load time.
- **`site/data/*.json` files are generated** by the keepers; don't hand-edit them. When a workflow's push hits a rebase conflict in those files, it keeps its own output.
- **Versioned assets must match the service worker.** `site/index.html` loads some files with a `?v=<tag>` query, and the same URL strings must appear in the `SHELL` list in `site/sw.js`, because the worker only caches query URLs listed there. Bump `CACHE_NAME` when the shell changes, so returning PWA visitors get the new files. `test/site/pwa.spec.js` hard-codes which files carry a tag. The worker must never cache config, ledgers, `/api/*` or activation data.
- **Secrets and activation codes:**
  - Error text leaving the API passes through `_lib/redact.js`.
  - Installation details (QR, activation code, SM-DP+ address, install links) appear only in signed responses, and only for the eSIM profile that signature covers.
- **Launch order:** fill in `coin` and `curve` in `site/config/esim.json` together. `treasury` must be the wallet whose key is `TREASURY_PRIVATE_KEY`. See README, "To turn it on".

## Operator tooling

`test-esim.js`, `esim-install-pack.js`, `operator-test-*.js`, `phone-test-storage-check.js`, `solana-*.js` and the `.ps1` files in `scripts/` support a private, funded phone test. The runbooks are `docs/phone-test-quickstart.md`, `docs/operator-phone-test.md` and `docs/solana-test-wallet.md`.
- On the operator's Windows PC, `npm run phone:setup` stores credentials encrypted with DPAPI through PowerShell, and the `--local-credentials` commands unlock them.
- In a Claude Code cloud environment, the same three values (`BLINK_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`) come from environment secrets. Use `npm run phone:storage-check:env` and `npm run phone:preflight:env`, and run the paid `--purchase` command without `--local-credentials`, only after the operator explicitly approves it. See "Running from a Claude Code cloud environment" in `docs/phone-test-quickstart.md`.
- Private files must live outside the repo, under `~/.codex/private/ott-phone-test`.

`docs/backend-deployment.md` covers hosting and environment settings.
