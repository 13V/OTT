# Membership: join by burning about $5 of OTT, capped weekly data

Decided by the operator on 17 October 2026, for the coin's launch on pump.fun (Solana). It
replaces the earlier Robinhood Chain plan (a fixed 100,000 OTT burn to `0x…dEaD`, and a 10% USDG
creator tax). Nothing here is live until the coin launches and purchases are switched on
(`REDEMPTIONS_ENABLED=1`).

## The rules

- **Joining.** A wallet becomes a member by sending OTT to Solana's burn address, the
  incinerator `1nc1nerator11111111111111111111111111111111`. Nobody holds that address's key, so
  the tokens can never move again. The amount is about $5 of OTT, set once a week from the coin's
  price (see "The join amount" below). Sends from the same wallet add up. Each wallet has one
  membership; sending more doesn't add a second share. Memberships don't expire, and nothing is
  refunded.
- **Welcome eSIM.** Each member can claim one welcome eSIM: any 1 GB, 7-day plan priced at $4
  or less. That is 27 of the 28 places in the catalogue; the $8.99 Global plan is excluded. The
  reserve pays for it, so it doesn't use weekly credit, and the claim never expires.
- **Weekly data.** 80% of the creator fees collected last week is this week's member budget. It
  is split among wallets that were members at the week's snapshot (Monday 00:00 UTC):
  - Each member's share is proportional to the OTT it holds at the snapshot.
  - No member gets more than 3× the average share, which is the budget divided by the number of
    members.
  - The amount above a capped member's limit is shared among the other members by holdings.
  - Anything that can't be placed stays in the pool, for example when every uncapped member
    holds no OTT.

  Non-members get no weekly credit, however much they hold. A new member's weekly share starts
  from the next snapshot. Weekly credit expires at the end of the week.
- **Reserve.** The other 20% of the fees stays in the pool. It pays for welcome eSIMs, Lightning
  routing fees and the swap into sats.
- **When the app offers the join.** Only when all of these hold: membership is configured, the
  coin is launched, purchases are on, this week's ledger is published with this week's join
  amount, and the pool's balance minus what this week still owes members covers one welcome eSIM
  at the maximum price. The balance is read live from the provider when it can be (shared for a
  minute), from the treasury report otherwise; what is owed comes from the treasury report. The
  report's status word (`low`, say) doesn't close joining: it is about runway, and every welcome
  paid would count towards it.
- **Welcome eSIMs never spend weekly credit.** A welcome claim checks the same surplus again,
  live, for the plan it names. Weekly credit expires on Monday and a welcome claim never does, so
  when the pool can't cover both, the welcome waits: the claim is refused with nothing ordered,
  the membership remains, and the same claim goes through after the next top-up.

### The join amount

`burnUsd` dollars of OTT (5), fixed for the week:

- At its first run each week, the ledger keeper reads OTT's price from pump.fun on chain (the
  bonding curve before graduation, the PumpSwap pool after) and SOL's price in dollars, and sets
  `burnTokens = burnUsd / priceUsd`, rounded **up** to two significant figures, in whole tokens,
  and never more than 2% of the supply. The week's amount never changes after that.
- A send counts against the amount of the week it landed in (its block time). In the first ten
  minutes of a week, the lower of that week's and the previous week's amounts applies, so a send
  signed just before Monday isn't caught out by the new amount.
- A wallet becomes a member at the first send after which its running total reaches the amount
  for that send's week. Later sends only add to `burned`.
- A send made in a week the keeper never priced counts against the most recent earlier week's
  amount, or, before the first week ever priced (a coin launched late on a Sunday, say), the first
  amount priced. The keeper records those filled-in weeks in `requirements` too, so the API judges
  a send the same way.

### The money

pump.fun has no custom tax. Its creator fee is 0.30% of each trade on the bonding curve; after
graduation it is 0.95% at 420–1,470 SOL market cap, stepping down to 0.05% for the largest coins
(https://pump.fun/docs/fees). Fees are paid in SOL into creator vaults, and leave them only when
someone collects them; collecting is permissionless and always pays the creator wallet, which is
OT+T's treasury.

The budget for week w is `budgetBps` (8000) of the dollar value of creator fees **collected into
the treasury during week w − 1**: every treasury transaction that drew down one of its pump.fun
creator vaults, valued at SOL's hourly price when it landed.

## Configuration

`site/config/esim.json`:

```json
"chain": "solana",
"coin": "",
"tokenProgram": "",
"treasury": "",
"budgetBps": 8000,
"membership": {
  "burnUsd": 5,
  "burnOwner": "1nc1nerator11111111111111111111111111111111",
  "burnAccount": "",
  "capMultiple": 3,
  "welcome": { "gb": 1, "days": 7, "maxUsd": 4 }
}
```

- `coin` is OTT's mint, `tokenProgram` the program that owns it (new pump.fun coins use
  Token-2022, `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), and `treasury` the wallet that
  created the coin on pump.fun. All three are filled in on launch day.
- `burnAccount` is the incinerator's associated token account for the coin, derived from `coin`
  and `tokenProgram`. `npm run lint` re-derives it and fails on a mismatch.
- The coin counts as launched when `coin`, `tokenProgram`, `treasury` and `burnAccount` are all
  filled in.

## Reading the chain

The keeper reads three histories: the incinerator account's (joins), each member's token
accounts' (holdings at the snapshot) and the treasury's (collected fees). Those reads need an RPC
endpoint that keeps the whole ledger. PublicNode keeps about two days and answers an older
history with an empty list rather than an error, which would read as no members and no fees. So
the keeper asks each endpoint for its first available block and sends history reads only to
endpoints that keep everything (`api.mainnet-beta.solana.com` does), spaced out and retried on
rate limits. With none available it refuses to run rather than publish a wrong ledger. Set
`SOLANA_RPC_URL` to a dedicated full-history endpoint for production.

A run that only moves a cursor (`membership.cursor`, `fees.cursor`) doesn't rewrite the file, so
unrelated transactions on those accounts don't commit every half hour; the next run reads them
again and finds nothing new.

## Where each rule lives

- `site/solana.js`: base58, addresses, program-derived and associated token addresses, the
  instructions OT+T builds, and reading jsonParsed transactions. The browser, the API and the
  keepers all use it.
- `site/api/_lib/membership.js`: the rules themselves: config validation, the join amount and
  its rounding, which transfers count as a join, folding joins into members, the capped split
  and welcome-plan eligibility.
- `scripts/allowances.js`: sets the week's join amount, finds members, reads their holdings at
  the snapshot, sums last week's collected fees and writes `site/data/allowances.json`.
- `site/api/redeem.js`: reports a wallet's membership and handles the welcome claim.
- `site/esim.js`: builds the join transaction and the signed messages, and shows membership in
  the account panel used by both `#/data` and the app's eSIMs screen.

## Data contract

### `site/data/allowances.json`

```json
{
  "asOf": 1792245000,
  "slot": 458061508,
  "chain": "solana",
  "week": 2962, "weekStart": 1791763200, "weekEnd": 1792368000,
  "coin": "<mint>", "tokenProgram": "<program>", "decimals": 6, "treasury": "<wallet>",
  "budgetUsd": 12.5,
  "budgetSource": "creator fees collected in week 2961",
  "fees": {
    "weekUsd": { "2961": 15.625 },
    "collections": [ { "tx": "<signature>", "at": 1791800000, "slot": 457000000, "lamports": "150000000", "solUsd": 104.17, "usd": 15.625 } ],
    "cursor": { "signature": "<signature>", "slot": 457000000 }
  },
  "membership": {
    "burnUsd": 5,
    "burnOwner": "1nc1nerator11111111111111111111111111111111",
    "burnAccount": "<incinerator's OTT account>",
    "capMultiple": 3,
    "requirement": { "week": 2962, "burnTokens": "1800000", "burnUnits": "1800000000000", "priceUsd": 0.0000029, "solUsd": 103.75, "source": "bonding-curve", "at": 1791764000 },
    "requirements": { "2962": "1800000000000" },
    "members": 2,
    "capUsd": 18.75, "allocatedUsd": 12.5, "unallocatedUsd": 0,
    "cursor": { "signature": "<signature>", "slot": 458000000 }
  },
  "members": {
    "<wallet>": { "burned": "1800000000000", "since": { "at": 1791770000, "slot": 457100000, "tx": "<signature>" } }
  },
  "joins": {
    "<wallet>": { "burned": "900000000000", "last": { "at": 1791780000, "slot": 457200000, "tx": "<signature>" } }
  },
  "holders": 2,
  "memberTokens": "5000000000000",
  "wallets": {
    "<wallet>": { "tokens": "3000000000000", "share": 0.6, "allowanceUsd": 6.25, "member": true }
  }
}
```

- `slot` is the chain head when the file was written. Like `asOf`, it is ignored when deciding
  whether the file changed.
- `membership.requirement` is this week's join amount, or `null` until the keeper has priced the
  coin this week. `requirements` maps each priced week to its amount in base units; it is carried
  forward from file to file.
- `members` lists every member up to the ledger's `slot`, including wallets that joined after the
  snapshot. `since` identifies the send that took the wallet over the amount. `joins` lists
  wallets that have sent OTT to the incinerator but not yet enough.
- `membership.cursor` is the newest transaction on `burnAccount` the keeper has read; the next run
  reads only what came after it. `fees.cursor` is the same for the treasury's history.
- `wallets` lists only the members at the snapshot: `tokens` is the OTT the wallet held at the
  snapshot, `share` its fraction of `memberTokens` (all those members' OTT together) and
  `allowanceUsd` its capped share of `budgetUsd`. A member that held no OTT at the snapshot is
  listed with `tokens` "0" and no allowance.
- Before launch, the empty ledger has `"membership": null`, `"fees": null`, `"members": {}`,
  `"joins": {}`, `"wallets": {}`, and empty `coin`, `tokenProgram` and `treasury`.

Who counts as the sender: in a successful transaction, the incinerator's account (`burnAccount`)
gains OTT, and exactly one owner's OTT accounts lose OTT. That owner is credited with the amount
the incinerator's account gained. The owner must be an ordinary wallet (a key on the ed25519
curve, so no program account), and not the treasury. Anything else (no sender, several senders)
is skipped and logged.

### `GET /api/redeem?address=<wallet>`

`address` is a base58 Solana address, case-sensitive. The standing gains a `membership` object:

```json
"membership": {
  "configured": true,
  "coin": "<mint>", "tokenProgram": "<program>", "decimals": 6,
  "burnOwner": "1nc1nerator11111111111111111111111111111111",
  "burnAccount": "<incinerator's OTT account>",
  "burnUsd": 5,
  "requirement": { "week": 2962, "burnTokens": "1800000", "burnUnits": "1800000000000", "priceUsd": 0.0000029 },
  "burned": "0",
  "welcome": { "gb": 1, "days": 7, "maxUsd": 4 },
  "capMultiple": 3,
  "member": false,
  "memberSince": null,
  "sharing": false,
  "welcomeOrder": null,
  "enrolment": { "open": true, "reason": "" }
}
```

- `member` and `memberSince` (`{ at, slot, tx }`) come from the ledger's `members`. A join newer
  than the ledger shows as `member: false` until the keeper runs again, but the welcome claim
  below can prove it directly.
- `burned` is what the ledger has counted from this wallet so far, in base units.
- `requirement` is `null` while the ledger has no amount for the current week; then
  `enrolment.open` is false.
- `sharing` is true when the wallet is in this week's split.
- `welcomeOrder` is the welcome order in the same shape as `orders[]` entries, with `welcome:
  true` and `week: null`. Like every order, its activation codes appear only in a signed
  response.
- `enrolment.reason` is a short sentence saying why joining is closed, or empty when it's open.
- Without a membership block, the object is just `{ "configured": false }`.

### Signed requests

Every signed request (a read, a weekly redemption or a welcome claim) carries
`{ address, message, signature }`. `signature` is the wallet's ed25519 signature over the UTF-8
bytes of `message`, base58-encoded (64 bytes). The message, one item per line:

```text
OT+T — claim my welcome eSIM
Site: <frontend host>
Wallet: <base58 address, exactly as in the request>
Plan: <packageCode>
Issued: <unix seconds>
```

The first line names the action: `OT+T — show my eSIM codes` (a read; no Plan or Slot),
`OT+T — authorise a data redemption` (Plan and `Slot: <n>`), or the welcome line above (Plan, no
Slot). The window is 10 minutes, and the site must be a known frontend host, as before. The API
accepts exactly these lines in this order: an added, repeated or reordered line, or a Windows line
ending, is refused, so a signature can't be passed off inside other text.

Order ids keep their formula exactly: the nth weekly order is
`'ott-' + keccak256(address.toLowerCase() + ':' + week + ':' + n)[0..32]` and the welcome order
`'ott-' + keccak256(address.toLowerCase() + ':welcome:0')[0..32]`. (Lowercasing a base58 address
keeps ids unique in practice: two wallets would have to differ only in letter case.)

### `POST /api/redeem`: claiming the welcome eSIM

```json
{ "address": "<wallet>", "message": "…", "signature": "<base58>", "welcome": true, "packageCode": "fixed_1GB_7D_AU", "joinTx": "<signature>" }
```

The wallet counts as a member when either:
- the ledger's `members` map lists it; or
- `joinTx` names a successful transaction, newer than the ledger's `membership.cursor`, in which
  this wallet sent OTT to `burnAccount` (by the rule above), and the ledger's `joins` total for
  the wallet plus that amount reaches the amount for the transaction's week.

A repeated claim for the same plan returns the existing order with `replayed: true`; a claim for
a different plan gets a 409.

| Status | Meaning |
| --- | --- |
| 200 | `{ ok, order, sims, replayed? }`, with codes for that order's profile only |
| 400 | `unknown package`, `this plan is not included with membership`, or `joinTx must be a transaction signature` |
| 401 | a signature or message problem, as for other signed requests |
| 409 | `join OT+T first`, `the join transaction did not make this wallet a member: it failed, sent too little OTT, or came from another wallet`, `your welcome eSIM has already been claimed`, or `coin not launched yet` |
| 503 | `data redemption is not enabled yet`, `membership is not configured`, a provider or payment failure, or one of the answers below; all can be retried |

Four 503 answers mean nothing was ordered and the membership (or the burn) still counts, so the
app keeps the burn it remembers and offers the same claim again:
- `your burn isn’t visible to the server yet; it’s safe, so try again in a moment`: no endpoint
  returns `joinTx` yet (or not with its block time). A 409 is only ever an answer about a
  transaction the API has read.
- `your burn landed in a week whose join amount isn’t set yet; it’s safe, so try again after the next ledger update`
- `the reserve can’t pay for a welcome eSIM right now; your membership is kept, so try again after the next top-up`
- `the reserve that pays for welcome eSIMs can’t be confirmed right now; your membership is kept, so try again in a moment`

## In the app

The account panel decides what to show from `membership`:
- **Not a member, enrolment open:** a Join button. It shows this week's amount in OTT and in
  dollars, the welcome eSIM and the capped weekly share, says plainly that the tokens can't be
  recovered, and asks for confirmation.
- **Not a member, enrolment closed:** the reason, and no button.
- **Member without a welcome order:** the welcome plan picker, limited to eligible plans.
- **Weekly credit:** shown as before, with a note that it follows holdings and is capped.

The join is one transaction, built in the browser and signed by the wallet:
`CreateIdempotent` for the incinerator's OTT account (a no-op once it exists) and a
`TransferChecked` of `requirement.burnUnits` from the wallet's own OTT account to `burnAccount`,
with a small priority fee. Before asking the wallet, the app checks:

- **The destination is the incinerator's.** `coin`, `tokenProgram` and `burnAccount` from the API
  must match the site's own `config/esim.json`, and `burnAccount` must re-derive as the
  incinerator's associated account for the coin. A compromised API host alone can't redirect a
  member's tokens.
- **The amount is sane.** `requirement.burnUnits` must be positive and at most 2% of the supply,
  and the confirmation shows it in OTT and in dollars at the published price.
- **There's no earlier join.** The app reads the incinerator account's transactions newer than
  the ledger's cursor and looks for one from this wallet. If it finds one, it uses that instead of
  sending another.
- **The wallet holds enough.** It reads the wallet's OTT account balance first.
- **The holder has confirmed.** A checkbox says the tokens can't be recovered.

Once a join is sent, the page offers only a status check, never a second send. A confirmed join's
transaction signature is kept in the browser (`localStorage`, key `ott-membership-join:<address>`,
which is public chain data), so reloading the page can't invite a second join. The signature is
forgotten if the API rejects it.
