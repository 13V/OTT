# Prelaunch phone test

OTT is not launched. Public redemption stays disabled. A private operator test can check supplier
payment, eSIM issuance and data on an actual phone without inventing token addresses or holder
credit. It cannot validate holder eligibility, weekly allocation or the future token launch.

## Payment currency

The operator selected **USDC on Solana** as the preferred funding currency on 5 October 2026.
This preference has not changed the deployed payer or the treasury funding script.

Nadanada's [website](https://nadanada.me/for-ai-agents) advertises USDC through MixPay. MixPay
[supports native SOL and USDC on Solana](https://mixpay.me/blog/mixpay-supports-solana-sol), and its
public payment-assets endpoint listed both during the read-only check. Merchant-specific assets
and amount limits still need checking against an actual checkout before sending funds.

Nadanada's [public API reference](https://nadanada.me/api/v2/documentation) and its linked OpenAPI
schema currently list only `lightning` and `stripe` for automated eSIM purchase and top-up.
Website crypto checkout does not establish direct USDC support in that API. No speculative
`paymentMethod: "usdc"` or `"mixpay"` integration has been added.

Two distinct tests are possible:

* A manual website crypto purchase can test issuance, installation and phone connectivity. It
  does not test OTT's automated purchase/payment state machine.
* The existing automated operator test pays Lightning invoices. Funding it from USDC on Solana
  requires a separately reviewed conversion into the dedicated Lightning wallet. FixedFloat
  [lists USDC on Solana and BTC Lightning](https://ff.io/about), but availability, minimum amount,
  exchange costs and the exact receiving invoice must be verified before any transfer.

The existing `scripts/fund.js` route starts with USDG on Robinhood Chain and uses USDC on Base.
It is not a Solana USDC funding implementation. Do not run it expecting it to use a Solana wallet.
Direct automated USDC settlement remains unverified. No funds have moved, no real eSIM has been
ordered and no Blink payment key has been saved as part of this preparation.

## Offline preparation

```powershell
npm run test:phone-plan
npm run test:operator-phone
```

The plan uses the reviewed Australian 1 GB / 7 day SKU, currently $1.99 in the repository
catalogue. It creates no invoice, sends no payment and makes no supplier completion request.
Without Redis environment settings it runs entirely offline. With configured Redis and an
explicit run ID it only reads that existing order's stage. It never prints invoice or activation
data. Live supplier pricing may differ from the reviewed catalogue.

The automated checks use a local fake supplier, a pretend payer and isolated test storage.
They exercise pending payments, concurrent retries, issuance recovery, spending guards and
private installation output. Passing them does not establish successful live payment or data.

## Later automated paid test

This route still requires the reviewed Blink setup and a dedicated, limited BTC balance. Do not
fund it or run purchase until the operator has approved that specific test and its spending cap.
Supply private credentials through the local process environment. Never commit them or put them
in the public frontend. The required variables are `BLINK_API_KEY`, `KV_REST_API_URL` and the
standard read/write `KV_REST_API_TOKEN`. An inherited `BLINK_WALLET_ID` is refused because the
test's balance guard checks the default BTC wallet.

Example of a paid command, **not run during preparation**:

```powershell
node scripts/test-esim.js --purchase --run-id phone-test-001 --sku fixed_1GB_7D_AU --max-invoice-usd 2.50
```

The cap applies to the supplier invoice, including a fresh BTC/USD check before payment.
Lightning routing fees are additional. The test refuses a default BTC balance above $20, checks
the stored invoice's expiry and payment hash, and rechecks payment status inside the supplier's
payment lease. Pending, already successful or uncertain payments cannot trigger another send.
The operator CLI pins each Blink request to a two-second timeout so the extra validation reads
and send fit inside the supplier adapter's payment lease. A slow or ambiguous response requires
resuming the same run and checking its payment status; it is not permission for another purchase.
Immediately before sending, it verifies the stored lease still belongs to this caller and is
younger than 20 seconds, leaving time for payment and persistence before the 120-second expiry.
The public adapter independently rechecks payment status inside the same lease and uses atomic
Redis comparisons when taking over or releasing it and advancing or replacing an order. A
missing supplier checkout never erases a paid, pending or uncertain wallet payment.
The adapter records a durable send reservation before calling the wallet. A lost response, crash
or delayed empty wallet history keeps that reservation and the original checkout. It does not
release holder credit or authorize another send. An ambiguous reservation needs payment-state
review; only a confirmed settlement or the exact send's explicit failure resolves it automatically.

The run ID is bound to its package, catalogue price and cap. Reuse the **same** ID and settings
after an interruption. A failed record with an invoice requires payment-state review before a
replacement checkout. Do not create another run merely because a request timed out.

The CLI uses `ott:operator-test:` for all its Redis keys, an empty holder address, and opens the
provider gate only inside that local process. It does not modify Vercel environment settings,
public ledgers, token addresses, a holder's eSIM index or public redemption availability.

## Private installation pack

A completed new-profile test writes `order.json` under
`%USERPROFILE%\.codex\private\ott-phone-test\<run-id>`. The export includes installation
credentials, but excludes Lightning invoice and payment-hash fields. Output must stay inside
that dedicated directory, outside the repository and OneDrive. On Windows, directories and
files receive protected ACLs granting the current user and SYSTEM access; on other systems they
use owner-only permissions. Existing outputs receive the same protection before replacement.

```powershell
node scripts/esim-install-pack.js --order-file "$env:USERPROFILE\.codex\private\ott-phone-test\phone-test-001\order.json"
```

This creates `install.html` alongside the order. It encodes the exact activation string locally
as a QR and includes validated manual fields. The page uses no scripts, external requests or
remote QR service. It refuses incomplete orders, top-ups and inconsistent activation details.
The file contains a real activation credential when used with a real order. Keep it private.

Use Wi-Fi to add the profile on an unlocked, compatible phone. Follow the supplier's APN and
roaming instructions. Then select the new eSIM for mobile data, turn Wi-Fi off and load a webpage
inside the package's coverage area. An installed profile alone is not a successful connectivity
test. Record pass/fail without putting activation strings, ICCIDs or wallet credentials in
public reports.
