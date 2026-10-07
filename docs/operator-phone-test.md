# Prelaunch phone test

Start with the [first funded phone test runbook](phone-test-quickstart.md) for the prepared
package, local setup and funding sequence. This document describes the detailed safeguards.
The requested [local Solana wallet workflow](solana-test-wallet.md) now prepares an encrypted
unfunded wallet and checks public balances; it has no signing or payment execution command.

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
Direct automated USDC settlement remains unverified. No funds have moved and no real eSIM has
been ordered as part of this preparation. Blink API access still requires private credential
handoff and a successful read-only preflight.

## Prepared test and funding budget

Prepared on 6 October 2026 and catalogue rechecked on 7 October; this is a proposal, not
authorization to fund or buy:

| Setting | Prepared value |
| --- | --- |
| Run ID | `phone-test-20261006-au-001` |
| Package | Australia, 1 GB, 7 days (`fixed_1GB_7D_AU`) |
| Current official supplier price | $1.99; recheck before purchase |
| Funding currency and total funding budget | USDC on Solana, $4.00 equivalent including funding costs |
| Supplier invoice limit | `--max-invoice-usd 2.50` |
| Invoice plus estimated Lightning routing fee limit | `--max-payment-usd 2.50` |
| Dedicated Blink BTC wallet balance limit | `--max-wallet-usd 4.00` |

The proposed automated route is **USDC on Solana → user-reviewed Lightning conversion →
dedicated Blink BTC wallet → Nadanada**. No conversion service, receiving invoice or funding
address has been selected. Obtain an exact, current quote before any transfer: source-chain
gas, conversion spread/fees, withdrawal costs and the amount delivered to Blink must together
fit the $4.00 funding budget. The source wallet may also need SOL for gas; its dollar cost counts
toward that budget. Confirm the delivered BTC is sufficient for the package and routing fee.
Minimum conversion sizes may make this small test impractical. No fixed quote or availability
is guaranteed; do not increase the budget or change the route without the user's review.

Blink's [official API reference](https://dev.blink.sv/public-api-reference.html#lninvoicepaymentinput)
does not expose a strict routing-fee limit on `lnInvoicePaymentSend`. The fee probe is an
estimate. `--max-payment-usd` refuses a send when the invoice plus that estimate exceeds the
prepared limit; it cannot guarantee the final routing fee or USD settlement total. Physically
limiting a dedicated wallet's BTC balance bounds the available satoshis, while their USD value
can change. Do not use a wallet with other funds or replenishing deposits for this test.

Keep the wallet unfunded until the user authorizes this package and budget. A successful
dependency check is not permission to convert funds or run `--purchase`.

## Offline preparation

```powershell
npm run test:phone-plan
npm run test:operator-phone
node scripts/test-esim.js --dry-run --run-id phone-test-20261006-au-001 --sku fixed_1GB_7D_AU --max-invoice-usd 2.50 --max-payment-usd 2.50 --max-wallet-usd 4.00
```

The plan uses the reviewed Australian 1 GB / 7 day SKU, currently $1.99 in the repository
catalogue. It creates no invoice, sends no payment and makes no supplier completion request.
Without Redis environment settings it runs entirely offline. With configured Redis and an
explicit run ID it only reads that existing order's stage. It never prints invoice or activation
data. Live supplier pricing may differ from the reviewed catalogue.

The automated checks use a local fake supplier, a pretend payer and isolated test storage.
They exercise pending payments, concurrent retries, issuance recovery, spending guards and
private installation output. Passing them does not establish successful live payment or data.

## Private credential handoff and read-only preflight

The user completes Blink registration/phone verification and creates the Blink API key in
their own dashboard. Supply it through a securely stored local environment or the current
process environment; never paste it into chat, commit it, place it in OneDrive or put it in the
public frontend. Do not assume a previous dashboard sign-in established API access.
The automated test needs Read and Write; Receive is also needed to generate a later funding
invoice. Use a key named `OTT phone test` with a short expiry on the dedicated account. Write
permits spending that wallet's funds. [Blink documents these scopes](https://dev.blink.sv/api/auth).

The required variables are `BLINK_API_KEY`, `KV_REST_API_URL` and the standard read/write
`KV_REST_API_TOKEN`. An inherited `BLINK_WALLET_ID` is refused because the operator balance
guard checks the default BTC wallet. Use the dedicated account's default BTC wallet.

On this Windows machine, run `npm run phone:setup` yourself in PowerShell. It prompts for the
Blink key and Redis token without echoing them, and asks for the Upstash HTTPS REST URL. Windows
DPAPI encrypts the secrets for your signed-in Windows user. The encrypted file lives at
`%USERPROFILE%\.codex\private\ott-phone-test\credentials.json`, outside OneDrive, with protected
ACLs allowing only your user and SYSTEM. Existing credentials are not silently overwritten.
The setup command creates no account, new API key, invoice or payment.

Then run `npm run phone:preflight`, or the equivalent explicit command below. The
`--local-credentials` flag unlocks that encrypted file only in the current process. Offline
plans never load it. Environment variables remain an alternative if you omit that flag.

After those variables are available locally, this command checks dependencies without buying:

```powershell
node scripts/test-esim.js --preflight --local-credentials --run-id phone-test-20261006-au-001 --sku fixed_1GB_7D_AU --max-invoice-usd 2.50 --max-payment-usd 2.50 --max-wallet-usd 4.00
```

Preflight reads the provider catalogue, Blink account/BTC balance and current price, and the
operator storage records. It creates no provider checkout or invoice, sends no payment, and
writes no order or run record. An accessible wallet with zero BTC reports **needs funding**;
that is not a failed account check and is not paid-test readiness. Missing credentials, storage
access errors, package/price changes or mismatched existing records still require correction.
The JSON `readiness` summary gives the current status, required actions and limitations;
`paymentReady` is always false during preflight. A positive balance below the reviewed package
price reports `insufficient-principal`, while a sufficiently funded wallet reports
`invoice-required`. Stored payment states are allowlisted, and pending or uncertain runs
explicitly require recovery/review using the same run ID. `readOnlyPrerequisitesPassed`
only describes successful catalogue, record and wallet reads for a fresh run within the cap.
It does not establish storage write/atomic permissions, Blink Receive/Write scopes, conversion
costs or authorization to transfer funds. Confirm the standard read/write storage token and
appropriate Blink key scopes separately.
A routing-fee estimate requires a real supplier invoice later, so preflight does not promise a
final payment quote. At this preparation stage, credentialed live preflight has not passed.
A check without private credentials on 7 October 2026 confirmed the live Australia package
matches the reviewed 1 GB, 7 day, $1.99 plan; wallet and local storage access remain unverified.

## Later automated paid test

This route still requires the reviewed Blink setup and a dedicated, limited BTC balance. Do not
fund it or run purchase until the operator has approved that specific test and its spending cap.
Complete the user-reviewed conversion quote within the total funding budget, then fund only
the dedicated BTC wallet. Re-run preflight after funding. Preserve the same prepared run ID
and all spending settings.

Example of a paid command, **not run during preparation**:

```powershell
node scripts/test-esim.js --purchase --local-credentials --run-id phone-test-20261006-au-001 --sku fixed_1GB_7D_AU --max-invoice-usd 2.50 --max-payment-usd 2.50 --max-wallet-usd 4.00
```

All three spending flags and an explicit run ID are required for `--purchase`. The invoice
limit applies to the supplier invoice using a fresh BTC/USD check; the payment limit also
checks the estimated routing fee. The test refuses a default BTC balance above the specified
$4.00 wallet limit, checks the stored invoice's expiry and payment hash, and rechecks payment
status inside the supplier's payment lease. Pending, already successful or uncertain payments
cannot trigger another send. The estimate remains subject to the API limitation described above.
If the operator's balance, invoice or lease checks refuse payment before invoking the payer,
the original unpaid invoice remains available for retry with the same run ID after correction.
Thrown or uncertain responses after invoking the payer retain the send reservation; this retry
path does not clear them or permit another send.
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

The run ID is bound to its package, catalogue price and all three spending limits. Reuse the
**same** ID and settings after an interruption. A failed record with an invoice requires payment-state review before a
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
node scripts/esim-install-pack.js --order-file "$env:USERPROFILE\.codex\private\ott-phone-test\phone-test-20261006-au-001\order.json"
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
