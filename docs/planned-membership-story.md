# Membership: public story

The homepage, About page, app prelaunch introduction and sample account describe the membership
model: a one-time OTT burn enrols a member and includes their first eSIM, and collected trading
fees then fund ongoing member data, with no further burn for each package.

On 17 October 2026 the operator settled the open terms, and the backend now implements them. The
rules and the data contract are in [membership.md](membership.md):

- **Burn:** 100,000 OTT, sent straight to the burn address. There is no escrow, so a burn can't
  be refunded. The app offers the burn only while the reserve can pay for a welcome eSIM.
- **First eSIM:** any 1 GB, 7-day plan costing $4 or less.
- **Ongoing data:** 80% of each week's tax, split among members by holdings, with no member above
  3× the average share.
- **Membership:** one per wallet, and it doesn't expire.

The earlier calculator illustrated an equal split: daily fees × 7 × data allocation ÷ enrolled
users. The average share is still that figure, but a member's actual share now follows their
holdings, up to the 3× cap.

Enrolment stays closed until the token launches and purchases are switched on. The Trust section
lists independent review, reserve approvals and public reporting as pending. It separates
on-chain evidence from reported external-provider balances and keeps activation codes private.
The funded phone test passed on 17 October 2026: the supplier's eSIM installed and gave mobile
data on the operator's phone in Australia. That test bought the eSIM directly from the supplier,
so it didn't exercise OTT's automated Lightning payment.

The illustration keeps the existing character identity and the requested standing pose, holding
an eSIM pass and an OTT token with a sculpted clay flame. The final prompt and tool mode are
recorded in `membership-art-direction.md`.
