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

## Hosted configuration

Deploy this repository to a Node host that supports a persistent HTTP process, or retain the existing serverless handlers on a compatible host. For the portable server, the start command is:

```sh
node scripts/serve-api.js
```

Set `HOST=0.0.0.0` for hosts that require a public listener, and use the port supplied by the hosting platform. A non-loopback `HOST` always sets `NODE_ENV=production`, including when a development value was inherited. Production rejects mock eSIM providers, mock payers and memory stores. `WHOLESALE_ALLOW_MEMORY_STORE=1` cannot override the production guard.

Terminate HTTPS at the platform or a trusted reverse proxy. The portable listener is HTTP; do not expose it directly as the frontend's API origin. The app accepts HTTPS API origins and permits plain HTTP only for local development on a loopback browser origin.

Keep the following settings in the host's environment manager. Replace placeholders there. Do not commit a filled environment file or put these secrets in `site/config/app.json`.

| Setting | Required value or purpose |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | Platform listener address, commonly `0.0.0.0` |
| `PORT` | Platform-assigned port |
| `FRONTEND_ORIGINS` | `https://13v.github.io` |
| `SIGNIN_HOST` | `13v.github.io` |
| `ESIM_PROVIDER` | `wholesale` for the existing Lightning-funded provider |
| `LN_PAYER` | `blink` |
| `WHOLESALE_BASE_URL` | Private provider endpoint, supplied by the operator |
| `BLINK_API_KEY` | Private Lightning wallet credential |
| `KV_REST_API_URL` | Durable Redis REST endpoint |
| `KV_REST_API_TOKEN` | Private Redis credential |
| `STORE_PREFIX` | A deployment-specific namespace; use different values for staging and production |
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

The allocation script currently divides last week's collected tax in proportion to eligible token holdings. The proposed entry allowance and 40 GB weekly cap are not implemented. Do not publish those as guaranteed benefits until the funding and allocation policy has been validated.

## Connect the frontend

After the host has issued its real HTTPS API origin, put that origin in the public `apiBaseUrl` field of `site/config/app.json`. Use only the origin, without `/api`, a query, credentials or a fragment. The app resolves the two API paths against it and refuses redirects for account requests.

Mobile WalletConnect also needs the separate public Reown project ID in the same file. The backend origin and Reown project ID are currently empty. No host URL or project ID is supplied by this deployment preparation.

## Verify before enabling live redemption

Run the offline server tests and the existing backend suite. Check the real HTTPS endpoint's status response, including `config.launched`, selected provider/payer/store and every readiness field. Confirm a current-week ledger and a funded payer. A status check does not order an eSIM.

An unsigned account GET must contain no QR code, activation string, manual-install details or installation links. A signed read authorizes installation-detail access only. A redemption asks for a separate signature naming the package and order slot; it cannot reuse a read signature or a signature from another week.

The portable server accepts JSON POST bodies up to 16 KiB and closes rejected body connections. Put any additional platform request limits and rate controls in front of the API. Avoid logging request bodies, signatures, installation details or private provider URLs. Back up the durable store and keep its production namespace stable: it is the record of already-paid orders.

The CLI handles `SIGTERM` and `SIGINT`, stops accepting requests, closes idle connections and allows up to 70 seconds for active requests to finish. Interrupted provider orders resume through the existing durable order state; do not replace the production store with an empty one to recover an outage.
