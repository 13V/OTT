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
to eSIMs. These shortcuts do not sign, place orders or spend credit. The
provider may top up a compatible existing eSIM or issue a fresh profile; the UI
does not promise to target an old ICCID or display live remaining GB.

## 17 October 2026: one Solana wallet

OTT now launches on pump.fun, so the Solana wallet that holds OTT is the holder wallet. It
connects through the Wallet Standard (Phantom, Solflare, Backpack and others), holds the weekly
credit, signs installation-detail reads and redemptions, and burns OTT to join. The earlier
Phantom sign-in, its 30-minute sessions and the link between a Solana login and a Robinhood Chain
holder wallet are removed, along with `/api/auth` and the link records. Every signed request is
now an ed25519 signature over a plain-text message that names its action, as
[membership.md](membership.md#signed-requests) describes.

Validation uses a fake Wallet Standard wallet with a real ed25519 key
(`test/site/support/wallet.js`), so browser checks verify each signature the way the API does.
Physical wallet approval on a customer's phone remains a manual check after launch; no live wallet
signatures, payments or supplier orders were performed here.

Protocol reference: [Wallet Standard](https://github.com/wallet-standard/wallet-standard).
