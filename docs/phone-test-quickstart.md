# First funded phone test

Prepared 7 October 2026. This runbook prepares a private operator test. Funding, conversion
and purchase are separate user decisions; no money has moved during preparation.

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

The phone model and Australian test location still need confirmation. Use an unlocked phone
that supports eSIM. This pilot checks payment, issuance, installation and real mobile data.
It does not validate the proposed OTT burn membership or holder allocation.

## Before funding

1. Use a dedicated Blink account's default **BTC wallet** for the automated test. The current
   payer spends Lightning BTC. It does not spend USDC or SOL directly.
2. If USDC on Solana is your source, use a fresh Phantom wallet. A private key previously
   shared in chat must be treated as exposed; do not fund that wallet or share a replacement
   private key. The operator workflow needs a Blink API key, not a Solana private key.
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
   ```

   Enter the Blink API key, Upstash REST URL and token into the local setup prompts yourself.
   Secret prompts do not echo their contents. Credentials are encrypted for your Windows user
   in `%USERPROFILE%\.codex\private\ott-phone-test`, outside OneDrive. Do not paste them in chat.

Preflight must confirm the exact live package, successful storage reads, an accessible default
BTC wallet and no existing payment requiring recovery. A zero balance is expected before
funding. Missing credentials or an unresolved old payment must be corrected first. The command
creates no invoice or checkout, writes no order and sends no payment. Its readiness summary
describes read-only prerequisites; it never authorizes funding or claims a payment is ready.

On 7 October, the check without private credentials confirmed the $1.99 catalogue entry.
Local credentialed wallet/storage preflight has **not** passed yet.

## Funding route and amount

The prepared automated route is:

**USDC on Solana → user-reviewed conversion → dedicated Blink BTC wallet via Lightning → eSIM**

Funding Blink via Lightning directly avoids the USDC conversion step if you already have BTC
available through Lightning. Do not send Solana tokens to a BTC address or Lightning invoice.

A read-only [FixedFloat](https://ff.io/) floating-rate preview on 7 October showed:

| Source | Preview delivered | Observation |
| --- | --- | --- |
| 4 USDC on Solana | 4,475 sats, about $3.83 | Excludes source-chain gas; sending all 4 USDC could exceed the total $4 budget once gas is counted |
| 2.2 USDC on Solana | 2,384 sats, about $2.04 | Very little room above the package price, before supplier routing fee and Solana gas |

The displayed source minimum was 1.154 USDC for that pair. These are temporary previews,
not accepted quotes or a selected conversion service. No receiving invoice was entered and
no exchange was created. The service lists both [USDC on Solana and BTC Lightning](https://ff.io/about).

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

Once the user approves the specific purchase and limits, use the exact paid command in
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
