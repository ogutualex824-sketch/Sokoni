# Repair 3 — one reason authority for disputes, returns and refunds

**Branch:** `repair-3/canonical-reason-authority` (from main line `7261b76`) · **NOT landed, NOT deployed**
**Programme:** Refund + Seller Accountability, repair 3 of 5 · **Related:** [[R1-dispute-settlement-hold]] · [[R2-canonical-dispute-identity]]

## The defect — four vocabularies for "why"

| where | reasons |
|---|---|
| `disputes.js` | 8 codes, including `overcharged` |
| `returns-engine.js` | 6 codes, including `changed_mind` and `damaged_in_transit` |
| `returns.html` | a **third** set: Title-Case display strings as values (`"Defective"`, `"Damaged in transit"`) |
| merchant dispute labels | include **`late_delivery`**, which the server never accepted, so it could never appear on a dispute |

Production holds **no** dispute, return or refund-request documents, so no stored value constrained the choice.

## The authority — `functions/refund-reasons.js`

11 canonical codes, built only from reasons that already existed plus the two refund causes the approved policy
names:

`not_received` · `not_as_described` · `counterfeit` · `wrong_item` · `damaged` · `defective` · `billing_error` ·
`buyer_request` · `seller_cancelled` · `seller_failed_to_dispatch` · `other`

- **Old spellings are accepted as input aliases and always stored canonical:** `overcharged → billing_error`,
  `changed_mind → buyer_request`, `damaged_in_transit → damaged`. A buyer cannot know where damage happened; its
  cause is an investigation finding.
- **What each surface accepts is preserved exactly.** Disputes accept the same 8 situations and returns the same 6;
  only the spelling is unified. The two policy causes are refund-only (system-assigned).
- **No fault or money classification.** Who is liable for a reason is decided later from evidence (H2), never from
  the label a buyer picked.

**Consumers:** `disputes.js` and `returns-engine.js` (their own enums deleted), `automation-engine.js` (the
canonical constant), and the refund authority (an **optional** `reasonCode`, validated and stored canonical,
through `refundToWallet` and the FOS pair; H2 will make it required). The pages use canonical codes and labels:
`dispute-portal.html`, `returns.html` and `sokoni-merchant-disputes.js` (phantom removed, all codes labelled).
`sokoni-refund-reasons.js` is the browser mirror, **drift-tested** against the authority.

## Evidence — `scripts/test-refund-reasons.js`

| target | result |
|---|---|
| repaired | **21 / 0**: authority well-formed; each surface's accepted set equals the old set, canonicalised; mirror, pages and merchant labels agree to the letter; no second server enum; disputes, returns and refunds **store canonical codes** through the real callables; an unknown refund reason is refused before any write |
| **old code** (`7261b76`) | **10 / 12 FAIL**: two server enums; Title-Case returns values; phantom `late_delivery`; `overcharged`, `changed_mind` and `damaged_in_transit` **stored as-is**; refund reason codes unvalidated. The old surfaces are judged against the current authority, so every drift check is evaluated, not skipped |

**Regressions: none.**
- R1 39/0, R2 26/0, `test-settled-case-guard` 66/0, `test-refund-authority` 55/0, `test-refund-escrow-binding` 13/0.
- R2's automation check now accepts the canonical constant on its right-hand side. It still **fails on the pre-R2
  tree**.
- 15 static suites have identical failing sets vs `7261b76`.

## Found, not changed

- **`test-auth-verify-gate` fails on the main line itself.** `realtime-harness.html`, added by commit `798a85b`
  (another workstream), is a page outside the auth choke point. It is pre-existing and reproduced at `7261b76`
  with git history, so it is not a Repair 3 regression. Reported for its owner.
- **`returns-engine.submitReturn` has the identity defect Repair 2 fixed for disputes.** It accepts only
  `order.buyerId`/`userId` and writes `buyerId`/`sellerId`, so real buyers cannot submit returns. That is
  **Repair 4** (returns via the server authority).
