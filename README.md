# OT+T

OT+T — Onchain Telephone + Telegraph, ticker OTT — is a phone carrier whose network is a bonding
curve. One coin, launched on Pons on Robinhood Chain (chain id 4663) with a 10% creator tax. **Holding
the coin is the plan**: the tax the coin collected last week becomes this week's data budget, and a
wallet's allowance is its share of the circulating supply times that budget — in dollars of
mobile-data credit, spent on eSIMs from nadanada: 28 places at 1, 5 or 10 GB, 84 packages in all.
Connect a wallet, sign a message, pick a place, scan the QR at the airport.

The allowance expires at the end of the week. That is not meanness, it is what makes the promise
affordable: the pool never owes more than one week of tax it has already collected, so there is no
accruing claim on a treasury funded by a tax that may stop.

The name is built the way AT&T's was: a formal corporate name, Onchain Telephone + Telegraph, worn
down to the initialism people actually say — the same way American Telephone and Telegraph wore
down to three letters, so the ticker is OTT. The plus is deliberate: it stands in for the ampersand
a ticker has no room for.

## How a trade becomes data

Pons takes the coin's creator tax — 10% — on every buy and sell against its bonding curve, and holds
it in a fee escrow until somebody claims it. `scripts/claim.js` does that once a day
(`.github/workflows/claim.yml`), sweeping the escrow into a treasury wallet that holds nothing else.
That is what makes it safe to keep the treasury's key as a repository secret: the daily sweep is also
what keeps the escrow from ever holding more than a day's tax.

Straight after, `scripts/fund.js` moves what just landed into the wallet nadanada is actually paid
from, over three hops, each with an API: a Blink invoice for the sats to receive; a FixedFloat
fixed-rate order, USDC (Base) → BTC (Lightning), that pays it; and an Across deposit of the
treasury's USDG on Robinhood Chain, filled as exactly that USDC on Base and delivered straight to
FixedFloat's address — no wallet on Base, no gas spent there. Every quote is checked against Blink's
own BTC price before anything moves, and the deposit is simulated before it is sent.

Meanwhile `scripts/allowances.js` re-derives the week's plan. It sums the coin's own `Transfer`
logs to fold every wallet's balance as of the week's first block — a log sum rather than an archive
`eth_call`, because this chain's public endpoints cannot be relied on to answer a historical block
tag, and folding transfers is exact on any endpoint that can serve `eth_getLogs`. The circulating
supply excludes the curve, the fee escrow, the factory, the hook and the treasury: the curve holds
all the unsold supply before graduation, so counting it would hand most of every week's budget to a
contract. The budget itself is the USDG the curve paid into the fee escrow during the previous
week. Nothing is stored on top of chain data; `site/data/allowances.json` is rebuilt from logs on
every run.

Taking the snapshot at the week boundary rather than at the moment of redemption is deliberate: an
allowance computed from a live balance can be taken by borrowing a large position, redeeming the
biggest share, and returning it in the same block. `scripts/treasury.js` reads what the sweep and the top-up left behind — the
Lightning wallet's balance, the last 30 days of what redemptions actually cost, the runway they
imply — into `site/data/treasury.json`, which is where the pool's status (funded, low, empty,
unknown) comes from.

A holder spends the week's allowance at `/api/redeem`: sign in with a wallet signature, pick a
nadanada package, and it places the order — invoice, payment and completion, all against the
Lightning wallet `fund.js` keeps stocked — and hands back the ICCID, the QR and the install links
nadanada returns.

## Why dollars, and not gigabytes

A gigabyte is not one thing. nadanada's own packages price it from $0.70 to $8.99 per GB depending
on size and place — ten gigabytes for a month in France is $6.99, one gigabyte for a week worldwide
is $8.99 — and an allowance denominated in gigabytes would let a wallet claim the cheap kind and
spend the dear kind. Dollars keep it honest: a share of the budget is a share of the budget, and
what it buys is whatever the holder actually picks.

## What the allowance is, and what it is not

It is a weekly usage allowance, funded by the coin's own tax, spendable only on mobile data, and it
expires. It is not a dividend: nothing is paid out in money, nothing accrues, and holding the coin
is not a claim on the treasury. That distinction is the whole reason the allowance expires weekly
and is denominated in data rather than dollars paid out — a pool of other people's fees paid to
whoever holds, in cash and without limit, is a shape worth not having on a chain run by a US
broker. The coin is the subscription; what it entitles you to is a share of one week of data, and
if you do not use it, it is gone.

## What is verified, and what is guaranteed

`nadanada.me/api/v2` (OpenAPI at `/api/v2/openapi.json`) was read directly, not assumed, on 15
September 2026: `POST /esim/purchase {bundleName, slug, paymentMethod: "lightning"}` answers a
bolt11 invoice, a payment hash and a price 5% under list for paying in sats — a bundle that doesn't
belong to the slug it was ordered under is refused rather than silently substituted. `POST
/esim/complete {paymentHash}` is 402 until the invoice is paid, then 200 with the ICCID, a QR, a
manual code, the SM-DP+ address and matching id, and install links for Apple and Android — safe to
call more than once. There is no listing endpoint, and nothing on nadanada's side records which
wallet an order was for.

That last fact is what `site/api/lib/store.js` exists to fix: one record per redemption id, kept in
Upstash Redis over REST (`KV_REST_API_URL` / `KV_REST_API_TOKEN`; in memory only for tests), moved
through invoiced → paid → done and resumable at every step, so a crash mid-payment picks up where it
left off instead of paying twice. Three things follow from that design, and `test/nadanada.test.js`
and `test/redeem-nadanada.test.js` hold the code to all of them: a redeem names the slot (`n`) it
means to fill, so a retried or replayed request gets back the order it already made rather than a
second one; an unpaid invoice is not a redemption — `find()` answers null for it, so an outage never
consumes a wallet's credit; and activation codes are only ever attached to a signed request from the
wallet that earned them — the public `GET` shows balances and order history, never a code, because
whoever installs a code first has the data. Before any invoice is paid, `site/api/lib/bolt11.js`
decodes it and refuses to pay unless it carries the payment hash nadanada quoted and an amount
matching the quoted price at Blink's own BTC rate, and refuses a quote priced above the catalogue as
stale.

## Layout

| Path | What |
|---|---|
| `site/` | The front end: plain files, no build step |
| `site/index.html` | The one HTML shell; a hash router picks what fills it |
| `site/app.js` | The hash router: mounts `site/esim.js` at `#/`, `site/status.js` at `#/status`, and draws the short About panel itself at `#/about` |
| `site/esim.js` | The programme page's script (`#/`): rules, live treasury and curve numbers, a wallet's own credit, the redeem flow |
| `site/status.js` | The status dashboard (`#/status`): the whole machine on one screen — what's running, what isn't, and every number behind it |
| `site/ui.js`, `site/ui.css` | Shared visual components: the token badge, the delta pill, the small charts |
| `site/style.css` | Site-wide styles and the colour palette |
| `site/qr.js` | Draws the activation QR in the browser, for the orders nadanada gives no image with |
| `site/fonts.css`, `site/fonts/` | Self-hosted type, so the page can draw itself without waiting on a CDN |
| `site/vercel.json` | Function timeouts, cache headers, and the security headers every response carries |
| `site/api/status.js` | The health endpoint the dashboard reads: what's wired up, checked live, never a secret |
| `site/api/redeem.js` | The one serverless function that spends money: wallet signature in, eSIM out |
| `site/api/lib/providers/` | `nadanada.js`, against the verified API, paid by Lightning; `esimaccess.js`, an alternative reseller; `mock.js`, for tests and a keyless deploy |
| `site/api/lib/payers/` | `blink.js` pays and prices in Lightning through Blink's API; `mock.js`, for tests |
| `site/api/lib/store.js` | The nadanada provider's record of each redemption — Upstash Redis over REST, or in memory for tests |
| `site/api/lib/bolt11.js` | Decodes a Lightning invoice far enough to check its amount and payment hash before it's paid |
| `site/api/lib/eip191.js`, `site/api/lib/secp256k1.js`, `site/api/lib/keccak.js` | Verify the wallet signature a redeem signs in with |
| `site/config/esim.json` | The coin (empty until launch day), the terms, the brand, and the dated catalogue from nadanada |
| `site/config/addresses.json` | Chain id, RPC endpoints, USDG, the Pons factory and its friends — the copy the site and the API read |
| `site/data/allowances.json` | The week's plan: each wallet's balance, share and allowance — written by `scripts/allowances.js` |
| `site/data/claims.json` | A log of every sweep out of the fee escrow — written by `scripts/claim.js` |
| `site/data/funding.json` | A log of every top-up of the Lightning wallet — written by `scripts/fund.js` |
| `site/data/treasury.json` | The pool card's numbers: balance, 30-day spend, runway, status — written by `scripts/treasury.js` |
| `scripts/allowances.js` | Re-derives every wallet's credit from USDG `Transfer` logs |
| `scripts/catalogue.js` | Regenerates the package list in `site/config/esim.json` from nadanada's portfolio |
| `scripts/claim.js` | Sweeps the creator tax from Pons's escrow into the treasury; simulates before it sends |
| `scripts/fund.js` | Tops the Lightning wallet up from the treasury's USDG, over FixedFloat and Across |
| `scripts/treasury.js` | Pool balance, 30-day spend at what was actually paid, runway, last claim |
| `scripts/chain.js`, `scripts/keccak.js`, `scripts/secp256k1.js` | Dependency-free JSON-RPC, hashing and signing, carried over from [13V/manna](https://github.com/13V/manna), same author, same style, MIT |
| `scripts/lint.js` | The cheapest check there is: every script parses, every config is JSON |
| `config/addresses.json` | The same chain config as `site/config/addresses.json`, for the scripts that run outside the deployment |
| `.github/workflows/data.yml` | Every 30 minutes: the allowances ledger and the treasury file, commit if changed (which deploys), issue if the pool is low |
| `.github/workflows/claim.yml` | Daily: claim, fund the pool, refresh the treasury file, commit |
| `test/*.test.js` | The offline suite, one file per unit — see Running it |
| `test/support/fake-nadanada.js` | A fake nadanada server the nadanada-dependent tests run against instead of the real one |
| `test/site/` | The browser suite (Playwright), maintained alongside the front end |

## Running it

```
node scripts/lint.js                                # every script parses, every config is JSON
npm test                                             # the ledger, the redeem function, both providers,
                                                      # the invoice check, the store, and the keepers — offline

npm run allowances                                   # rebuild this week's plan from chain
npm run allowances -- --week 2957                    # rebuild a specific week
npm run catalogue -- --write                         # rebuild site/config/esim.json's package list from nadanada's portfolio
npm run treasury                                     # rebuild site/data/treasury.json (the pool side needs ESIM_PROVIDER and its keys)
PRIVATE_KEY=<treasury> npm run claim -- --dry-run    # what the sweep would do
PRIVATE_KEY=<treasury> npm run fund -- --dry-run     # what the next top-up would move, nothing sent

npm run serve                                        # serve site/ on http://127.0.0.1:4174
npm run test:site                                    # the browser suite (needs `npm install` for @playwright/test first)
```

Everything above `npm run serve` is read-only or dry by default: `allowances`, `catalogue` and
`treasury` need no key at all, and only write a file when nadanada or the chain actually answer;
`claim` and `fund` need `PRIVATE_KEY` even to price a dry run, but move nothing without it and a
real one. Before a coin is launched, `allowances` and `treasury` still run — they write an empty
ledger and an "unknown" pool rather than fail, which is what a fresh clone actually sees.

## To turn it on

In Vercel's project settings: `ESIM_PROVIDER=nadanada`, `BLINK_API_KEY`, `KV_REST_API_URL` and
`KV_REST_API_TOKEN` (Upstash for Redis, provisioned from the Vercel Marketplace, sets the last two
itself). As repository secrets, for the two workflows: `TREASURY_PRIVATE_KEY`, `BLINK_API_KEY`,
`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `FIXEDFLOAT_API_KEY` and `FIXEDFLOAT_API_SECRET`. Until the
coin is launched — `site/config/esim.json`'s `coin` field is empty — the deploy answers with the
rules and "coin not launched yet", and the workflows say what they skipped rather than failing.

## What v1 doesn't do

Two things are narrow on purpose, and both are stated on the page itself. Only trades made against
the bonding curve count: once a coin graduates, trading moves to a DEX pool this ledger does not
read, so volume from there on doesn't earn credit. And only a USDG-paired coin is countable at all —
the ledger is built by reading USDG `Transfer` events, and a coin paired with native ETH moves no
ERC-20 when it trades, so `scripts/allowances.js` refuses to run against one rather than publish a
ledger of zeros that would look like nobody had traded.
