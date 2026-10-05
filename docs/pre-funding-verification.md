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

The 107 browser checks cover Home, Plans, eSIMs, Help, sample orders, wallet
connection and signature failures, retrying private reads, installation-detail
privacy, coverage selection, and desktop and phone navigation. Tested viewports
include 2549 px desktop width and 320 x 568, 360 x 640 and 390 x 844 phones.
Visual review also covered 2538 x 1299, 1440 x 900 and 768 x 1024 layouts.

Installation QR codes are encoded locally from the activation string when
available. Setup instructions end with a real connectivity check: choose the
eSIM for mobile data, turn Wi-Fi off and load a webpage inside its coverage.
The app does not infer installation or working connectivity from opening a guide.

## Backend and recovery

All 21 backend suites pass, including 18 payment recovery scenarios and 45
private operator phone-test checks. Syntax and configuration lint passes for
100 files. These tests use local fixtures and make no real payment.

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

* Review the settlement route and supply the private payer credential. USDC on
  Solana is the requested funding currency; direct automated supplier settlement
  in that currency has not been verified. The deployed adapter uses Lightning.
* Approve a limited operator purchase and invoice cap, then fund a dedicated
  wallet. The prepared dry run selects Australia 1 GB for 7 days, with a reviewed
  catalogue price of $1.99. Live pricing and routing fees still need checking.
* Run that purchase, resume the same run if interrupted, export its private
  installation pack, and install and test it on a compatible unlocked phone.

Follow [the operator guide](operator-phone-test.md). Keep public
`REDEMPTIONS_ENABLED=0` throughout the isolated operator test.

## Remaining before public launch

Token, curve and treasury addresses are still blank. The allocation code remains
proportional to eligible holdings. The proposed $50 entry allowance and 40 GB
weekly maximum are not implemented or validated. They must not be advertised as
guaranteed benefits. Launch also needs a current funded allocation ledger and a
reviewed operating policy before the public purchase gate can be enabled.
