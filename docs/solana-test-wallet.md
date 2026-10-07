# Local Solana test wallet

Prepared 7 October 2026. The operator requested a dedicated local wallet for the small
eSIM test. This workflow creates a fresh **unfunded** keypair and checks public chain data.
It has no payment execution mode. It does not register a financial account, buy an eSIM,
or enable public redemptions.

**Hold funding the local wallet.** Receipt of a deposit is possible, but there is no reviewed
command to pay the supplier or return unused funds. The current code constructs unsigned
transactions, quotes live message fees/rent and protects future reservation records. Signing,
broadcasting, owner recovery and supplier settlement still require implementation/review.
The user's Phantom return public address is recorded privately and does not authorize a payment.

## Create and check

Run in PowerShell in this repository:

```powershell
npm run solana:wallet:create
npm run solana:preflight
```

Creation prints only the public address and encrypted file location. The private key is
encrypted with Windows DPAPI for the current Windows user and stored in
`%USERPROFILE%\.codex\private\ott-phone-test\solana-wallet.json`, outside OneDrive and Git.
Its file permissions allow only that user and SYSTEM. Creation refuses to replace an
existing wallet and rejects junctions. Keep this file and the Windows profile intact:
the file alone is not a portable recovery backup. This is an isolated test wallet.

Preflight validates that file's metadata and permissions **without decrypting its key**.
It reads only the [official Solana mainnet RPC](https://solana.com/docs/references/clusters):
mainnet genesis, mint data, confirmed SOL balance and native USDC token accounts. It pins
[Circle's native Solana USDC mint](https://developers.circle.com/stablecoins/usdc-contract-addresses),
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, and verifies six decimals on chain.
Frozen, delegated or externally closable accounts are unavailable for the proposed payment,
and their balances still count toward the wallet cap.

An unfunded wallet should report zero SOL and zero USDC. There is no on-chain account
creation transaction during setup. A successful read-only preflight does not establish
payment readiness. An unavailable or inconsistent RPC response fails the command.

Optional import is available with `npm run solana:wallet:import` **before** fresh creation.
The local prompt hides a dedicated wallet's 64-byte base58 key or Solana CLI JSON array,
encrypts it before passing it to Node, and verifies the matching public address. It refuses
mnemonics, 32-byte seeds and replacement of an existing file. Never paste keys into chat,
command arguments, environment variables or the repository. The wallet whose key was
previously shared in chat is exposed; this workflow does not reuse it.

## Payment preparation and its limits

The candidate package remains Australia, 1 GB, 7 days, SKU `fixed_1GB_7D_AU`, listed at
$1.99 during the latest catalogue check. Its supplier-created MixPay checkout was also
opened on 7 October: the payee was Nadanada, the note matched that original Australian
package/order, and selecting **USDC (Solana)** quoted **2 USDC**, with zero paid. The
deposit instructions displayed a roughly 20-minute countdown. This is an observed website
quote, not a reusable payment instruction: refresh and recheck it before any transfer.

2.2 USDC covers the observed 2 USDC checkout amount; separate SOL is still needed for
chain fees and potentially token-account creation. Funding and total costs are not quoted
yet. The proposed invoice limit is **$2.50** and total
test budget is **$4 including gas and funding costs**. Obtain a current quote before
funding. SOL is required for native transaction fees and potentially token-account rent;
USDC alone is not proof of sufficient funds. No SOL amount or total cost is quoted yet.

The payment helper uses six-decimal integer amounts, caps native USDC at 4 tokens, and
requires a fresh SOL/USD quote before a proposed wallet-value calculation. A balance cap
does not prove total historical funding cost. Transaction fees, any associated token
account creation/rent, conversion costs and the transaction itself still need verification.
The CLI cannot sign, send, simulate, airdrop or increase limits. It does not unlock the
real wallet during creation of an unsigned transaction review. SOL estimates and rent
examples must not be treated as an approved funding amount.

[Nadanada's OpenAPI](https://nadanada.me/api/v2/openapi.json) currently documents only
Lightning and Stripe for automated eSIM purchase. Its MixPay assets route is marked
development-only. The website advertises USDC, but general MixPay asset availability
does not establish automated fulfilment. The original website checkout now confirms a
direct USDC-on-Solana option for this manual test, while automated merchant instruction
authentication, transaction construction and post-payment supplier settlement are unverified.
The public MixPay asset response also claimed 18 decimals for Solana USDC during the
check; the helper rejects this conflict and uses the verified native mint's six decimals.

Private quote inspection is available only for evidence saved under
`%USERPROFILE%\.codex\private\ott-phone-test\solana-quotes`:

```powershell
npm run solana:plan -- --quote-file "$env:USERPROFILE\.codex\private\ott-phone-test\solana-quotes\quote.json"
```

Do not invent a quote or generic processor order to satisfy this command. The strict
format is defined by `validateMerchantQuote` in `scripts/solana-test-payment.js`; the
observed website instructions have not been converted into that full authenticated
processor/order record. It binds supplier/processor IDs, mainnet/native
mint/six decimals, integer amount, destination owner and optional token account, fresh
receipt/expiry times and reference keys. Unknown fields, including unsupported memo
instructions, are rejected. The CLI prints a hashed order fingerprint and public review
fields, omitting the private order ID and checkout URL.

Every imported quote remains **user-supplied and unauthenticated**. The SDK now constructs
an actual unsigned native-USDC transaction with six-decimal `TransferChecked`, exactly one
wallet signer, ordered readonly references and idempotent token-account creation. Public
RPC reads quote its serialized message fee, current token-account rent and fee-payer reserve.
Confirmed balances are rechecked at a later context to refuse deposits exceeding the wallet
cap, and the blockhash is checked again after the final inventory read.

Every plan still reports `paymentReady: false`, `sendAvailable: false`, and blockers for
unverified merchant route and unsigned review only. Missing funds and fresh SOL/USD valuation
are separate funding blockers. The CLI prints hashes and public cost review fields, omitting
private order/checkout data and raw unsigned wire bytes. Passing a funding balance check
does not establish execution or supplier settlement readiness.

The private journal foundation reserves a wallet exclusively, preserving its original
supplied order, destination, amount, owner return address and cost limits. It does not
authenticate merchant instructions or establish human approval. Canonical message
reconstruction and fixture signature verification reject changed transactions. Reservation
and signed records are published exclusively rather than overwritten, and timeout/expiry
never automatically releases a reservation. This module has no real signer or broadcast
path; it is preparation for future execution and reconciliation.
Status observations are supplied by the caller and cannot prove settlement or release a
reservation. A completed merchant payment cannot yet transition into owner recovery. Windows
hardlink publication protects competing processes; power-loss durability of directory metadata
has not been established. These remain gates before enabling execution or accepting funding.

## Before implementing a funded transfer

Verify original Nadanada package/order binding, processor payee/order identifiers, exact
Solana asset, destination, amount, all memo/reference instructions and both order and
instruction deadlines. A bare address or arbitrary transaction request is insufficient.
Keep the same supplier order throughout recovery and reserve any send before broadcast
so a timeout cannot trigger a second payment. Confirm processor terminal success with
matching merchant/amount/currency, then confirm the supplier issued the intended eSIM.
A transaction signature, redirect or callback alone is not completion. See
[MixPay's security guidance](https://mixpay.me/developers/guides/security-guidelines) and
[payment lifecycle](https://mixpay.me/developers/api/payments/payment-lifecycle).

These gates require further implementation and live instruction verification. The existing
[Lightning operator runbook](phone-test-quickstart.md) remains a separate working payer
path once its private credentials, conversion route and funded test are verified. Passing
local Solana fixtures does not validate either live supplier settlement or phone connectivity.

## Verification

On 7 October, fresh encrypted wallet creation and live read-only mainnet preflight passed.
The verified native USDC mint used six decimals; the new wallet held zero SOL and zero
USDC, and preflight did not unlock its key. The public address and readiness snapshot are
kept locally in the private operator directory rather than committed to the repository.
No live signing, funding, purchase or eSIM issuance occurred.

```powershell
npm run test:solana-credentials
npm run test:solana-payment
npm run test:solana-wallet
npm run test:solana-transfer
npm run test:solana-journal
```

The credential suite uses temporary generated fixture keys and real Windows DPAPI/ACL
checks. Payment and CLI fixtures cover exact amounts, wrong network/mint/decimals,
account ownership/state, stale quotes, limits, redaction and refusal to unlock/sign/send.
Linux CI also checks unsupported-platform refusal; Windows CI runs the full credential
and private journal suites. Wallet-credential signatures are plain fixture messages;
journal fixtures verify generated-key signatures on unsigned fixture transactions. No
real wallet key or on-chain transaction is signed or submitted by these tests.
