# POS Q0c-3 — `sendPOSReceipt`: a till sale's receipt, from the server's record, to the customer on record (main line)

**Branch:** `pos-safety/q0c3-pos-receipt` (from main Q0c-2 `a63f6de`) · **not deployed**
**Owner authorization (2026-09-27):** Q0c-3 as its own unit, the last Q0c relay; SMS and email repaired together.
1. **Scope — till receipts only.** `posReceipts/{saleId}` and `posRetailSales/{saleId}` must both exist and name the
   same merchant. Subscription, marketplace-order, `receipts` and other receipt products fail closed.
2. **Sender** — the till customer authority `_provenCustomerOwners` with `customers`: the owner, till staff, and business
   members holding `customers`. **No admin override**, deliberately (see below).
3. **Contact** — ONLY from the `posCustomers` record the sale names. It must exist, be owned by the proven merchant and
   carry the channel's contact; otherwise fail closed. The browser-copied phone on the sale is never used.
4. **Repeat sends** — at most 3 per sale per channel, reserved in a transaction before dispatch; the 4th is refused
   without sending. Every attempt is audited with hashed identifiers.
- **Out of scope:** the `pos-customers.js` receipt client (its own client unit); notification delivery certification;
  deployment. "The existing UI sends successfully" is not a success criterion.

**Related:** [[POS-Q0c2-pos-send-sms]] · [[POS-Q0c1-sms-enqueue-admin]] · [[POS-Q0b1-customer-scope]]

## The defect

The deployed `sendPOSReceipt` took the recipient (`phone` or `email`) AND the whole receipt (`sale`: shop name, receipt
number, item names, quantities, totals) from the caller. Any signed-in account could therefore send any text, by SMS or
by email from `receipts@mysokoni.co.ke`, to anyone, under any shop name — a brand-spoofing relay on both channels.
No client calls it: `pos-customers.js` defines receipt helpers that nothing invokes.

## The repair — `functions/pos-retail.js` (`sendPOSReceipt` only)

The request is now `{ saleId, channel: 'sms' | 'email' }`. Any other field (`phone`, `email`, `sale`, …) is ignored.

| Step | Rule | Refusal |
|---|---|---|
| Till sale | `posReceipts/{saleId}` and `posRetailSales/{saleId}` both exist, same `merchantId` | `not-found` |
| Sender | `_provenCustomerOwners(caller, merchantId)` (`customers`) — no admin path | `permission-denied` |
| Recipient | `posCustomers/{sale.customer.id}` classified `owned` by that merchant (`pos-customer-scope`), with a canonical phone (SMS) or a valid email (email) | `failed-precondition` |
| Repeat sends | `posReceiptSends/{sha256(merchant\|sale\|channel)}` count < 3, incremented in a transaction before dispatch | `resource-exhausted` |
| Content | ONE model (`_receiptModel`) from the `posReceipts` doc — receipt number, product names, server prices and totals — plus the shop/business name from the server's own record; rendered by `_receiptSms` and `_receiptEmailHtml` | — |
| Audit | `auditLogs` type `posSendReceipt`: caller, hashed sale and customer refs, channel, attempt, outcome | — |

Audit outcomes: `sent`, `provider_failed`, `refused_not_a_till_sale`, `refused_unproven_merchant`,
`refused_no_owned_customer`, `refused_no_contact_for_channel`, `refused_send_limit`, `refused_limit_unavailable`.
No phone number, email address or raw sale id is stored.

**`sent` means the provider accepted the message. It is not evidence of delivery** — that is the separate notification
delivery certification.

**No admin override.** The till customer authority has none, and adding one would introduce a second seller authority
for receipts. An admin who is not the merchant is refused like anyone else. Support staff who need to resend a receipt
need a separate, audited admin tool — a future decision, not an implicit bypass.

The function keeps its name, region, secrets, `maxInstances`, `cors` and `enforceAppCheck`, and `pos-retail.js` still
exports exactly its four survivors (`test-retire-18b`).

## Evidence — `scripts/test-q0c3-pos-receipt.js`

Emulator suite. Africa's Talking (`sokoni-at`) and SendGrid (`@sendgrid/mail`) are replaced IN-PROCESS by recorders
before the handler loads — **nothing is sent**, and the suite refuses to run if either stub is not the one the handler
calls. Every request also carries the old contract's forged `phone`, `email` and `sale`, so the old tree demonstrates
the defect (it sends to them) instead of refusing on shape.

**29/0 new vs 0/29 old** (old = export of `a63f6de`). On the old tree every failure is the relay itself, never a shape refusal:
- 25 tests (F, X, S, L-1) saw the message go to `+254700000666` / `victim@evil.test`;
- D-1 and H-1 got the caller's forged content instead of the receipt;
- L-2 sent all 5 concurrent requests;
- A-1 found no audit at all.

Each channel is proven independently:

| Proof | SMS | Email |
|---|---|---|
| forged recipient + forged receipt, no sale → nothing sent | F-1s | F-1e |
| walk-in sale + forged recipient → refused | F-2s | F-2e |
| real sale + forged recipient + forged contents → sent only to the customer on record, with server content (not the sale's browser phone) | F-3s | F-3e |
| another merchant's sale | X-1s | X-1e |
| stranger | X-2s | X-2e |
| business member without `customers` | X-3s | X-3e |
| admin naming another seller (no override) | X-4s | X-4e |
| subscription receipt (posReceipts, no till sale) | X-5s | X-5e |
| receipt and sale naming different merchants | X-6s | X-6e |
| own sale naming another merchant's customer → fail closed | X-7s | X-7e |

Also:
- **X-8 / X-9:** a customer with no phone → SMS fails closed; the same customer's email still sends.
- **S-1 / S-2:** the shop's cashier and a business member with `customers` send.
- **D-1:** the SMS and the email for one sale carry the same receipt number, shop, item names, line totals and total.
- **H-1:** an HTML-bearing product name is inert in the email.
- **L-1:** the 3rd send goes out, the 4th is refused without sending, and email counts separately.
- **L-2:** 5 concurrent requests → exactly 3 sent.
- **A-1:** every outcome is audited with no contact data.

**Mutants — 15, each caught:**

| Mutant | Caught by |
|---|---|
| till-scope-dropped | X-5, X-6, A-1 |
| merchant-match-dropped | X-6 |
| proof-skipped | X-1..X-4, S-2, D-1, L-1, A-1 |
| admin-override-added | X-4 |
| customer-ownership-unchecked | X-7 |
| browser-phone-fallback | X-7s, X-8, A-1 |
| caller-recipient-accepted | F-2, F-3, X-7, X-8, X-9, S-1, D-1, A-1 |
| caller-content-accepted | F-3, S-2, D-1, H-1 |
| sms-own-source | F-3s, D-1 |
| email-unescaped | H-1 |
| send-cap-removed | L-1, L-2, A-1 |
| send-cap-not-transactional | L-2 |
| cap-shared-across-channels | L-1 |
| audit-stores-contact | A-1 |
| refusals-unaudited | A-1 |

**Regression floor:** 53 suites, identical to `a63f6de`. That is the Q0c-2 floor plus `test-merchant-tax`,
`test-retire-18b` and `census-devices-authority`, the other suites that inspect `sendPOSReceipt`/`posReceipts`.

- Full logs, not just tallies, were compared. The only differences are random ids, worktree paths, and `rc-manifest`
  listing this unit's uncommitted file.
- A first draft that exported the handler through `exports._h` failed `test-retire-18b` ("exactly the 4 surviving
  functions"). It also made `census-merchant-2d2-authority` misread the function as having no auth, because the census
  reads the `onCall` body. Both were caught by the full-log comparison. The handler is now inline, matching the file's
  idiom, and both suites match the old tree.
- `test-notify-booking-types` passed 9/9 on both trees (node_modules junction).

**Chain:** every prior emulator unit passes on both trees, each in its own fresh project:
- `test-0b-checkout-integrity` 31/0;
- Q0a 26/0;
- Q0b-1 40/0;
- 2a 23/0;
- 2b 13/0;
- 2c 16/0;
- 2d 20/0;
- Q0c-1 13/0;
- Q0c-2 20/0.

## Production impact (read-only census, 2026-09-27)

- `sendPOSReceipt` is deployed and has **no client caller**, so no legitimate path depended on the relay.
- Counts: `posRetailSales` 5; `posReceipts` 12 (6 field shapes — a multi-writer collection, hence the till-only rule);
  `posCustomers` **0**.
- **So today zero sales are eligible for a receipt send.** Every till sale is a walk-in in customer terms, and the
  repaired function correctly refuses all of them. This is a certification finding, not a defect: receipts become
  sendable only once till customers exist as owned `posCustomers` records.

## Boundaries and findings (NOT fixed here)

- **`pos-customers.js` receipt client** (`sendSMSReceipt`/`sendEmailReceipt` still build the old payload): a separate
  client unit.
- **Admin resend tool:** deliberately absent (see above); an owner decision if support needs one.
- **Q0c-2 evidence defect (found here):**
  - Q0c-2's `quota-not-transactional` mutant rewrote the transaction as `await (async (t) => {…});`, which never calls
    the function. It therefore removed the daily quota outright rather than de-transactioning it, and "caught" the
    wrong thing.
  - A corrected mutant (read and write outside a transaction, actually invoked) **survives** the committed Q0c-2 suite
    at 20/0: Q-2's two requests do different pre-quota work and reach the quota read one after the other, so they never
    race.
  - The Q0c-2 code IS transactional; only its concurrency proof is weak. Strengthening Q-2 is a small unit of its own
    (committed tests are not edited here).
- **Notification delivery certification:** a separate workstream.
- **Not deployed.**

## L-8 port onto the POS lineage (2026-09-28)

Q0c-3 (e67bac7) is ported with Q0c-2 as reconciliation unit **L-8**, on base `cdd6170`. See
[[POS-Q0c2-pos-send-sms]] and [[POS-Q0b1-customer-scope]].

- **Clean and line-for-line.**
  - `functions/pos-retail.js` had a byte-identical pre-image here, and the change is exactly e67bac7's.
  - `scripts/test-q0c3-pos-receipt.js` is byte-identical.
  - `company-identity.js` and `sokoni-at.js` are identical.
- **Nothing is sent by the suite.** Africa's Talking and SendGrid are stubbed in-process, and the suite refuses to run otherwise.
  Certified server-side authorization is permission to attempt a send, **not evidence of delivery**.
- **Client:** `pos-customers.js` `sendSMSReceipt`/`sendEmailReceipt` still build the old payload, and on this lineage they
  are exported but **never invoked**. No working path is broken. The client repair stays a separate unit.
- **Send-counter storage:** the repo and last-fetched served rules have no rule matching `posReceiptSends`, so it is server-only. The live ruleset is re-fetched before any deploy.
- **Evidence:** 29/0 on the port vs 0/29 on `cdd6170`, the same profile as the main line. 15 of 15 mutants are caught. The Q0c-2 quota
  concurrency note above is re-measured on this port in the Q0c-2 L-8 section.
- **Not deployed.**
