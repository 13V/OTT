# Unfunded release verification

Verified locally on 6 October 2026. This prepares the app for a limited operator
test; it does not certify live purchases, phone connectivity or token launch.

## App and installation flow

The app now shares the website's cream canvas, display typography and clay
character artwork. Desktop keeps the full cream canvas, with content and header
aligned to the homepage's 1536 px layout. The preview or credit card sits below
the main actions in normal flow; artwork is capped at 680 px high rather than
stretching with a wide viewport. Desktop uses horizontal navigation;
phones retain bottom tabs and put wallet and credit actions before artwork.
The changed app files have explicit release versions, also listed in the service
worker's public precache, so an existing browser cache cannot hide this redesign.
Public shell refreshes revalidate HTTP responses. Arbitrary queries and private
requests still bypass the service-worker cache.

The 109 browser checks cover Home, Plans, eSIMs, Help, sample orders, wallet
connection and signature failures, retrying private reads, installation-detail
privacy, coverage selection, and desktop and phone navigation. Tested viewports
include 2549 px desktop width and 320 x 568, 360 x 640 and 390 x 844 phones.
Visual review also covered 2538 x 1299, 1440 x 900 and 768 x 1024 layouts.

The design audit follow-up makes the sample preview the main prelaunch Home
action and adds an app invitation to the first homepage screen. Plan options
show GB, validity and required credit together. Functional screens give more
space to account controls, and phone eSIM screens put those controls before
artwork. The website and app share a clay header logo and solid orange primary
buttons. Sample explanations and Exit preview appear before screen content;
Help has named steps, a current step count and a state-appropriate final link.
Supporting phone text is larger, and bottom navigation spans the phone width.
All 109 browser tests pass; four phone layout checks were rerun after the final
navigation adjustment. Lint and all 15 live prelaunch checks pass. Public
redemption remains disabled. These checks use sample or fixture accounts and
do not replace a funded purchase and physical phone connectivity test.

Installation QR codes are encoded locally from the activation string when
available. Setup instructions end with a real connectivity check: choose the
eSIM for mobile data, turn Wi-Fi off and load a webpage inside its coverage.
The app does not infer installation or working connectivity from opening a guide.

## Backend and recovery

All 22 backend suites pass, including 18 payment recovery scenarios, 66
private operator phone-test checks, 76 Blink checks and 9 Windows credential
checks. Syntax and configuration lint passes for 102 files. These tests use
local fixtures and make no real payment. All 15 live prelaunch checks passed
again on 6 October 2026.

Redis compare-and-update operations protect payment leases and order advancement.
A durable reservation is saved before a wallet send. A timeout, interrupted
process, missing supplier checkout or delayed empty wallet history cannot erase
that reservation or authorize another send. Confirmed settlement can resume
issuance; the exact send's explicit failure can permit a known unpaid retry.
An unresolved reservation requires payment-state review. Operator checks that
refuse payment before invoking the payer retain the same unpaid invoice for
retry. An exception or uncertain result after invoking the payer keeps its
reservation and cannot authorize a second send. These paths were checked
against the real adapter with a fake supplier and payer.

The live prelaunch check is:

```powershell
npm run check:prelaunch -- --remote
```

It verifies public configuration, catalogue agreement, HTTPS API, CORS, durable
storage including atomic operations, and the paused purchase gate. It does not
sign a message, order an eSIM or pay an invoice.

## Remaining before a paid test

### Product completion pass — 6 October

The latest pass adds phone-specific **Installed but no data?** help from the
general guide and authorized installation guide, plus compatibility checks from
package review. Connected app accounts show eSIM management before expandable
holdings details. The website's separate My data dashboard retains its expanded
holdings view. Sample troubleshooting explicitly explains that sample eSIMs
cannot connect.

A lost purchase response locks the original package and offers a GET-only
**Check existing order** action. A deliberate retry uses the original package,
week and slot with a new approval; it never submits automatically. Declined
approvals restore the picker, and leaving the account during approval stops
dispatch. Mismatched account responses cannot reveal another wallet's details.
The unconfirmed marker contains only public plan/slot information in page memory;
it saves no signatures, keys or installation codes to browser storage.

The API now redacts private installation/payment values from public error notes,
including encoded and JSON-escaped forms. Status hashes the complete public
purchase terms so release checks reject a price, coverage, validity or SKU
mismatch even when catalogue count and timestamp are unchanged. The new GitHub
verification workflow runs backend, browser and Windows credential fixtures.

Validation: all **119 browser tests** and **22 backend suites** passed locally.
After the final privacy amendment, both affected redemption suites passed again,
including 34 new privacy checks. Syntax/config lint passes for 106 files. These
checks use fixtures and make no real purchase. Service-worker cache v9 and new
asset versions publish the app changes for returning browsers.

The reviewed API release `094057b` is live at `https://ott-prelaunch.vercel.app`
from the connected `13V/OTT` repository's `main` branch, using Root Directory
`site`. Vercel deployment `BEDMSwFqNazTpPZ6mUpxn99cDpAJ` became Ready on
6 October 2026. All **15 live prelaunch checks** now pass, including the exact
catalogue fingerprint, provider catalogue access, durable order storage and
GitHub Pages CORS. The server privacy fixes and catalogue comparison are live.
Public redemption remains disabled; this does not validate a funded purchase
or physical phone connectivity.

### Paid test preparation

The prepared run is `phone-test-20261006-au-001`: Australia 1 GB for 7 days
(`fixed_1GB_7D_AU`), currently $1.99 from the official supplier. Proposed limits
are $2.50 for the invoice, $2.50 for the invoice plus estimated Lightning routing
fee, and $4.00 for the dedicated Blink BTC wallet. The total funding budget is
$4.00 equivalent denominated in USDC on Solana, including conversion, withdrawal
and source-chain gas costs. These prepared values are not purchase authorization.

The proposed automated route is USDC on Solana → user-reviewed Lightning
conversion → dedicated Blink BTC wallet → Nadanada. Direct automated USDC
settlement remains unverified. No conversion quote, receiving invoice or funding
address has been selected. No money has moved and no real eSIM has been issued.

* The user creates the Blink API key and runs `npm run phone:setup` in local
  PowerShell to enter it with the durable storage credentials. Secrets are
  encrypted with Windows DPAPI for that user, outside OneDrive, with protected
  private ACLs. `--local-credentials` unlocks them only in the current process.
  Environment variables remain an alternative. Keep keys out of chat, the
  repository, OneDrive and the public frontend. Dashboard sign-in alone does not
  establish that the operator CLI can read the account.
* Run `--preflight` with the prepared run and all three spending limits. It reads
  the provider catalogue, Blink BTC account/balance and current price, and
  operator storage; it creates no checkout, invoice, payment or storage write.
  A zero-BTC wallet reports needs funding. The catalogue-only preflight confirmed
  the live Australia price and coverage on 6 October 2026. Local wallet and store
  credentials are still missing; credentialed preflight and live payment remain
  unverified. `npm run phone:preflight` runs the prepared read-only check after
  private setup.
* Obtain a current conversion quote that fits the entire $4.00 funding budget
  and delivers enough BTC for the invoice and routing fee. The source wallet may
  need SOL for gas; no fixed quote, conversion minimum or receiving amount has
  been guaranteed. Then obtain the user's authorization for this package and
  budget before transferring funds or buying.
* Run that purchase, resume the same run if interrupted, export its private
  installation pack, and install and test it on a compatible unlocked phone.

Blink's send API does not provide a strict routing-fee cap. The $2.50 payment
check uses an estimate, so it is not a guaranteed final all-in payment ceiling.
Physically limiting the dedicated BTC wallet bounds available satoshis; their
USD value can change. Do not add other funds or automatic deposits to that wallet.
Public redemption remains paused throughout this preparation and operator test.

Follow [the operator guide](operator-phone-test.md). Keep public
`REDEMPTIONS_ENABLED=0` throughout the isolated operator test.

## Remaining before public launch

Token, curve and treasury addresses are still blank. The allocation code remains
proportional to eligible holdings. The proposed $50 entry allowance and 40 GB
weekly maximum are not implemented or validated. They must not be advertised as
guaranteed benefits. Launch also needs a current funded allocation ledger and a
reviewed operating policy before the public purchase gate can be enabled.
