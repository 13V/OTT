# Solana sign-in — 6 October 2026

The app supports Phantom Solana sign-in alongside the existing EVM connection.
Use **Sign in with Solana** on Home. On a phone, open OTT in Phantom's browser;
on desktop, use its browser extension. A missing wallet opens installation and
mobile guidance. No private key is entered in OTT and sign-in moves no funds.

Phantom's native `signIn` constructs the standard SIWS message. The API issues a
random, five-minute challenge bound to the frontend domain, URI and exact
case-sensitive address. Node's native Ed25519 verifier checks the exact message
bytes and signature. An atomic Redis comparison consumes each challenge once,
including across concurrent function instances. Native SIWS support is required;
an older Phantom version receives update instructions.

Successful login returns an opaque 30-minute session. Only its hash is saved in
the durable store, with Redis expiry. The token stays in page memory and is not
exposed through the app's inspection state or saved in browser storage. Account
events, account switching, disconnect and expiry clear local authentication and
attempt server revocation. A delayed verification response is revoked if its
wallet changed. If logout cannot reach the API, server expiry still bounds the
token lifetime. Refresh can restore a trusted public wallet connection, but a
new message approval is required to authenticate again.

Solana identity itself has zero holder credit and no purchase eligibility. The
[holder experience](holder-experience.md) now supports verified linking to one
Robinhood Chain holder wallet. Public credit is read using that linked EVM
address, without copying or creating allocations. Private installation details
and redemptions still require that EVM wallet's approval. Solana token migration
and SOL/USDC supplier payments remain separate work.

`POST /api/auth` accepts `challenge`, `verify`, `session` and `logout` actions,
plus `link-challenge`, `link-verify`, `link` and `unlink` for wallet links.
It enforces a 16 KiB request limit, configured frontend origins, no-store
responses and a short challenge cooldown. Production requires the existing
durable Upstash configuration; memory storage is restricted to development.
The portable API server and Vercel deployment both include this route. This
adds no runtime dependency, server password or operator credential.

Validation includes ephemeral Ed25519 keys against the actual local API,
signature rejection, exact address matching, malformed/expired messages,
cross-origin rejection, replay and concurrent verification, session logout and
durable TTL cleanup. Browser cases cover approved and rejected login, restored
connection without automatic signing, account changes during verification and
boot, and separation from EVM redemption. Only disposable fixture wallets are
used. Actual approval in a customer's Phantom application remains a manual
device check; paid issuance and phone connectivity remain separate.

Protocol reference: [Phantom Sign In With Solana](https://github.com/phantom/sign-in-with-solana#message-construction).

The change adds 111 backend authentication checks and 26 browser cases for
Solana transport and the real local API login journey. All 23 backend suites and
syntax/configuration lint passed locally. The prior full browser run passed;
the final account-restoration, plan-review and loading-state refinements also
passed their focused regressions. Release CI runs the complete 157-case browser
suite on the published revision.
