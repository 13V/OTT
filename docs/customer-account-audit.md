# Customer account audit — 6 October 2026

OTT accounts use an Ethereum-compatible (EVM) wallet on Robinhood Chain. There
is no email/password registration, custodial customer wallet, or private-key
entry in OTT. Connecting shares a public address; viewing credit needs no
signature. Installation details and redemption each require wallet approval.
USDC on Solana is the proposed operator funding source, a separate flow.

## Customer journey exercised

The live GitHub Pages site was checked from first visit through Open app, sample
account, plan review, adding a sample package, eSIM history and setup help.
Sample mode labels its example credit and eSIMs and supplies no installation
credentials. The deployed WalletConnect dialog opened and cancellation returned
to a disconnected, usable app. No live wallet pairing or signature was approved.

`test/site/customer-account.spec.js` also exercises the real frontend and actual
portable API together, across separate loopback origins. Disposable generated
wallets provide cryptographically valid personal_sign approvals. The backend
has an explicit isolated environment, development mock supplier/payer and memory
store; it inherits no production credentials. Its single fixture package follows
the development mock's legacy place identifier. This verifies account
authorization, rather than certifying the wholesale purchase or payment path.

The integration covers first connection, no automatic signature, rejected
approval with no order request, one approved mock package, unsigned redaction,
disconnect and reload, a fresh signed private read after reconnect, no saved
signatures or activation codes, a new wallet with zero holder credit and
another wallet's refusal when requesting an existing account's codes.

## Findings fixed

* An account event during connection could be overwritten by an earlier wallet
  approval or network-check result. Both the transport and app now preserve the
  current selection and reject stale completion. Revocation cannot restore the
  previous account; expected initial account/network events still connect.
* A restored session on the wrong network could request a signature after the
  network switch had already replaced its account panel, then silently discard
  that approval. It now stops before signing, refreshes private state, and shows
  clear retry guidance. The next deliberate action approves exactly one order.
* Hosted pre-parsed objects and strings could bypass the handler's 16 KiB body
  limit. Every supported representation now enforces the UTF-8 byte limit before
  signature verification, including multibyte input.
* Future timestamps could extend a captured signature's useful lifetime to
  nearly twenty minutes. Future clock skew is now limited to 30 seconds; maximum
  age remains 600 seconds from the signed timestamp.

Account copy now names Robinhood Chain and the required EVM wallet. Updated
release URLs and the service worker cache ensure returning visitors receive
the fixed account scripts.

## Protections and limits

The server verifies signer/address, site, action, plan, slot, signature age and
redemption week. A read approval cannot purchase, and an order approval cannot
unlock unrelated eSIM profiles. Replays return the same existing order. Private
API responses use no-store; the service worker caches only listed public files.
Account changes, network changes, session revocation and disconnect clear the
app's private authorization state and remove private setup views. API requests
omit browser credentials and refuse redirects.

Public account metadata and holder allocations remain public by design;
installation credentials are signed-read protected. Read approvals can be
reused within their short validity window. Disconnect clears local state; it
does not revoke an already captured signed message on the server. There is no
server login cookie, refresh token or persistent customer password to revoke.
Do not log or share signatures and installation credentials.

The audit is code review plus automated fixtures and a live visitor walkthrough,
not an independent penetration test. Actual pairing with a customer's wallet
application, hardware/smart-contract wallet compatibility, paid wholesale
issuance and real phone connectivity remain unverified. Platform-wide abuse
controls and monitoring need operating review before public launch.

Public token addresses remain blank and redemption stays disabled. These
checks do not authorize wallet funding, conversion or purchasing.

## Validation

The account regressions and real local API journey add twelve browser cases.
Local validation covers all 131 browser cases, 22 backend suites and syntax/JSON
lint for 111 files. The browser run's cache assertion was updated to include the
newly versioned wallet script; all five PWA cases then passed. All fifteen remote
prelaunch checks passed before deployment. Deployment and the full fresh browser
run are verified through the change's CI and live release checks.
