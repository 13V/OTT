# OT+T

OT+T (Onchain Telephone + Telegraph, ticker OTT) is a prelaunch project that turns token trading
fees into mobile-data credit for members. The coin will launch on [pump.fun](https://pump.fun) on
Solana, paired with SOL. pump.fun pays the coin's creator a fee on every trade: 0.30% while the
coin is on its bonding curve, then, after it graduates to PumpSwap, 0.95% at 420–1,470 SOL market
cap, falling to 0.05% for the largest coins. OT+T's treasury is that creator.

A wallet joins by burning about $5 of OTT once, which also earns it a welcome eSIM: any 1 GB,
7-day plan up to $4. The burn is a transfer to Solana's incinerator, which nobody holds the key
to, and the amount in OTT is set each Monday from the coin's price. Each week, 80% of the creator
fees collected the week before is split among members by how much OTT they hold at the Monday
snapshot, with no member above 3× the average share. The rest stays in the pool as a reserve for
welcome eSIMs and fees. Members use that credit for eSIM packages at home or abroad. The verified
catalogue currently includes 84 packages across 28 countries and regions.
[docs/membership.md](docs/membership.md) sets out the rules and the data contract.

**Current status:** OTT has not launched. The site, the API and the keepers are built for
pump.fun on Solana; the coin is created on launch day, and then four addresses go into
`site/config/esim.json` (see [To turn it on](#to-turn-it-on)). The public app offers a sample
account and phone setup guidance; weekly holder credit and real eSIM redemption are unavailable,
and production purchases stay disabled until launch (`REDEMPTIONS_ENABLED=0`).

The allowance expires at the end of the week. That is not meanness, it is what makes the promise
affordable: the pool never owes more than one week of fees it has already collected, so there is
no accruing claim on a treasury funded by trading that may stop.

The name is built the way AT&T's was: a formal corporate name, Onchain Telephone + Telegraph, worn
down to the initialism people actually say — the same way American Telephone and Telegraph wore
down to three letters, so the ticker is OTT. The plus is deliberate: it stands in for the ampersand
a ticker has no room for.

## How a trade becomes data

pump.fun keeps the creator fee on the bonding curve, and after graduation in the PumpSwap pool,
until someone pays it out. Paying out is permissionless and can only ever pay the creator.
`scripts/claim.js` does it once a day, and again just after Monday's new budget is published
(`.github/workflows/claim.yml`): one transaction sweeps
whatever is waiting and pays it to the treasury, a wallet that holds nothing but fee income. That
is what makes it acceptable to keep the treasury's key as a repository secret, and the daily
collection is what keeps more than a day's fees from waiting. The transaction is simulated before
it is sent, and `--rehearse <mint>` builds the same transaction for any live pump.fun coin and
simulates it unsigned, which is how the account lists were checked before OTT existed.

Straight after, `scripts/fund.js` moves what just landed into the Lightning wallet wholesale is
paid from: a Blink invoice for the sats to receive, then a FixedFloat fixed-rate order, SOL → BTC
(Lightning), that pays it. FixedFloat answers with the SOL to send and a one-off deposit address,
and the treasury sends exactly that in one plain transfer. The quote is checked against Blink's own
BTC price and SOL's market price before anything moves, the order is checked against the quote,
and the transfer is simulated before it is sent.

Meanwhile `scripts/allowances.js` re-derives the week's plan from the chain:

- **The join amount.** At its first run each week it prices OTT from the bonding curve (or the
  pool once the coin has graduated) and SOL's dollar price, and sets the week's amount: $5 of OTT,
  rounded up to two significant figures and never more than 2% of the supply. Every week's amount
  is kept in the file, and a burn is judged against the amount for the week it was sent in.
- **Members.** Every burn is a transfer into the incinerator's OTT account, so that account's
  history is the full list of joins. A wallet becomes a member once its burns add up to the
  amount. The treasury can never be a member, and a transfer with no single ordinary wallet behind
  it is skipped and logged.
- **The snapshot.** Each member's OTT at the start of the week (Monday 00:00 UTC) is read from
  each of its token accounts' history, not from a live balance.
- **The budget.** 80% of the dollar value of the creator fees collected into the treasury during
  the previous week, each collection valued at SOL's price in the hour it landed.
- **The split.** The budget is shared among the members at the snapshot by their holdings, capped
  at 3× the average, with `cappedShares()` in `site/api/_lib/membership.js`.

Nothing is stored on top of chain data; `site/data/allowances.json` is rebuilt every 30 minutes
(`.github/workflows/data.yml`).

Taking the snapshot at the week boundary rather than at the moment of redemption is deliberate: an
allowance computed from a live balance can be taken by borrowing a large position, redeeming the
biggest share, and returning it straight after. `scripts/treasury.js` reads what the collection
and the top-up left behind — the treasury's SOL, the fees still waiting on pump.fun, the Lightning
wallet's balance, the last 30 days of what redemptions actually cost, the runway they imply — into
`site/data/treasury.json`, which is where the pool's status (funded, low, behind, empty, unknown)
comes from.

A member spends the week's allowance at `/api/redeem`: sign a message with a Solana wallet, pick a
wholesale package, and it places the order — invoice, payment and completion, all against the
Lightning wallet `fund.js` keeps stocked — and hands back the ICCID, the QR and the install links
wholesale returns. The welcome eSIM goes through the same endpoint, as one signed claim under a
fixed id of its own. The ledger proves membership, or, for a burn newer than the ledger, the burn
transaction itself does: the API reads it from the chain and applies the same rule the ledger does.

## Why dollars, and not gigabytes

A gigabyte is not one thing. wholesale's own packages price it from $0.70 to $8.99 per GB depending
on size and place — ten gigabytes for a month in France is $6.99, one gigabyte for a week worldwide
is $8.99 — and an allowance denominated in gigabytes would let a wallet claim the cheap kind and
spend the dear kind. Dollars keep it honest: a share of the budget is a share of the budget, and
what it buys is whatever the holder actually picks.

## What the allowance is, and what it is not

It is a weekly usage allowance, funded by the coin's own tax, spendable only on mobile data, and it
expires. It is not a dividend: nothing is paid out in money, nothing accrues, and holding the coin
is not a claim on the treasury. That distinction is the whole reason the allowance expires weekly
and is denominated in data rather than dollars paid out — a pool of other people's fees paid to
whoever holds, in cash and without limit, is a shape worth not having. The burn is the
subscription; what it entitles you to is a welcome eSIM and a share of
one week of data at a time, and if you do not use a week's share, it is gone.

## What is verified, and what is guaranteed

`provider.example/api/v2` (OpenAPI at `/api/v2/openapi.json`) was read directly, not assumed, on 15
September 2026: `POST /esim/purchase {bundleName, slug, paymentMethod: "lightning"}` answers a
bolt11 invoice, a payment hash and a price 5% under list for paying in sats — a bundle that doesn't
belong to the slug it was ordered under is refused rather than silently substituted. `POST
/esim/complete {paymentHash}` is 402 until the invoice is paid, then 200 with the ICCID, a QR, a
manual code, the SM-DP+ address and matching id, and install links for Apple and Android — safe to
call more than once. There is no listing endpoint, and nothing on wholesale's side records which
wallet an order was for.

Read again on 16 September 2026 for the two endpoints that decide the shape of the product:
`POST /esim/{iccid}/purchase` and `POST /esim/{iccid}/complete` add a bundle to a profile that
already exists. The top-up completion answers `{iccid, bundleName, toppedUp}` and no installation
details, because there is nothing new to install; it 403s when the checkout belongs to a different
ICCID. What makes this the right default rather than a convenience is wholesale's own account of how
bundles behave: a bundle's validity does not begin when it is bought but when the phone first
connects to a network in its region, and bundles on one profile run **consecutively** — a top-up
queues behind whatever is running and starts the moment that ends, losing neither days nor data
from the bundle in front of it. The profile itself lapses only after six months with no connection,
and every connection starts that six months again.

So a holder gets one eSIM per place they buy, topped up every week, instead of a new eSIM every
week: ten claims become one profile with ten bundles queued behind each other, not ten QR codes and
ten independent idle clocks. Per place, not per holder, and that distinction is load-bearing —
because bundles run in sequence, a Japan bundle queued behind an unused Europe one would be
unreachable until the Europe one ended, and the holder would land in Tokyo with data they had paid
for and could not use. A second profile for a second region costs nothing (the SIM is free; only
data is billed) and works on arrival. `simFor()` in the wholesale provider is where that is decided,
and `test/sim.test.js` holds it there.

One thing is **not** settled, and it is worth knowing before the first holder stockpiles a queue:
wholesale's two pages disagree on whether a bundle has a shelf life. Their `/faq` says "There is no
separate activation deadline: unused bundles stay on your eSIM until you use them"; their `/esim`
page says "You must activate the data bundle within 6 weeks of purchase or it expires." Both were
read on 16 September 2026. If the six weeks is the real rule, a holder who claims every week and
does not travel loses the oldest bundles, and the weekly allowance should be given a way to be
banked rather than claimed. Ask them before relying on either answer.

That last fact is what `site/api/_lib/store.js` exists to fix: one record per redemption id, kept in
Upstash Redis over REST (`KV_REST_API_URL` / `KV_REST_API_TOKEN`; in memory only for tests), moved
through invoiced → paid → done and resumable at every step, so a crash mid-payment picks up where it
left off instead of paying twice. Three things follow from that design, and `test/wholesale.test.js`
and `test/redeem-wholesale.test.js` hold the code to all of them: a redeem names the slot (`n`) it
means to fill, so a retried or replayed request gets back the order it already made rather than a
second one; an unpaid invoice is not a redemption — `find()` answers null for it, so an outage never
consumes a wallet's credit; and activation codes are only ever attached to a signed request from the
wallet that earned them — the public `GET` shows balances and order history, never a code, because
whoever installs a code first has the data. Before any invoice is paid, `site/api/_lib/bolt11.js`
decodes it and refuses to pay unless it carries the payment hash wholesale quoted and an amount
matching the quoted price at Blink's own BTC rate, and refuses a quote priced above the catalogue as
stale.

## Layout

| Path | What |
|---|---|
| `site/` | The front end: plain files, no build step |
| `site/index.html` | The one HTML shell; a hash router picks what fills it |
| `site/app.js` | The hash router: mounts `site/home.js` at `#/`, `site/esim.js` at `#/data`, `site/status.js` at `#/status`, `site/holders.js` at `#/holders`, `site/mobile-app.js` at `#/app`, and draws About at `#/about` |
| `site/esim.js` | Destination discovery and catalogue, the holder dashboard (`#/data`), credit and eSIM display, the redeem flow, and the burn that joins |
| `site/solana.js` | Base58, program and token-account addresses, the token and compute-budget instructions, transaction messages and a Solana JSON-RPC client, with no dependencies; the site, the API and the keepers all load it |
| `site/wallet.js` | The Solana wallet connection: Wallet Standard wallets (Phantom, Solflare, Backpack and others), with Phantom's injected provider as a fallback |
| `site/status.js` | The status dashboard (`#/status`): the whole machine on one screen — what's running, what isn't, and every number behind it |
| `site/ui.js`, `site/ui.css` | Shared visual components: the token badge, the delta pill, the small charts |
| `site/style.css` | Site-wide styles and the colour palette |
| `site/qr.js` | Draws the activation QR in the browser, for the orders wholesale gives no image with |
| `site/fonts.css`, `site/fonts/` | Self-hosted type, so the page can draw itself without waiting on a CDN |
| `site/vercel.json` | Function timeouts, cache headers, and the security headers every response carries |
| `site/api/status.js` | The health endpoint the dashboard reads: what's wired up, checked live, never a secret |
| `site/api/redeem.js` | The one serverless function that spends money: wallet signature in, eSIM out |
| `site/api/_lib/providers/` | `wholesale.js`, against the verified API, paid by Lightning; `esimaccess.js`, an alternative reseller; `mock.js`, for tests and a keyless deploy |
| `site/api/_lib/payers/` | `blink.js` pays and prices in Lightning through Blink's API; `mock.js`, for tests |
| `site/api/_lib/store.js` | The wholesale provider's record of each redemption — Upstash Redis over REST, or in memory for tests |
| `site/api/_lib/membership.js` | The membership rules — the weekly join amount, which transfers count as a burn, folding burns into members, the capped split by holdings, welcome-plan eligibility — shared by the ledger keeper and the redeem API |
| `site/api/_lib/rpc.js` | The redeem API's few chain reads: a welcome claim's burn transaction, and the coin's decimals before the ledger knows them |
| `site/api/_lib/solana-auth.js` | Verifies the ed25519 signature on a signed request |
| `site/api/_lib/bolt11.js` | Decodes a Lightning invoice far enough to check its amount and payment hash before it's paid |
| `site/api/_lib/keccak.js` | keccak256, for the fixed order ids every past order is found by |
| `site/config/esim.json` | The coin, its token program, the treasury and the incinerator's OTT account (all empty until launch day), the terms, the brand, and the dated catalogue from wholesale |
| `site/config/addresses.json` | The Solana RPC endpoints (server and browser), the explorer and the launchpad — the copy the site and the API read |
| `site/data/allowances.json` | The week's plan: the join amount, members, and each sharing member's holding, share and allowance — written by `scripts/allowances.js` |
| `site/data/claims.json` | A log of every collection of creator fees — written by `scripts/claim.js` |
| `site/data/funding.json` | A log of every top-up of the Lightning wallet — written by `scripts/fund.js` |
| `site/data/treasury.json` | The pool card's numbers: treasury SOL, fees waiting, Lightning balance, 30-day spend, runway, status — written by `scripts/treasury.js` |
| `scripts/allowances.js` | Sets the week's join amount and re-derives members and every member's credit from the chain |
| `scripts/solana-chain.js` | The keepers' Solana toolkit: paced RPC, transaction history, balances at a moment, pump.fun's accounts and price, SOL's price, keys and sending |
| `scripts/pump-fees.js` | How much creator fee is waiting, and the instructions that collect it |
| `scripts/catalogue.js` | Regenerates the package list in `site/config/esim.json` from wholesale's portfolio |
| `scripts/claim.js` | Collects the creator fees from pump.fun into the treasury; simulates before it sends |
| `scripts/fund.js` | Tops the Lightning wallet up from the treasury's SOL, over FixedFloat |
| `scripts/treasury.js` | Pool balance, fees waiting, 30-day spend at what was actually paid, runway, last claim |
| `scripts/lint.js` | The cheapest check there is: every script parses, every config is JSON, and the launch addresses agree with each other |
| `config/addresses.json` | The same chain config as `site/config/addresses.json`, for the scripts that run outside the deployment |
| `.github/workflows/data.yml` | Every 30 minutes: the allowances ledger and treasury file, commit if changed, issue if the pool is low; the API reads those published files |
| `.github/workflows/claim.yml` | Daily: collect fees, fund the pool, refresh the treasury file, commit |
| `test/*.test.js` | The offline suite, one file per unit — see Running it |
| `test/fixtures/solana/` | Real mainnet transactions and pump.fun accounts, and the pump.fun IDL entries the claim is checked against |
| `test/support/fake-wholesale.js` | A fake wholesale server the wholesale-dependent tests run against instead of the real one |
| `test/site/` | The browser suite (Playwright), with a fake Wallet Standard wallet in `test/site/support/wallet.js` |

## Running it

The holder web app opens at `#/app`, with Home, Plans, eSIMs and Help screens. The website's
**Open app** link enters it; **Add to phone** offers browser installation or platform instructions.
The manifest starts the installed app at that route and uses relative paths for GitHub Pages.
The same holder appears in a clay park, a Japanese street and a connection kit. Cream SIM-shaped
passes keep credit and package actions together, with compact coverage search and a step-by-step
phone setup guide. The self-hosted fonts carry through from the website. Artwork files and their
generation briefs are recorded in [docs/app-artwork.md](docs/app-artwork.md).

Before launch, **Try the app preview** uses an example $20 allocation with $5 already spent.
Adding a package changes only this page's sample account. It never issues an eSIM, requests a
signature, writes to the provider or stores a balance. Refreshing clears the example. Setup guides
describe the phone's installation process; preview mode never produces usable activation codes.

The service worker stores only an explicit list of public shell files, fonts, icons and artwork.
Configuration, current ledgers, APIs, wallet signatures, eSIM credentials and orders are never
cached. Previously viewed interface/help files can open offline; credit and redemption require a
live connection. Signed orders are never queued for later delivery.

The site connects Solana wallets through the Wallet Standard, the way Phantom, Solflare and
Backpack announce themselves to a page, with Phantom's older injected provider as a fallback. With
more than one wallet installed it asks which to use. On a phone without a wallet in the browser it
offers to open OT+T inside Phantom's or Solflare's own browser, where the wallet can connect. A
reload reconnects the wallet last used without a prompt, only if that wallet still trusts the site.
Home reads spendable credit, usage and expiry from the live API without a signature. A missing API
displays **Credit unavailable**; an old weekly ledger displays **Awaiting allocation**. Neither is
replaced with sample credit. **Wallet settings** lets a holder copy their address or disconnect.
Account and wallet changes clear private installation details and invalidate pending signatures.
Reading installation codes and redeeming a package use separate wallet approvals; each signs a
plain-text message that names what it authorises. Remaining-GB telemetry is not implemented, so
package sizes are not presented as live usage readings. Physical-device wallet handoff and real
eSIM installation still need testing after launch.

Each authorized eSIM in the app offers **Set up this eSIM**, a three-step guide for iPhone or
Android. It uses only provider-supplied installation links, QR codes and manual details; links
must use HTTPS without URL credentials. Codes remain hidden on unsigned reads. Account changes
close the guide and remove its private details. Completing the guide does not mark the eSIM as
installed or active. The instructions follow [Apple's setup guide](https://support.apple.com/en-au/118669)
and [Google's Pixel guide](https://support.google.com/pixelphone/answer/16115470?hl=en).
The order tracker distinguishes wallet approval, provider issuance and available setup details.
Pending issuance can be refreshed without approving another order or signing again.
An order approval reveals installation details only for that order's eSIM profile. Other
profiles remain redacted until the holder separately approves an account read.

Set the public backend address in `site/config/app.json`:

`npm run configure:app -- --api-origin https://YOUR_BACKEND_HOST` validates and saves it while
preserving other settings. The command accepts no provider credentials; run launch checks and
deploy after saving.

```json
{
  "apiBaseUrl": "https://YOUR_BACKEND_HOST"
}
```

The checked-in configuration uses the backend origin `https://ott-prelaunch.vercel.app`.
`apiBaseUrl` is a HTTPS origin without a path, query or credentials. An empty value keeps APIs on
the frontend's own origin; GitHub Pages cannot answer those API requests. HTTP is allowed only
between local development origins. Invalid settings fail before asking for a signature. The
client sends no cookies to the API and refuses redirects of signed requests. Configuration and
live account data remain outside the service-worker cache.

GitHub Pages hosts the frontend at <https://13v.github.io/OTT/>. `npm run deploy:pages` publishes
the committed `site/` tree on `gh-pages`. It excludes `api/`, Vercel configuration and untracked
files, adds `.nojekyll`, and does not change the current checkout. The data and claim workflows run
the same publish at the end of every run, because the site reads `data/*.json` from Pages: Pages
then follows `main`, both the keepers' data and any merged site change, within one keeper run.
Run `npm run deploy:pages` to publish at once.
Pages cannot run the redemption/status functions. A backend deployment is needed before launch;
using a separate API host requires the public `apiBaseUrl` above and the backend settings below.

The Vercel backend is connected to `13V/OTT`, with production deployments from `main` and Root
Directory `site`. The Solana release deployed on 17 October 2026 and passed all 14 remote
prelaunch checks, including the catalogue fingerprint, durable order storage and the Pages CORS
preflight, and GitHub Pages serves the same build. Future changes to `site/` deploy through Git.
The coin's creation, funding the Lightning wallet, a real payment and installation on a phone
remain; public redemption stays disabled until launch.

`npm run serve:api` runs the same redemption/status handlers as a portable Node server. It listens
on `127.0.0.1:3000` by default and serves only those two API routes. A public `HOST` forces
production safeguards. Use a HTTPS hosting platform or reverse proxy for a real deployment.
See [docs/backend-deployment.md](docs/backend-deployment.md) for the environment settings,
current-ledger URLs and deployment checks. No backend host or private credentials are configured
by publishing the frontend.

```
node scripts/lint.js                                 # every script parses, every config is JSON, the launch addresses agree
npm test                                             # the ledger, the redeem function, both providers,
                                                     # the invoice check, the store, and the keepers — offline

npm run allowances                                   # rebuild this week's plan from chain
npm run catalogue -- --write                         # rebuild site/config/esim.json's package list from wholesale's portfolio
npm run check:prelaunch -- --remote                  # verify setup with redemption disabled; no funding required
npm run launch:config -- <mint>                      # launch day: the four launch values, read from the new coin
npm run treasury                                     # rebuild treasury status; pool reads need ESIM_PROVIDER and BLINK_API_KEY
npm run claim -- --dry-run                           # what the collection would do, simulated, nothing sent
npm run claim -- --rehearse <mint>                   # the same transaction for any live pump.fun coin, simulated unsigned
npm run fund -- --dry-run                            # what the next top-up would move, nothing sent
npm run fund -- --check                              # FixedFloat lists SOL (in) and BTC over Lightning (out); read-only

npm run serve                                        # serve site/ on http://127.0.0.1:4174
npm run test:site                                    # the browser suite (needs `npm install` for @playwright/test first)
```

The chain reads in `allowances` and the public portfolio read in `catalogue` need no API key, but
public Solana endpoints rate-limit, so the workflows read through `SOLANA_RPC_URL` when it is set.
`WHOLESALE_BASE_URL` or `WHOLESALE_PORTFOLIO_URL` can override the catalogue endpoint. The
Lightning pool read in `treasury` requires `BLINK_API_KEY` on the host; without it the pool is
reported as unknown. These commands update local files but do not buy eSIMs or move funds.
`fund` needs `TREASURY_PRIVATE_KEY` even for a dry run, plus the Blink and FixedFloat keys for its
quotes; `claim --dry-run` simulates unsigned without a key. Keep `--dry-run` until live
transactions are intended. Before launch, `allowances` and `treasury` publish an empty ledger and
an unknown pool without inventing holder credit, and `claim` and `fund` say there is nothing to do
and stop cleanly. Once the funding secrets are set, the daily run before launch also checks that
FixedFloat lists the currency codes a top-up uses (`SOL` in, `BTCLN` out) and fails, opening an
alert issue, if it doesn't; `FIXEDFLOAT_FROM_CCY` overrides the SOL code.

## To turn it on

In the backend host's project settings: `ESIM_PROVIDER=wholesale`, `WHOLESALE_BASE_URL`, `BLINK_API_KEY`,
`KV_REST_API_URL` and `KV_REST_API_TOKEN` (the Redis REST endpoint and its server-only token), and
`SOLANA_RPC_URL` if you have a dedicated Solana endpoint (the API reads a welcome claim's burn from
the chain). The Render Blueprint selects nadanada's public base `https://nadanada.me/api/v2`; an
operator-specific override belongs in the host's environment settings. For the Pages frontend set
`FRONTEND_ORIGINS=https://13v.github.io` and `SIGNIN_HOST=13v.github.io`. The origin has no `/OTT/`
path, and the signed host is the frontend host even when the API uses another host. CORS permits
that exact origin, accepts only the supported preflight methods and JSON content header, and never
uses a wildcard or cookies. Set `NODE_ENV=production` (Vercel production deployments also set
`VERCEL_ENV=production`). Production refuses missing/mock providers, mock payers, memory stores and
unsigned-host configuration. `WHOLESALE_ALLOW_MEMORY_STORE` cannot bypass that production
requirement.

As repository secrets, for the two workflows: `TREASURY_PRIVATE_KEY` (the treasury wallet's Solana
secret key, base58 as Phantom exports it, or a JSON byte array), `BLINK_API_KEY`,
`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `FIXEDFLOAT_API_KEY`, `FIXEDFLOAT_API_SECRET`, and
`SOLANA_RPC_URL` (recommended: public endpoints rate-limit the ledger's history reads). The GitHub
treasury refreshes only read Redis orders and can use Upstash's read-only REST token for
`KV_REST_API_TOKEN`. Vercel needs the standard read/write token for recording orders and its
storage probe. The published data and claim workflows use the adapter's default Redis namespace
`wf:`. Vercel Production uses `STORE_PREFIX=wf:` so treasury reporting reads the same order
records; Preview uses `STORE_PREFIX=ott:preview:`. The published workflows do not consume a
`STORE_PREFIX` repository variable. Any future namespace change must keep the backend and
published workflow settings in agreement and preserve paid order history.

New purchases also default to closed in production. Keep `REDEMPTIONS_ENABLED=0` through setup;
only exact `1` permits orders. Account and signed installation reads remain available while closed.
Joining needs no separate switch. The app offers the burn once purchases are on, the weekly
ledger knows the coin and has priced this week's amount, and the treasury reports the pool funded
with room for a welcome eSIM beyond what the week owes.
`npm run check:prelaunch -- --remote` verifies setup without treating wallet funding or token launch
as completed. Follow [the wallet-free setup steps](docs/backend-deployment.md#complete-setup-before-funding)
before enabling live redemption.

The indexer workflow refreshes files on `main`, while Pages is published separately. Point the
backend at the refreshed ledger instead of a stale Pages copy:

```text
ALLOWANCES_URL=https://raw.githubusercontent.com/13V/OTT/main/site/data/allowances.json
TREASURY_URL=https://raw.githubusercontent.com/13V/OTT/main/site/data/treasury.json
```

If the frontend itself is hosted on Vercel, its CSP allows the browser's Solana endpoint
(`https://solana-rpc.publicnode.com`); add a separate API origin to `connect-src` before using it
from that deployment. GitHub Pages does not apply `site/vercel.json` headers. Hosting the frontend
creates no holder credit: launched coin addresses, fresh funded allocations, the durable store and
the real provider/payer must all be configured. Weekly credit goes to members by holdings, capped
at 3× the average member share (`membership.capMultiple`). The earlier proposals for a $50 entry
allowance and a 40 GB weekly cap are not implemented or promised by the app.

### Launch day

1. **Create the coin on pump.fun from the treasury wallet**: a fresh wallet used for nothing else,
   whose secret key becomes `TREASURY_PRIVATE_KEY`. pump.fun pays the creator fee to the wallet
   that creates the coin, so the treasury must be the creator. Keep the coin paired with SOL, and
   leave Holder Rewards, Cashback, Mayhem mode and fee sharing off: each sends some or all of the
   creator fee elsewhere, or changes who can collect it.
2. **Fill in the four launch values from the coin itself**:
   `npm run launch:config -- <mint> --treasury <treasury wallet>` reads the coin from Solana,
   refuses one the keepers can't serve (not on pump.fun, not paired with SOL, Holder Rewards or
   Cashback on, fee sharing set up, a live mint or freeze authority, or a creator other than the
   treasury), and prints `coin`, `tokenProgram`, `treasury` and `membership.burnAccount` (the
   incinerator's token account for the coin). Run it again with `--write` to put them in
   `site/config/esim.json`. The site treats the coin as launched only when all four are set, and
   `npm run lint` refuses a config where some are set and others aren't, or where `burnAccount`
   isn't the incinerator's account for that coin and token program.
3. **Check the creator by hand** as well, on pump.fun's coin page or Solscan, against `treasury`: a
   treasury that has never collected anything looks exactly like a quiet week.
4. Commit and push (production deploys from `main`), publish Pages with `npm run deploy:pages`,
   and add the repository secrets above.
5. **Put at least $50 in the Blink Lightning wallet** before switching purchases on with
   `REDEMPTIONS_ENABLED=1` on the **Production** environment only. On Vercel the API never places
   orders outside Production, whatever the switch says, because each deployment records orders
   under its own prefix and a preview that could buy would let members spend twice; keep the Blink
   key Production-only as well. The app offers joining only while the treasury report calls the pool
   funded ($50 or more, with room for a $4 welcome eSIM beyond what the week owes), and on launch
   day no creator fees have been collected into it yet. From then on the keeper tops it up from
   the fees; run the claim workflow by hand (Actions → claim → Run workflow) to collect sooner.
6. **Protect what the API trusts.** It reads the ledger from `main` and pays from the Blink wallet,
   so: require 2FA for everyone with write access, keep collaborators few, and protect `main` so
   only admins and the keeper bot can push to it. Add a per-IP rate limit on `/api/*` in Vercel's
   Firewall if your plan has it, and a usage alert in Upstash, so a flood of requests can't use up
   the store's quota for everyone. Disconnect any other Vercel project that deploys this repository.

Until then the deploy answers with the rules and "coin not launched yet", and the workflows say what
they skipped rather than failing. Week one publishes a budget of zero, honestly and without
crashing: there were no fees the week before to make one from. The join amount is priced from the
first run after launch, so joining opens within half an hour of the coin going live, as long as the
pool is funded (step 5).

Two things to know about how it runs once it is on. The funding keeper aims at what the week still
owes its members — the published budget less what has been redeemed — rather than a flat target, so
a big week pulls more across; it is bounded by a ceiling on the standing Lightning balance
(`--max-pool`), a per-run cap on a single FixedFloat order (`--max`), and the treasury's own
balance less the SOL it always keeps for fees and rent (`--keep-sol`), and it says which stopped
it. It also keeps room for five welcome eSIMs at the $4 maximum on top of what the week owes
(`--reserve` overrides that), because the API stops offering the burn once the pool can't pay for
one. And `site/data/treasury.json` carries a `behind` status, for a pool that is not low by any
backward-looking measure and still cannot cover what this week has already promised.

## What v1 doesn't do

A few things are narrow on purpose. Only a SOL-paired pump.fun coin is supported, with a plain
wallet as its creator: the claim, the price and the treasury report all read pump.fun's own SOL
accounts. The app doesn't sell OTT; it links to the coin's pump.fun page. The join amount is set
once a week from the price at Monday's first ledger run, so its dollar cost drifts with the price
until the next Monday. And the welcome claim for a burn newer than the ledger is checked against
the chain at claim time, while weekly credit follows the ledger, so a new member shares from the
first Monday snapshot after their burn.
