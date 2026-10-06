# Holder experience — 6 October 2026

Home suggests available packages that fit confirmed remaining weekly credit.
Plans provides an optional **Fits my credit** filter. Both use the account API's
current week, future expiry and non-stale remaining balance, including a genuine
zero balance. An expired, unavailable or mismatched account never borrows a
sample balance or the published allowance. Preview mode labels its sample credit
beside the package choices. Prelaunch browsing keeps unavailable filters hidden.
Plan matching helps selection; the backend still checks credit at redemption.

Visitors can save up to twelve catalogue destinations. Browser storage contains
only validated destination slugs under an app-scoped key. Unavailable storage
keeps choices for the current visit and explains the limitation. A changed
catalogue excludes old destinations. No balances, identities, orders or eSIM
credentials are saved by this feature. Save sits beside the destination picker;
saved destinations stay in one scrolling row on phones, with keyboard focus
preserved after saving or selecting. Twelve saved destinations cannot push the
primary review action below the first 390 × 844 phone screen.

Previously used eSIM destinations have a Home shortcut. Existing eSIM cards
offer **Review more data** with the destination's lowest-priced package. Review
shows coverage, GB, validity and credit cost before handing the selected package
to eSIMs. The reviewed package is preserved when switching from Solana to the
linked holder wallet. These shortcuts do not sign, place orders or spend credit. The
provider may top up a compatible existing eSIM or issue a fresh profile; the UI
does not promise to target an old ICCID or display live remaining GB.

After signing in with Phantom, use **Link a holder wallet** on Home or open
**Wallet settings → Link holder wallet**. An unlinked account displays this next
step rather than a misleading zero holder balance.
OTT asks for a fresh Solana link message and an isolated EVM ownership proof.
Each binds the exact pair, site, URI, chain, purpose, nonce and five-minute
expiry. The native Phantom SIWS response uses Ed25519; the EVM proof uses
EIP-191 personal_sign. Both are verified on the backend. An EVM proof connection
preserves the selected Solana account and closes only a newly created temporary
WalletConnect session. Rejected or cancelled approvals do not create a link.

Persistent forward and reverse indexes allow one Solana/EVM pair. A conflicting
pair requires explicit unlinking. Nonce consumption, both indexes and revision
guards are committed in one Redis operation while checking the live session
without extending its TTL. Unlinking invalidates old approvals across sessions,
including when there was no pair. Inconsistent indexes fail closed. Clients
also guard delayed reads so an old refresh cannot restore a locally revoked link.

A verified linked Solana login can display the holder wallet's public credit.
Its own account remains credit zero and ineligible. Linking creates no new
allowance and never authorizes EVM purchases or private installation reads.
Those actions require the holder wallet itself. Links survive fresh login;
session tokens remain in page memory and expire after thirty minutes. Wallet
settings offers unlinking and refreshing status. Other open sessions should
refresh their link status after a link is removed elsewhere.

Validation uses disposable fixture keys and local or mocked APIs. Backend checks
cover real proofs, replay, expiry, conflicts, concurrent verification, logout,
cross-session unlink races and durable-store command semantics. Browser checks
cover both approval steps, cancelled/tampered challenges, account changes,
privacy boundaries, credit failures, storage limitations and phone layouts.
Physical Phantom/EVM approval on a customer's device remains a manual check;
no live wallet signatures, payments or supplier orders were performed here.

The complete backend fixture command passed all 24 suites, including 85 new
wallet-link checks. The browser regression suite and targeted follow-up checks
passed locally; release CI verifies all 221 browser cases on the final revision.

Protocol references: [Phantom SIWS](https://github.com/phantom/sign-in-with-solana#message-construction)
and [EIP-191](https://eips.ethereum.org/EIPS/eip-191).
