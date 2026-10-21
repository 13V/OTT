# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OT+T (ticker OTT) is a prelaunch programme that turns a memecoin's trading fees into mobile data. The coin launches on pump.fun on Solana, paired with SOL. pump.fun pays the coin's creator a fee on every trade (0.30% on the bonding curve; after graduation to PumpSwap, 0.95% falling to 0.05% as the market cap grows), and OT+T's treasury is that creator. Members spend credit on eSIM bundles that the backend buys over Bitcoin Lightning. Credit is in dollars, not gigabytes, and weekly credit expires at the end of the week.

Membership (decided 17 October 2026, moved to pump.fun the same day; `docs/membership.md` has the rules and the data contract):
- A wallet joins by burning about $5 of OTT (`burnUsd: 5`): a transfer into the incinerator's token account for the coin. The amount in OTT is set each week from the price. Joining includes one welcome eSIM: any 1 GB, 7-day plan up to $4.
- Each week, 80% of the creator fees collected the week before (`budgetBps: 8000`) is split among members by their holdings at the Monday snapshot, with no member above 3× the average.
- Non-members earn nothing, and the remaining 20% stays in the pool as a reserve.
- The settings live in the `membership` block of `site/config/esim.json`.

Nothing has launched. The four launch fields in `site/config/esim.json` (`coin`, `tokenProgram`, `treasury`, `membership.burnAccount`) are empty, and production redemption is off (`REDEMPTIONS_ENABLED=0`). README.md explains the economics and the reasons behind most design decisions.

Names you will meet:
- **wholesale** is the adapter for the Lightning-paid eSIM supplier (nadanada, `https://nadanada.me/api/v2`). Docs and test fakes call it `provider.example`.
- **The incinerator** is `1nc1nerator11111111111111111111111111111111`, Solana's burn address. Nobody holds its key, so tokens sent to its token account are gone.
- **whatever.fun** and the `window.Whatever*` globals are leftovers from the launchpad this code was extracted from.

## Commands

Use Node 22, as CI does. The site has no build step and the backend tests use no test framework.

```sh
npm ci
npm run lint                  # every .js parses, every config/data JSON parses, the two addresses.json copies match, the launch fields agree
npm test                      # offline backend suite: runs every test/*.test.js in sequence
node test/redeem.test.js      # one backend suite (most have an alias too, e.g. npm run test:redeem)
npm run test:site             # Playwright browser suite, served by test/site/support/server.js
npm run test:site -- routes.spec.js     # one spec file
npm run test:site -- -g "unknown hash"  # tests whose title matches
npm run serve                 # static site/ on http://127.0.0.1:4174 (no API)
npm run serve:api             # /api/redeem and /api/status on http://127.0.0.1:3000; a non-loopback HOST forces production mode
npm run check:prelaunch -- --remote   # read-only checks against the deployed backend
npm run launch:config -- <mint>       # launch day: read the new coin and print the four launch fields (--write saves them)
npm run claim -- --rehearse <mint>    # simulate the fee collection for any live pump.fun coin, unsigned; sends nothing
```

CI (`.github/workflows/verify.yml`) runs three jobs:
- lint and `npm test`;
- the browser suite with `--workers=2`;
- on Windows, `npm run test:operator-credentials` and `npm run test:operator-phone`.

**Backend tests** are standalone scripts with a small `check()` helper. They print `ok`/`FAIL` lines and exit non-zero on failure; there is no filter for a single case, so run the whole file. Each file sets up its adapters through `process.env` at the top (`ESIM_PROVIDER`, `LN_PAYER=mock`, `STORE=memory`, `WHOLESALE_ALLOW_MEMORY_STORE=1`, …), which is why every suite runs in its own process. Add a new test file to the `test` script chain in package.json, and give it its own `test:<name>` script. Real mainnet transactions and pump.fun accounts for offline tests are in `test/fixtures/solana/`.

**Browser specs** call `stubNetwork(page)` from `test/site/support/network.js`. It answers the Solana JSON-RPC calls the site makes locally and aborts any other off-origin request. `installWallet(page)` from `test/site/support/wallet.js` registers a fake Wallet Standard wallet: it signs messages with a real ed25519 key held in Node (so a spec can verify a signature as the API would) and records transactions instead of sending them. `test/site/support/solana.js` has the fixture coin, treasury and incinerator account, and a decoder for the wire transactions. Specs that touch the API stub it with `page.route`. `test/site/membership.spec.js` is the reference for the Solana fixture shapes.

**Claude Code cloud sandbox:** the preinstalled Chromium (141) doesn't match the lockfile's Playwright 1.63 (Chromium 153), and `playwright install` should not be run there. Point the config at the local binary:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npm run test:site
```

With that browser, one test fails: `mobile-app.spec.js` "the last screen control clears fixed bottom navigation on small phones". It measures right after `scrollTo()`, while the page root has `scroll-behavior: smooth`, so the scroll hasn't happened yet. It passes in CI. Several Playwright runs at once need different `PORT` values, because each starts its own test server.

### Commands with real-world effects

Don't run these unless asked:
- `npm run claim` or `npm run fund` without `--dry-run` signs and sends Solana transactions with `TREASURY_PRIVATE_KEY` (falling back to `PRIVATE_KEY`). `claim --rehearse` and `claim --dry-run` only simulate.
- `node scripts/test-esim.js --purchase` makes a paid operator purchase.
- `npm run deploy:pages` pushes the committed `site/` to the public `gh-pages` branch (the keeper workflows also do this after every run).
- `npm run catalogue -- --write` rewrites the reviewed catalogue. The deployed backend's catalogue fingerprint must match the frontend's.
- `npm run launch:config -- <mint> --write` fills in the launch fields, which turns the programme on once deployed.

`npm run allowances` and `npm run treasury` only rewrite the local `site/data/*.json`; they never move funds.

## Architecture

Three parts share the repo:

1. **Static front end: `site/`.** Plain files, with no framework or bundler. GitHub Pages serves it at https://13v.github.io/OTT/, published from the committed tree by `npm run deploy:pages`, which the data and claim workflows also run at the end of every run (the site reads `data/*.json` from Pages, so Pages follows `main`). Pages serves it under `/OTT/`, so URLs inside `site/` stay relative.
2. **API: `site/api/*.js`.** These are Vercel functions. The Vercel project's Root Directory is `site`, and every push to `main` deploys production. `scripts/serve-api.js` runs the same handlers as a plain Node server, which `render.yaml` uses. The front end calls the API at `apiBaseUrl` from `site/config/app.json`.
3. **Keepers: `scripts/`.** Scheduled workflows run them and commit the regenerated `site/data/*.json` to `main`:
   - `data.yml`, every 30 minutes: `allowances.js` and `treasury.js`, plus alerts opened as GitHub issues when the pool is low, the site is unhealthy or a keeper fails.
   - `claim.yml`, daily at 06:17 UTC, and started by `data.yml` whenever it publishes a new week (a Monday 00:35 schedule backs that up): `claim.js` collects the creator fees from pump.fun into the treasury (`pump-fees.js` builds the instructions), `fund.js` turns treasury SOL into sats in the Lightning wallet (FixedFloat SOL → BTC Lightning, paying a Blink invoice), then `treasury.js` runs.
   - Both read Solana through `SOLANA_RPC_URL` when it is set, then the public endpoints in `config/addresses.json`. `scripts/solana-chain.js` is their shared toolkit (paced RPC, history, balances at a moment, pump.fun accounts and price, SOL's price, keys and sending).

`site/solana.js` is a dependency-free UMD module (base58, program and token-account addresses, token and compute-budget instructions, legacy transaction messages, reading transactions, a rotating JSON-RPC client). The browser loads it as `window.OTTSolana`; the API and the scripts `require()` it.

### Data flow

`scripts/allowances.js` builds the weekly ledger:
- **The join amount.** At its first run in a week it prices OTT from the bonding curve (or the PumpSwap pool after graduation) and SOL's price, and sets `burnTokens` = `burnUsd` of OTT rounded up to two significant figures, capped at 2% of the supply (`burnTokensFor()`). Every week's amount is kept in `membership.requirements`, carried from file to file.
- **Members.** It reads the incinerator account's (`membership.burnAccount`) transaction history. A join is a successful transaction in which that account gained OTT and exactly one ordinary wallet's accounts lost it (`joinFromTransaction()`); the treasury is never a member. A wallet's joins add up, and it becomes a member once they reach the amount for the week of the send (with a short grace window at the week boundary). `members` runs to the chain head, so wallets that joined after the snapshot get their welcome eSIM; only members at the snapshot share this week.
- **Holdings.** Each member's OTT at the week's start (Monday 00:00 UTC) comes from each of its token accounts' history, not from a live balance.
- **The budget.** `budgetBps` of the dollar value of creator fees collected into the treasury during the previous week, each collection valued at SOL's price in its hour.
- **The split.** `cappedShares()` from `site/api/_lib/membership.js`.
- It writes `site/data/allowances.json`, stamped with its `week`.

`/api/redeem` fetches that file over HTTP (`ALLOWANCES_URL`), never from a bundled copy. If the file's `week` isn't the current week, or it is about another coin, every wallet's spendable credit counts as zero. `site/config/esim.json` (coin, terms and the package catalogue) is bundled into the functions through `includeFiles` in `site/vercel.json`.

### Redemption (`site/api/redeem.js`)

- `GET ?address=` returns a wallet's public standing, without activation codes. A Solana address is case-sensitive base58 and is used exactly as sent. A signed `POST` either returns the codes (a read) or places an order (`packageCode` plus slot `n`).
- Sign-in is a per-request ed25519 signature (the wallet's `signMessage`) over a labelled plain-text message, base58-encoded, valid for 10 minutes. The message names the action, and for a redemption also the plan and slot, so one signature authorises one order. The client builds this message in `site/esim.js` and `checkMessage()` validates it, so change both together.
- **There is no wallet database.** A wallet's nth order in week w has the id `transactionIdFor(address, w, n)`, which is `'ott-' + keccak(address.toLowerCase():w:n)`. Standing is found by calling `provider.find()` for n = 0, 1, … until one is missing. Changing that formula, or the week constants in `_lib/week.js`, loses every past order.
- Re-sending a filled slot with the same package returns the existing order. A slot that doesn't match the ledger gets a 409.
- The standing includes a `membership` object (this week's `requirement`, `member`, `memberSince`, `sharing`, `welcomeOrder`), whose `enrolment.open` says whether the app may offer the burn right now.
- A welcome claim is `POST { welcome: true, packageCode, joinTx? }`, signed with the `OT+T — claim my welcome eSIM` message. It uses its own fixed id, `welcomeIdFor(address)` (`keccak(address.toLowerCase():welcome:0)`), so it never uses weekly credit.
- Membership is proven by the ledger's `members`. For a burn newer than the ledger, `_lib/rpc.js` reads `joinTx` from the chain and the API applies the ledger's own rule to it.

### Adapters

Environment variables choose the adapters, and production fails closed:
- **Provider** (`ESIM_PROVIDER`, in `site/api/_lib/providers/`): `mock` (the default; refused in production), `wholesale` (what production uses), or `esimaccess` (an alternative reseller).
- **Lightning payer** (`LN_PAYER`, in `site/api/_lib/payers/`): `blink` (default) or `mock`.
- **Store** (`site/api/_lib/store.js`): Upstash Redis over REST (`KV_REST_API_URL` / `KV_REST_API_TOKEN`, keys prefixed by `STORE_PREFIX`, default `wf:`), or `STORE=memory`. Atomic compare-and-set and compare-and-delete run as Lua `EVAL` scripts.
- **Chain** (`site/api/_lib/rpc.js`): `SOLANA_RPC_URL` first, then the `rpcs` in `config/addresses.json`.
- **Production** means `NODE_ENV=production` or `VERCEL_ENV=production`. It refuses the mock provider, the mock payer and the memory store, and requires a configured sign-in host (`SIGNIN_HOST` for the Pages frontend). New orders also need `REDEMPTIONS_ENABLED` set to exactly `1`; outside production it defaults to on. On Vercel, a `preview` or `development` deployment never places orders, because each deployment records orders under its own `STORE_PREFIX`.
- **Limits:** a signed request is checked exactly against the message format `site/esim.js` builds, small-order ed25519 keys are refused, signed requests have per-instance and per-wallet ceilings (429), and `_lib/rpc.js` remembers missing join transactions briefly and caps chain lookups per instance (503, which the app retries).

`providers/wholesale.js` keeps one Redis record per transaction id:
- The record moves `claiming → invoiced → paid → done`. It is claimed with SET NX and paid under a lease, so a crash resumes the order instead of paying twice.
- Before paying, it decodes the bolt11 invoice (`_lib/bolt11.js`) and checks the payment hash and the amount against Blink's BTC price.
- An unpaid invoice doesn't count as a redemption (`find()` returns null), so an outage never uses up a holder's credit.
- A holder gets one eSIM profile per place. Later bundles for the same place top up that profile's ICCID (`simFor()`).

### Front end

- `site/index.html` is the only page. Every script is an IIFE that exposes one `window.*` global, loaded in a fixed order.
- `site/app.js` is the hash router:
  - `#/` → `home.js`
  - `#/data` → `esim.js` (holder dashboard, redeem flow and the burn that joins)
  - `#/status` → `status.js`
  - `#/holders` → `holders.js`
  - `#/about` → drawn by `app.js` itself
  - `#/app/{home,plans,esims,help}` → `mobile-app.js` (the installable PWA)
- The router hands each route module a `ctx` object: the `h()` DOM helper, Solana RPC calls that rotate over the `browserRpcs` endpoints in `config/addresses.json` (PublicNode: mainnet-beta refuses browser origins), wallet `connect`, Solscan and pump.fun links, and `isCurrent()` for dropping stale async renders.
- `site/wallet.js` connects Solana wallets through the Wallet Standard (`wallet-standard:app-ready` / `register-wallet`), with Phantom's injected provider as a fallback, and asks which wallet to use when several are installed. It remembers only the wallet's name, so a reload reconnects silently.
- `site/client-config.js` only allows API calls to `./api/{redeem,status}` at the configured origin.

## Rules that span several files

- **Nothing under `site/` may require a file outside `site/`**, because Vercel deploys only that directory. Scripts may import from `site/` (`site/solana.js`, `site/api/_lib/`), but not the other way round. That is why these duplicates exist:
  - `site/api/_lib/keccak.js` is a verbatim copy of `scripts/keccak.js`. Re-copy rather than editing one side.
  - `config/addresses.json` must be byte-identical to `site/config/addresses.json`; lint fails otherwise.
  - `site/esim.js` carries its own browser copy of the week arithmetic in `site/api/_lib/week.js` (weeks run Monday 00:00 UTC to Monday). `test/week.test.js` loads `esim.js` under Node with only a bare `window` global and checks the copies agree, so keep `esim.js` free of DOM access at load time.
- **The membership rules live in `site/api/_lib/membership.js`.** The indexer, the API and `scripts/fund.js` (which keeps a 25-welcome reserve) all use it. The browser can't load it, so `site/esim.js` has its own `welcomeEligible()`, `joinFromTransaction()` and `joinTransaction()`, and builds the messages that `checkMessage()` validates. `test/membership-client.test.js` loads `esim.js` under Node and fails if they drift; it also decodes the join transaction with `@solana/kit` and compares it with `@solana-program/token`'s instructions. Before any burn, `publishedJoinMismatch()` checks the API's coin, token program, incinerator account (re-derived in the browser) and amount (at most 2% of the supply, at the coin's real decimals) against the static `config/esim.json`; keep that check whenever the join flow changes.
- **`site/data/*.json` files are generated** by the keepers; don't hand-edit them. When a workflow's push hits a rebase conflict in those files, it keeps its own output.
- **Versioned assets must match the service worker.** `site/index.html` loads some files with a `?v=<tag>` query, and the same URL strings must appear in the `SHELL` list in `site/sw.js`, because the worker only caches query URLs listed there. Bump `CACHE_NAME` when the shell changes, so returning PWA visitors get the new files. `test/site/pwa.spec.js` hard-codes which files carry a tag. The worker must never cache config, ledgers, `/api/*` or activation data.
- **Secrets and activation codes:**
  - Error text leaving the API passes through `_lib/redact.js`.
  - Installation details (QR, activation code, SM-DP+ address, install links) appear only in signed responses, and only for the eSIM profile that signature covers.
- **Launch order:** the coin is created on pump.fun from the treasury wallet (SOL pair; Holder Rewards, Cashback, Mayhem mode and fee sharing off). Then `npm run launch:config -- <mint> --write` fills in all four launch fields together; lint refuses a partial set or a `burnAccount` that isn't the incinerator's account for that coin. `treasury` must be the wallet whose key is `TREASURY_PRIVATE_KEY`. See README, "To turn it on".

## Operator tooling

`test-esim.js`, `esim-install-pack.js`, `operator-test-*.js`, `phone-test-storage-check.js`, `solana-wallet-test.js`, `solana-test-*.js` and the `.ps1` files in `scripts/` support a private, funded phone test (`solana-chain.js` is not part of it; the keepers use it). The runbooks are `docs/phone-test-quickstart.md`, `docs/operator-phone-test.md` and `docs/solana-test-wallet.md`.
- On the operator's Windows PC, `npm run phone:setup` stores credentials encrypted with DPAPI through PowerShell, and the `--local-credentials` commands unlock them.
- In a Claude Code cloud environment, the same three values (`BLINK_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`) come from environment secrets. Use `npm run phone:storage-check:env` and `npm run phone:preflight:env`, and run the paid `--purchase` command without `--local-credentials`, only after the operator explicitly approves it. See "Running from a Claude Code cloud environment" in `docs/phone-test-quickstart.md`.
- Private files must live outside the repo, under `~/.codex/private/ott-phone-test`.

`docs/backend-deployment.md` covers hosting and environment settings.
