# First automated funded phone test

Prepared 7 October 2026. This runbook prepares a private operator test. Funding, conversion
and purchase are separate user decisions; no money has moved during preparation.

The requested fresh local Solana wallet now has its own [setup and read-only preflight](solana-test-wallet.md).
Direct USDC supplier payment remains disabled. The instructions below describe the existing
Lightning payer, which still requires Blink credentials and a verified funding route.
**Do not deposit into the local Solana wallet yet:** unsigned construction and private
reservation safeguards are prepared; payment and owner recovery execution are not available.
For this run, use the implemented Blink API payer. The supplier website's separate USDC
checkout does not exercise OTT's automated invoice, payment and recovery workflow.

## The test we have prepared

| Item | Value |
| --- | --- |
| eSIM | Australia, 1 GB, 7 days |
| Supplier SKU | `fixed_1GB_7D_AU` |
| Live catalogue price checked 7 October | $1.99 |
| Supplier invoice cap | $2.50 |
| Invoice plus estimated routing fee cap | $2.50 |
| Dedicated Blink BTC wallet balance cap | $4.00 equivalent |
| Proposed total funding budget, including conversion and gas | $4.00 equivalent |
| Run ID, including all later recovery attempts | `phone-test-20261006-au-001` |

The Australian test location and eSIM-capable iPhone have been confirmed. Device details and
the user's previous successful eSIM use are recorded privately. This pilot checks automated
payment, issuance, installation and real mobile data.
It does not validate the proposed OTT burn membership or holder allocation.

## Before funding

1. Use a dedicated Blink account's default **BTC wallet** for the automated test. The current
   payer spends Lightning BTC. It does not spend USDC or SOL directly.
2. If USDC on Solana is your source, use a fresh Phantom wallet. A private key previously
   shared in chat must be treated as exposed; do not fund that wallet or share a replacement
   private key. This Lightning operator workflow needs a Blink API key. The separate local
   Solana preparation creates its own fresh encrypted wallet without receiving a chat key.
3. Create a short-lived `OTT phone test` API key yourself in the
   [Blink dashboard](https://dashboard.blink.sv). Read and Write are needed for this test;
   Receive is needed only if generating a funding invoice through the API. Confirm that the
   Upstash REST token is the standard read/write token. Read-only preflight cannot establish
   either service's write permissions. [Blink scope documentation](https://dev.blink.sv/api/auth).
4. Open PowerShell in this repository and run:

   ```powershell
   Set-Location 'C:\Users\troyw\OneDrive\Documents\ChatGPT\OTT'
   npm run phone:setup
   npm run phone:preflight
   npm run phone:storage-check
   ```

   Enter the Blink API key, Upstash REST URL and token into the local setup prompts yourself.
   Secret prompts do not echo their contents. Credentials are encrypted for your Windows user
   in `%USERPROFILE%\.codex\private\ott-phone-test`, outside OneDrive. Do not paste them in chat.

Preflight must confirm the exact live package, successful storage reads, an accessible default
BTC wallet and no existing payment requiring recovery. A zero balance is expected before
funding. Missing credentials or an unresolved old payment must be corrected first. The command
creates no invoice or checkout, writes no order and sends no payment. Its readiness summary
describes read-only prerequisites; it never authorizes funding or claims a payment is ready.

The separate storage check creates one random dummy record under
`ott:operator-test:storage-check:`. It verifies write permission, exclusive creation and
atomic comparison/update/delete, then removes only its own matching record. It never reads
or changes an order, invoice, holder balance or production index. A crash can leave a dummy
record behind; it cannot reserve or send a payment. Require a successful check before funding
or purchase. Storage success does not verify Blink Receive or Write permissions.

On 7 October, the check without private credentials confirmed the $1.99 catalogue entry.
Local credentialed wallet/storage preflight has **not** passed yet. The open Blink session
is signed out, and the encrypted operator credentials file is absent. Wallet access must be
configured through the hidden local setup prompts before funding. A wallet address alone
does not grant access to the API payer.

## Funding route and amount

The prepared automated route is:

**USDC on Solana → user-reviewed conversion → dedicated Blink BTC wallet via Lightning → eSIM**

Funding Blink via Lightning directly avoids the USDC conversion step if you already have BTC
available through Lightning. Do not send Solana tokens to a BTC address or Lightning invoice.

[FixedFloat](https://ff.io/) lists both
[USDC on Solana and BTC Lightning](https://ff.io/about). Its minimum and exchange output
change; earlier previews are not reusable funding instructions. A
[read-only fixed-rate feed](https://ff.io/rates/fixed.xml) check at
04:15 UTC on 7 October reported a minimum above 2.2 USDC for this pair. No receiving invoice
was entered and no exchange was created. A new quote is required before selecting a service
or transferring funds. The existing treasury funding script is for a different source chain
and is not the Solana phone-test funding command.

Before a transfer, review a fresh quote for the exact source asset/network, amount delivered,
minimum, all fees, source SOL gas and invoice expiry. Fit the **total cost within $4**, leaving
the dedicated BTC wallet below its $4 cap. Prefer enough delivered BTC to cover the $2.50
estimated-payment ceiling with some balance headroom. Do not increase the budget to satisfy
an exchange minimum without reviewing the change with the user. Generate any receiving
Lightning invoice only when ready to use it; no funding address is pinned in this runbook.

The routing probe is an estimate. Blink does not expose a strict final routing-fee cap in
the current send API. A small dedicated wallet limits the available satoshis; its USD value
still changes with BTC price. See the [full operator notes](operator-phone-test.md).

## After funding

Run `npm run phone:preflight` again. Confirm the package still matches, the wallet remains
within its cap, and there is no unresolved send. A funded preflight still cannot quote a real
supplier invoice or verify final routing cost. Do not change the run ID or any spending flags.

Within the user's approved purchase and limits, use the exact paid command in
the [operator notes](operator-phone-test.md#later-automated-paid-test). A timeout, pending or
uncertain payment means resume/review **the same run**, never create another paid attempt
under a new ID. Preserve invoice and send reservations during recovery.

Public redemptions remain disabled. This local operator process does not enable public
purchases, alter holder balances or use the public holder eSIM index.

## Install and prove connectivity

After the order reaches `done`, generate the private installation page:

```powershell
node scripts/esim-install-pack.js --order-file "$env:USERPROFILE\.codex\private\ott-phone-test\phone-test-20261006-au-001\order.json"
```

Open the resulting `install.html` privately. On Wi-Fi, scan its locally generated QR or use
the manual fields on the compatible phone. Follow the supplier's APN and roaming instructions,
choose the new eSIM for mobile data, turn Wi-Fi off, and load a webpage in Australia.

Record only pass/fail for: payment settled once, eSIM issued, profile installed, mobile data
working with Wi-Fi off, and recovery/no duplicate purchase if a retry was needed. Keep API
keys, activation codes, QR images, ICCIDs and private order files out of Git and public reports.

## Separate manual Phantom test

This avoids depositing into the unfinished local wallet. Unspent USDC stays in the user's
Phantom wallet. It tests the supplier checkout, issuance and phone connectivity, while OTT's
automated payment and redemption workflow remain untested.

1. Confirm the physical phone supports eSIM, is carrier unlocked and will be tested in
   Australia. Use a wallet whose private key has never been shared in chat.
2. Reopen the original Nadanada order and verify Australia, 1 GB, 7 days, then its linked
   MixPay checkout. Refresh expired instructions on that same checkout. Do not create a
   replacement order merely because payment status is pending.
3. Select **USDC (Solana)**. Review the live amount, native USDC network, exact destination,
   timer and all required references. The earlier 2 USDC quote is only an observation;
   neither its address nor screenshot is reusable payment authorization.
4. The user reviews and signs the specific transfer in Phantom, including its final SOL
   network fee. Keep the total test cost within the agreed $4 limit. There is no operator
   signing command for this route and no need to transfer the remaining wallet balance.
5. Keep both original tabs open until MixPay shows the correct payment settled and Nadanada
   issues the intended eSIM. A signature or redirect alone is insufficient. If status is
   uncertain, preserve the same order and transaction and investigate before any retry.
6. Keep the activation QR and manual setup credentials private. Install on Wi-Fi, follow
   the supplier's roaming/APN instructions, select the eSIM for mobile data, then disable
   Wi-Fi and load a webpage in Australia. Record pass/fail without publishing activation data.
