# Membership: burn to join, capped weekly data

Decided by the operator on 17 October 2026. This replaces the holding-based weekly allowance,
where every holder's credit was proportional to their share of the supply, and the earlier plan
for a refundable enrolment escrow. Nothing here is live until the token launches and purchases
are switched on (`REDEMPTIONS_ENABLED=1`).

## The rules

- **Joining.** A wallet becomes a member by sending at least 100,000 OTT to the burn address
  `0x000000000000000000000000000000000000dEaD`. A transfer to the zero address also counts, in
  case the token's own `burn()` emits one. Burns from the same wallet add up, so two burns of
  50,000 also qualify. Burned tokens can't be refunded. Each wallet has one membership; burning
  more doesn't add a second share. Memberships don't expire.
- **Welcome eSIM.** Each member can claim one welcome eSIM: any 1 GB, 7-day plan priced at $4
  or less. That is 27 of the 28 places in the catalogue; the $8.99 Global plan is excluded. The
  reserve pays for it, so it doesn't use weekly credit, and the claim never expires.
- **Weekly data.** 80% of last week's trading tax is this week's member budget. It is split
  among wallets that were members at the week's snapshot (Monday 00:00 UTC):
  - Each member's share is proportional to the OTT it holds at the snapshot.
  - No member gets more than 3× the average share, which is the budget divided by the number of
    members.
  - The amount above a capped member's limit is shared among the other members by holdings.
  - Anything that can't be placed stays in the pool, for example when every uncapped member
    holds no OTT.

  Non-members get no weekly credit, however much they hold. A new member's weekly share starts
  from the next snapshot. Weekly credit still expires at the end of the week.
- **Reserve.** The other 20% of the tax stays in the pool. It pays for welcome eSIMs, Lightning
  routing fees and the swap into sats.
- **When the app offers the burn.** The app only offers the burn when all of these hold:
  membership is configured, purchases are on, the treasury reports the pool as `funded`, and the
  pool's balance minus what this week still owes members covers one welcome eSIM at the maximum
  price. If many people join at once, a claim can still fail for lack of funds. The membership
  remains, and the eSIM can be claimed after the next top-up.

## Configuration

`site/config/esim.json`:

```json
"budgetBps": 8000,
"membership": {
  "burnTokens": "100000",
  "burnAddress": "0x000000000000000000000000000000000000dEaD",
  "capMultiple": 3,
  "welcome": { "gb": 1, "days": 7, "maxUsd": 4 }
}
```

Without a `membership` block, the indexer falls back to the older rule: every holder,
proportional to holdings. The API then reports `membership.configured: false` and refuses welcome
claims.

## Where each rule lives

- `site/api/_lib/membership.js` holds the rules themselves: config validation, burn folding,
  the capped split, welcome-plan eligibility and the burn-receipt check. The indexer and the API
  both use it.
- `scripts/allowances.js` writes members and each member's weekly share into
  `site/data/allowances.json`.
- `site/api/redeem.js` reports a wallet's membership and handles the welcome claim.
- In the browser, `site/esim.js` builds the burn transaction and the signed welcome message, and
  shows membership in the account panel used by both `#/data` and the app's eSIMs screen.

## Data contract

### `site/data/allowances.json`

When the coin is launched and membership is configured, the ledger adds:

```json
"membership": {
  "burnTokens": "100000",
  "burnUnits": "100000000000000000000000",
  "burnAddress": "0x000000000000000000000000000000000000dead",
  "capMultiple": 3,
  "members": 12,
  "capUsd": 25,
  "allocatedUsd": 74.9999,
  "unallocatedUsd": 0.0001
},
"members": {
  "0x…": { "burned": "100000000000000000000000", "sinceBlock": 86500123, "tx": "0x…" }
}
```

- `membership.members` counts the members at the snapshot, the ones sharing this week's budget.
- `members` lists every member up to the ledger's head `block`, including wallets that joined
  after the snapshot. `sinceBlock` and `tx` identify the burn that took the wallet past the
  threshold. (It isn't named `block` because the ledger's change check ignores every field
  called `block`, nested ones included.)
- Each row in `wallets` gains `member: true | false`, which means "member at the snapshot".
  `allowanceUsd` is that member's capped share, or 0 for a non-member.
- `share` is still the wallet's fraction of the circulating supply. It is shown for information;
  it no longer sets the allowance.
- Burned tokens are excluded from the circulating supply.
- Before launch, the empty ledger carries `"membership": null` and `"members": {}`.

### `GET /api/redeem?address=0x…`

The standing gains a `membership` object:

```json
"membership": {
  "configured": true,
  "burnTokens": "100000",
  "burnUnits": "100000000000000000000000",
  "burnAddress": "0x000000000000000000000000000000000000dEaD",
  "coin": "0x…",
  "welcome": { "gb": 1, "days": 7, "maxUsd": 4 },
  "capMultiple": 3,
  "member": true,
  "memberSinceBlock": 86500123,
  "sharing": false,
  "welcomeOrder": null,
  "enrolment": { "open": true, "reason": "" }
}
```

- `member` comes from the ledger's `members` map. A burn newer than the ledger shows as
  `member: false` until the indexer runs again, but the welcome claim below can prove it
  directly.
- `sharing` is true when the wallet is in this week's split.
- `welcomeOrder` is the welcome order in the same shape as `orders[]` entries, with `welcome:
  true` and `week: null`. Like every order, its activation codes appear only in a signed
  response.
- `burnUnits` is `null` while the ledger's `decimals` don't belong to the configured coin. In
  that state `enrolment.open` is false.
- `enrolment.reason` is a short sentence saying why joining is closed, or empty when it's open.
- Without a membership block, the object is just `{ "configured": false }`.

### `POST /api/redeem`: claiming the welcome eSIM

```json
{ "address": "0x…", "message": "…", "signature": "0x…", "welcome": true, "packageCode": "fixed_1GB_7D_AU", "burnTx": "0x…" }
```

The signed message, one item per line:

```text
OT+T — claim my welcome eSIM
Site: <frontend host>
Wallet: <lowercase address>
Plan: <packageCode>
Issued: <unix seconds>
```

The signature has the same 10-minute window and site check as other signed requests. The wallet
counts as a member when either:
- the ledger's `members` map lists it; or
- `burnTx` names a successful transaction on this chain whose logs move at least `burnUnits` of
  the coin from this wallet to the burn address or the zero address. One transaction must carry
  the full amount. A burn split across several transactions waits for the ledger.

The welcome order id is `'ott-' + keccak256(address + ':welcome:0')[0..32]`. It is fixed
forever, like the weekly ids. A repeated claim for the same plan returns the existing order with
`replayed: true`; a claim for a different plan gets a 409.

| Status | Meaning |
| --- | --- |
| 200 | `{ ok, order, sims, replayed? }`, with codes for that order's profile only |
| 400 | `unknown package`, or `this plan is not included with membership` |
| 401 | a signature or message problem, as for other signed requests |
| 409 | `burn 100,000 OTT to join first`, `the burn transaction was not found or did not burn enough OTT`, `your welcome eSIM has already been claimed`, or `coin not launched yet` |
| 503 | `data redemption is not enabled yet`, `membership is not configured`, or a provider or payment failure, which can be retried |

## In the app

The account panel decides what to show from `membership`:
- **Not a member, enrolment open:** a Join button. It explains the 100,000 OTT burn, the welcome
  eSIM and the capped weekly share, says plainly that the burn can't be undone, and asks for
  confirmation.
- **Not a member, enrolment closed:** the reason, and no button.
- **Member without a welcome order:** the welcome plan picker, limited to eligible plans.
- **Weekly credit:** shown as before, with a note that it follows holdings and is capped.

The burn is an ordinary ERC-20 `transfer(burnAddress, burnUnits)` on the coin, sent from the
member's wallet with `eth_sendTransaction`. The app waits for the receipt, then claims the
welcome eSIM with that transaction hash. Because a burn can't be undone, the app checks four
things before asking the wallet to send:

- **The burn matches the published config.** The coin, burn address and burn amount in the
  API's answer must match the site's own `config/esim.json`. When the published ledger is about
  the coin, `burnUnits` must also match its decimals. A compromised API host alone therefore
  can't redirect a member's tokens.
- **There's no earlier burn.** The app scans the blocks after the ledger's head for a burn this
  wallet already made. If it finds one, it uses that burn instead of sending another.
- **The wallet holds enough.** It checks the live balance first.
- **The holder has confirmed.** A checkbox says the burn is permanent.

Once a burn is sent, the page offers only a status check, never a second burn. A confirmed burn's
transaction hash is kept in the browser (`localStorage`, key `ott-membership-burn:<address>`, which
is public chain data), so reloading the page can't invite a second burn. The hash is forgotten if
the API rejects it.
