# Hosting the OTT account and eSIM API

GitHub Pages serves the app interface. A separate Node backend runs the account, signed installation-detail and redemption handlers. `scripts/serve-api.js` provides a portable HTTP server using Node's standard library; it needs Node 22 or newer and no runtime npm dependencies.

The server exposes only `/api/status` and `/api/redeem`. It does not serve the website, configuration files, repository contents or environment files. There is no separate public health route: use `GET /api/status` for hosting checks, then examine its readiness fields. HTTP 200 means the status response loaded; it does not mean the programme is ready to issue eSIMs.

## Local checks

From the repository root:

```sh
node scripts/serve-api.js
```

The default listener is `127.0.0.1:3000`. `HOST` and `PORT` change it. The checked-in programme is prelaunch, so an account request is expected to report that the coin has not launched. A local successful status response does not create credit or an eSIM.

For local integration, mock providers and memory storage are allowed only outside production. They are fixtures and must not be presented as a live account. The public app keeps sample accounts explicitly labelled.

## Vercel prelaunch setup

Vercel can host the existing static site and its two Node functions. Import `13V/OTT` with Root
Directory **`site`**, Framework Preset **Other**, no build or install command, and Node **22.x**.
Keep the output directory at its default. `site/vercel.json` sets function durations and includes
the public eSIM catalogue in both function bundles. Utility modules live in `api/_lib`, so Vercel
does not generate a separate function for each helper.

If the account has no GitHub login connection, a deployment can instead upload only the committed
`site/` files through Vercel's deployment API. That does not configure automatic Git deployments.
Never upload the entire local workspace: it may contain private or untracked files.
The current backend at `https://ott-prelaunch.vercel.app` uses this manual deployment path.
GitHub automatic deployment integration is pending, so future reviewed API or catalogue changes
need a separate manual deployment of the committed `site/` tree.

Apply the hosted configuration below to **both Production and Preview**, including
`NODE_ENV=production` and `REDEMPTIONS_ENABLED=0`. Do not use the portable server's `HOST`, `PORT`
or start command for these serverless functions. Use the verified provider base
`https://nadanada.me/api/v2` and `LN_PAYER=blink`. Production uses `STORE_PREFIX=wf:`;
Preview uses `STORE_PREFIX=ott:preview:` so its records remain separate. Keep the current
main-branch `ALLOWANCES_URL` and `TREASURY_URL` from the weekly-data section.

Create **Upstash for Redis** through Vercel Marketplace and connect it to this project. For
prelaunch, select the **Free** plan, disable automatic plan upgrades, and disable eviction so
order records cannot silently disappear at a storage limit. Vercel may require the account owner
to accept the Marketplace and Upstash terms before provisioning. The adapter accepts the
integration's `KV_REST_API_URL` / `KV_REST_API_TOKEN` or
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` variables. Keep credentials server-side
and redeploy after connecting storage. The [Upstash integration documentation](https://upstash.com/docs/redis/howto/vercelintegration)
describes this managed account flow. An unfunded Blink wallet remains a separate later step.

For the current GitHub Pages frontend, preserve `FRONTEND_ORIGINS=https://13v.github.io` and
`SIGNIN_HOST=13v.github.io`. Record Vercel's actual public production origin, configure it as the
app's `apiBaseUrl`, republish Pages, and run `npm run check:prelaunch -- --remote`. A protected
preview deployment is not a usable public API origin. If moving the canonical frontend to a
Vercel domain later, update the exact origin, signed hostname and Reown allowlist together.

## Alternative Render prelaunch setup

The root `render.yaml` defines one free Node web service named `ott-api-prelaunch`. It creates no database or wallet and includes no private credentials. It pins Node 22, installs the lockfile without development packages or install scripts, starts the portable API and uses `/api/status` as its health check. The 75-second shutdown allowance covers the server's 70-second graceful shutdown window. Render supplies `PORT`.

After this Blueprint has been pushed to `main`, open [Deploy the prelaunch API on Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2F13V%2FOTT). Sign in to Render, review the single service and confirm that its compute plan is **Free** before applying the Blueprint. This link starts Render's setup flow; it is not an existing deployed API URL. [Render documents this deployment flow](https://render.com/docs/deploy-to-render).

The service starts with the public frontend origin, signature hostname, real provider and payer selections, a prelaunch store namespace and current main-branch ledger URLs. `WHOLESALE_BASE_URL` is set to nadanada's documented public API base, `https://nadanada.me/api/v2`; its [official API reference](https://nadanada.me/api/v2/documentation) describes Lightning purchase and completion endpoints. Status probes only its bundle catalogue, without creating an order, and requires a recognizable nonempty bundle response. Status will still report the missing payer and durable store. Account requests will report that the coin has not launched while the public launch addresses are empty. A successful health check is only proof that the listener responds.

Automatic deployments are off. When you change API code or the bundled catalogue, use **Manual Deploy** in the service dashboard to deploy the reviewed commit. New ledger data is fetched from `main` without redeploying the service. Once Render provides the actual HTTPS service URL, copy only its origin into `site/config/app.json`'s `apiBaseUrl`, republish GitHub Pages and check the cross-origin status response. Do not guess the service URL from its name.

This free service is for setup and preview. It sleeps after 15 idle minutes and can take about a minute to wake up, so the app's short request timeout may require retrying after the service wakes. Render advises against using free instances for production. Move live redemption to suitable hosting before enabling provider orders. [Render's free-service limits](https://render.com/docs/free) describe its sleep, restart and usage behavior.

Before live use, add `BLINK_API_KEY`, `KV_REST_API_URL` and `KV_REST_API_TOKEN` through the service's environment settings. Confirm an externally durable Redis REST store and a funded payer. If your provider supplies a different endpoint, override `WHOLESALE_BASE_URL` there; preserve the privacy of any operator-specific endpoint. Render's native Key Value connection string is not the HTTP REST endpoint this adapter expects, and its free Key Value tier loses data on restart. Keep secrets out of the Blueprint. Configure the real public `coin`, `curve` and `treasury` addresses, refresh the catalogue, and publish a funded current-week ledger. A Reown project ID is separately required for mobile wallet connections. The prelaunch namespace must not be reused as a shortcut to reset any later live order history.

## Complete setup before funding

A Lightning balance is not needed to deploy the API, verify the provider catalogue, connect persistent storage, configure mobile wallet pairing or publish the app. These steps can be completed while the token addresses remain empty and redemption is disabled:

1. Deploy the Vercel project or alternative Render Blueprint above. Keep `REDEMPTIONS_ENABLED=0`. Record the HTTPS production origin the host actually assigns.
2. Create persistent Redis through Vercel Marketplace or the [Upstash Console](https://console.upstash.com/). Review its plan before creation. Connect its HTTPS REST URL and standard read/write REST token to the backend. The [REST documentation](https://upstash.com/docs/redis/features/restapi) explains these credentials. A read-only token cannot record orders or pass the storage probe. A temporary database that expires after 72 hours is suitable only for a separate integration test, never the order ledger.
3. Create a dedicated OTT project in [Reown](https://dashboard.reown.com/), and allow the frontend origin `https://13v.github.io`. Copy the public project ID. [Reown's origin allowlist documentation](https://docs.reown.com/cloud/relay) says changes can take 15 minutes to apply. Project IDs are client identifiers; provider and storage credentials never belong in the client configuration.
4. Run `npm run configure:app -- --project-id YOUR_PUBLIC_PROJECT_ID --api-origin https://YOUR_ACTUAL_API_HOST`. Commit these public settings and republish Pages. No backend or Reown value is invented by this command.
5. Run `npm run check:prelaunch -- --remote`. It checks the current frontend settings, matching prelaunch backend, paused redemption, actual provider catalogue access, durable storage and the Pages CORS preflight. It performs only a status GET and an OPTIONS request against the API. The backend's status probe also tests one disposable storage key. The wallet can still be absent or empty; no payment or eSIM order is created.

The prelaunch report explicitly defers token launch, wallet funding/payment validation, funded holder allocations and installation on a real phone. A passing prelaunch report does not allow live redemption. Keep the public `coin`, `curve` and `treasury` fields empty until the actual token launches.

## Hosted configuration

Deploy this repository to a Node host that supports a persistent HTTP process, or retain the existing serverless handlers on a compatible host. For the portable server, the start command is:

```sh
node scripts/serve-api.js
```

Set `HOST=0.0.0.0` for hosts that require a public listener, and use the port supplied by the hosting platform. A non-loopback `HOST` always sets `NODE_ENV=production`, including when a development value was inherited. Production rejects mock eSIM providers, mock payers and memory stores. `WHOLESALE_ALLOW_MEMORY_STORE=1` cannot override the production guard.

Terminate HTTPS at the platform or a trusted reverse proxy. The portable listener is HTTP; do not expose it directly as the frontend's API origin. The app accepts HTTPS API origins and permits plain HTTP only for local development on a loopback browser origin.

Keep the following settings in the host's environment manager. Public values may be declared in the Blueprint; credentials and operator-specific endpoints belong only in the environment manager. Do not commit a filled environment file or put secrets in `site/config/app.json`.

| Setting | Required value or purpose |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | Platform listener address, commonly `0.0.0.0` |
| `PORT` | Platform-assigned port |
| `FRONTEND_ORIGINS` | `https://13v.github.io` |
| `SIGNIN_HOST` | `13v.github.io` |
| `ESIM_PROVIDER` | `wholesale` for the existing Lightning-funded provider |
| `LN_PAYER` | `blink` |
| `REDEMPTIONS_ENABLED` | `0` during setup; production accepts only exact `1` to permit orders |
| `WHOLESALE_BASE_URL` | `https://nadanada.me/api/v2` for the documented public API, or an operator-supplied alternative |
| `BLINK_API_KEY` | Private Lightning wallet credential |
| `KV_REST_API_URL` | Durable Redis REST endpoint |
| `KV_REST_API_TOKEN` | Private standard read/write Redis REST token for the backend |
| `STORE_PREFIX` | `wf:` in Production; `ott:preview:` in Preview |
| `ALLOWANCES_URL` | URL of the current published weekly ledger |
| `TREASURY_URL` | URL of the current published treasury report |

`FRONTEND_ORIGINS` accepts a comma-separated list of exact origins. Use the scheme and hostname, without `/OTT/` or another path. Wildcards are refused. Do not grant extra origins merely to get around an error. `SIGNIN_HOST` binds the wallet's signed message to the frontend hostname; CORS permission does not replace signature validation.

`ESIM_CONFIG_URL` can optionally override the bundled `site/config/esim.json`, for example when staging has a separately published catalogue. Leave it unset to use the bundled config. A real deployment must configure its public `coin`, `curve` and `treasury` addresses in that catalogue. The backend does not invent these values.

For the alternative `esimaccess` provider, use `ESIM_PROVIDER=esimaccess` and its server-only `ESIMACCESS_ACCESS_CODE`. The current catalogue and funding pipeline target `wholesale`; switching providers requires confirming the package codes, pricing and funding arrangement before enabling redemption.

## Keep weekly data current

The existing data workflow commits refreshed ledgers to `main`. The separately published `gh-pages` branch does not automatically receive those updates. An API pointed at the Pages copy may therefore read an old ledger.

For the existing repository workflow, the public data URLs can be:

```text
ALLOWANCES_URL=https://raw.githubusercontent.com/13V/OTT/main/site/data/allowances.json
TREASURY_URL=https://raw.githubusercontent.com/13V/OTT/main/site/data/treasury.json
```

These are public generated data, not credentials. Check that the workflow actually runs, publishes the current week, and reports real funding. On a non-Vercel host these URLs must be explicit; do not invent Vercel environment variables to make self-fetching work. The backend refuses new redemptions when the ledger is for another week.

Both the data and claim workflows' treasury refreshes read the same Redis order records as the
backend. The published workflows leave `STORE_PREFIX` unset and use the adapter's default `wf:`.
Vercel Production explicitly uses `STORE_PREFIX=wf:` to match; Preview uses `ott:preview:` for
separate records. The published workflows do not consume a `STORE_PREFIX` repository variable.
Any future namespace change must keep the backend and published workflow settings in agreement
and preserve a live namespace and its paid order history.

These GitHub treasury refreshes only read orders, so their `KV_REST_API_TOKEN` repository secret
can use Upstash's read-only REST token. The Vercel backend needs the standard read/write token to
record orders and complete the disposable-key storage probe. The credentials stay in the respective
environment managers; they are not public frontend settings. No Blink credential is configured yet.

The allocation script currently divides last week's collected tax in proportion to eligible token holdings. The proposed entry allowance and 40 GB weekly cap are not implemented. Do not publish those as guaranteed benefits until the funding and allocation policy has been validated.

The preferred operator funding currency is now USDC on Solana. Direct automated settlement with
the supplier remains unverified; its documented purchase API lists Lightning and Stripe. The
deployed payer and existing USDG-to-USDC-on-Base funding script have not been switched. See the
[private operator phone-test guide](operator-phone-test.md) for the verified payment options and
the isolated test tooling. No payment or real phone installation has been performed.

## Connect the frontend

After the host has issued its real HTTPS API origin, put that origin in the public `apiBaseUrl` field of `site/config/app.json`. Use only the origin, without `/api`, a query, credentials or a fragment. The app resolves the two API paths against it and refuses redirects for account requests.

Mobile WalletConnect also needs the separate public Reown project ID in the same file. The checked-in
configuration now contains OTT's public Reown project ID and `https://ott-prelaunch.vercel.app` as
the API origin. All 15 remote prelaunch checks have passed with redemption disabled and durable
Redis connected. Token launch, wallet funding, a real payment and installation on a phone remain
deferred; these preparation checks do not establish live readiness.

## Verify before enabling live redemption

Production defaults to closed purchases. Keep `REDEMPTIONS_ENABLED=0` while connecting services, even after adding a funded wallet. The gate blocks new package orders in both the request handler and real providers; account and signed installation-detail reads stay available. Set it to `1` only after the token launch, reviewed allocation policy and funded end-to-end verification. A status response reports `redemption.enabled` separately from `redemption.ready`; configured but unfunded or unlaunched services never report live readiness.

Run `npm run check:launch` to check the public wallet, API and token configuration without contacting an account. After saving the real API origin, `npm run check:launch -- --remote` also reads `/api/status` and checks the GitHub Pages CORS preflight. It never signs, places an order, sends a payment or prints backend credentials. A successful HTTP health response alone cannot pass it: it checks actual dependency flags, matching token addresses, a current ledger and a positive Lightning balance. These checks do not certify budget coverage, package pricing or a successful installation on a real phone.

Run the offline server tests and the existing backend suite. Check the real HTTPS endpoint's status response, including `config.launched`, selected provider/payer/store and every readiness field. Confirm a current-week ledger and a funded payer. A status check does not order an eSIM.

An unsigned account GET must contain no QR code, activation string, manual-install details or installation links. A signed read authorizes installation-detail access only. A redemption asks for a separate signature naming the package and order slot; it cannot reuse a read signature or a signature from another week.

The portable server accepts JSON POST bodies up to 16 KiB and closes rejected body connections. Put any additional platform request limits and rate controls in front of the API. Avoid logging request bodies, signatures, installation details or private provider URLs. Back up the durable store and keep its production namespace stable: it is the record of already-paid orders.

The CLI handles `SIGTERM` and `SIGINT`, stops accepting requests, closes idle connections and allows up to 70 seconds for active requests to finish. Interrupted provider orders resume through the existing durable order state; do not replace the production store with an empty one to recover an outage.
