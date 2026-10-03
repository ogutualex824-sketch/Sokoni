# IntaSend Payment Convergence — Master Brief

Owner direction, 2026-10-03. One payment-convergence and security release. Related: [[IntaSend-Only Payment Gate]],
[[Payments]], [[Orders]], [[SmartPOS]], [[Foundation]].

**Status: INTASEND-ONLY = NOT CERTIFIED.** Evidence: `docs/release-gates/intasend-only-gate.md` (17 trees, none clean).

Two truths stay separate:

- **Payment security** (the KES 1 → KES 10,000 webhook issue) ships as a scoped fix as soon as the memory gate and
  guard authorisation allow. It is not held back for the wider migration.
- **IntaSend-only migration** stays uncertified until every tree and every payment surface converges. A green webhook
  is not a green estate.

**"Webhook first" is not free (sokoni-5b, 2026-10-03).** Live checkout (72dca56) mints no `product_order` intent. Once
the Gate 5 webhook (8b569d9, or bare f076c64) is live, every genuine online M-Pesa checkout parks in REVIEW
(`missing_intent`): money captured, order not paid, seller not credited, until `createPaymentIntent` product_order
(b5d0541) and checkout Unit 3 (3eb22ce) also ship. Owner decision:

- **(a) webhook first:** the KES 1 attack closes now; legitimate checkouts need manual re-drive until the other two ship.
- **(b) intent → checkout Unit 3 → webhook:** checkout stays automatic; the attack stays open for two more releases.

## Gate owners (proposed by sokoni-b2; each owner confirms or corrects)

| Gate | Subject | Proposed owner |
|---|---|---|
| 1 | 17-tree census, six-way classification | sokoni-b2 |
| 2 | Daraja removal: cherry-pick of 093fd4f per tree (never a merge) | each tree's owner |
| 3 | Till + merchant dashboard on the existing IntaSend authority | sokoni-2f (union 20b92fa) |
| 4 | Old POS: client fake removed (99e1177 / 863f0f6); server sale completion requires a verified payment record | sokoni-2f (client) · **POS workstream** (server `posCompleteCheckout`, seam `functions/pos-zero-friction.js`; owner decision 2026-10-03; acceptance SP-01…SP-10; no current session identified — owner to name one) |
| 5 | Payment amount + ownership binding on the f076c64 baseline; mandatory attack tests | webhook repair owner (`C:/temp/sok-p0wh`) |
| 6 | All hub payment routes: server-priced intent → IntaSend → webhook | sokoni-b2 |
| 7 | Landlord / rent: no browser authority | sokoni-b2 |
| 8 | Card through IntaSend, method = card | sokoni-b2 |
| 9 | One authoritative IntaSend webhook | webhook repair owner |
| 10 | Webhook idempotency | webhook repair owner |
| 11 | Public create-order API: server economics | sokoni-e3 (confirmed; released by sokoni-5b) |
| 12 | Payment method from the provider, never the UI | sokoni-b2 (with 8) |
| 13 | Browser fabrication census across 17 trees | sokoni-b2 |
| 14 | Foundation donations and payouts | sokoni-2f |
| 15 | Test matrix per repaired rail | each rail owner |
| 16–19 | Revision proof, deploy control, 512 MB memory gate, release order | everyone |

---

## The brief (verbatim)

**Target:** every SOKONI-mediated payment → server-priced payment intent → IntaSend → one authoritative webhook →
verified payment → SOKONI ledger/order/fiscal state. No Daraja, no browser-confirmed payment, no caller-controlled
amount, and no duplicate payment authority.

### Objective

Bring every SOKONI-mediated payment surface to one server-authoritative IntaSend payment architecture.

```
CLIENT
  ↓
SERVER-PRICED PAYMENT INTENT
  ↓
INTASEND
  ↓
ONE AUTHORITATIVE INTASEND WEBHOOK
  ↓
VERIFIED PAYMENT RECORD
  ↓
SOKONI ORDER / BOOKING / SALE / SUBSCRIPTION / DONATION / LEDGER
  ↓
FISCAL ENGINE / RECEIPT / SETTLEMENT
```

Never allow:

- browser-supplied payment success
- browser-supplied final amount
- browser-supplied paid status
- Daraja/STK as an active SOKONI payment rail
- a callback to settle an order without an exact server payment record
- partial payment to satisfy a full order
- payment for order A to settle order B
- buyer A payment to settle buyer B's order
- duplicate webhook authorities
- fake/simulated payment references
- blanket Functions deployments
- production deployment before proof

Do not rebuild existing payment architecture. Repair/converge existing authorities. Do not create competing payment cores.

### Gate 1 — Complete the census

Run `scripts/intasend-only-gate.js` against all 17 deploy trees. Classify every finding exactly as ACTIVE_DARAJA,
BROWSER_PAYMENT_CONFIRMATION, OLD_DARAJA_GUARD, BLANKET_DEPLOY, NON_PAYMENT_REFERENCE or LEGACY_INACTIVE_REFERENCE.
Do not hide findings. Do not quarantine findings merely to make the checker green. The gate is green only when every
executable payment path is clean.

### Gate 2 — Daraja removal

Use the approved Daraja removal commit as the source repair. Copy, do not merge, the approved removal into each affected
tree. Do not blindly merge another agent's branch. For each tree:

1. establish HEAD
2. establish owner
3. copy only the approved removal
4. inspect diff
5. run syntax/tests
6. rerun `intasend-only-gate.js`
7. record result

Do not alter unrelated payment logic while doing the removal. The old deploy guard remains a separate finding. Do not
weaken the guard globally. If the approved scoped exemption is used, it must be explicit and limited to the approved
repair tree(s). Otherwise apply the approved Daraja-removal repair so the stricter guard passes.

### Gate 3 — Till + merchant dashboard

Both must use the existing IntaSend payment authority. Remove active Daraja push calls. Verify:

- Till → server payment intent → IntaSend → webhook → confirmed payment → sale completion
- Merchant dashboard → the same payment authority → no independent Daraja path

Do not create a second payment implementation.

### Gate 4 — Old POS M-Pesa

Remove all fake/simulated success. Specifically reject `SIMULATED_*`, client-completed payment, caller-supplied payment
success, and local success state without a verified provider payment. The sale-completion server step must require an
authoritative, verified payment record. Test:

| Case | Expected |
|---|---|
| M-Pesa confirmed | sale may complete |
| M-Pesa not confirmed | sale cannot complete |
| Fake reference | sale cannot complete |
| Missing payment record | sale cannot complete |
| Wrong payment/order binding | sale cannot complete |

### Gate 5 — Payment amount + ownership security

Keep f076c64 as the security baseline. For every order-completing payment, a server payment record must exist and:

- `payment.orderId == order.id`
- `payment.buyerId == order.buyerId`
- `payment.currency == order.currency`
- `payment.amount == order.serverPayableAmount`
- `payment.status == verified/confirmed`
- the payment has not already been consumed

No browser amount is authoritative. No callback amount is sufficient by itself. No order amount is substituted when the
payment amount is missing. No partial payment completes an order. No overpayment silently completes an order unless the
existing authorised payment policy explicitly supports it. Otherwise route to REVIEW.

Mandatory attack tests:

| Attack | Expected |
|---|---|
| KES 10,000 order + KES 1 payment | REVIEW |
| KES 10,000 order + KES 9,999 | REVIEW |
| KES 10,000 order + KES 10,001 | REVIEW |
| payment for order A → order B | REVIEW |
| buyer A payment → buyer B order | REVIEW |
| missing payment record | REVIEW |
| unverified callback | REVIEW |
| wrong currency | REVIEW |
| duplicate callback | idempotent |
| already consumed payment | no second settlement |

### Gate 6 — All hub payment routes

Audit and repair: BnB, car hire, car tracking, healthcare, legal, digital gigs, delivery, rent, property, sports/events
where SOKONI mediates payment, creator/stream, subscriptions, Foundation, marketplace, POS/Till, and all other
marketplace verticals. Every SOKONI-mediated payment must have server-side pricing, a server-side payment intent,
IntaSend, authoritative webhook confirmation, and a canonical financial/order record. Do not invent a new payment
collection path for any hub. If a hub is not currently payment-enabled, it must not fabricate a successful payment state.
An unavailable payment capability must remain unavailable rather than pretending success.

### Gate 7 — Landlord / rent

Remove trust in browser IntaSend "complete" events. The browser may initiate/display the checkout. The browser must not
decide paid, completed, verified or settled. Rent records become paid only after the authoritative server payment
record/webhook path confirms payment. Keep the previously defined distinction between SOKONI-mediated rent and genuinely
external rent flows.

### Gate 8 — Card

Card must use IntaSend. Do not record a card transaction as "mpesa". The payment method must come from the
authoritative server/provider result. Required: card initiation → IntaSend → verified callback/payment record →
method = card → correct order/sale/ledger record. Do not use a real-money card transaction merely as a browser smoke test
without explicit authorisation. If proving the real SOKONI IntaSend account creates a real invoice or charge, treat that
as a separate explicitly authorised live-money test.

### Gate 9 — One webhook authority

There are currently two IntaSend webhook paths. Determine exactly which one is live, which one is canonical, which one
writes payment state, which one writes ledger/order state, and which one is duplicate/legacy. Converge to one
authoritative IntaSend webhook. Do not simply delete the second path: first prove its callers, triggers, deployments,
references and data effects, then retire the duplicate safely. Final invariant: one provider confirmation authority.
All other webhook paths must be retired, delegated into the canonical authority, or provably inactive. No two functions
may independently settle the same payment.

### Gate 10 — Payment idempotency

Every provider callback must be safely repeatable. A repeated callback causes no duplicate order completion, ledger
credit, inventory decrement, seller credit, Foundation balance or payout eligibility. Use the existing canonical
transaction/payment identity. Do not introduce a second ledger authority.

### Gate 11 — Public create-order API

Repair sokoni-e3's finding separately. Caller-supplied prices must not become authoritative order economics. The server
resolves product, seller, tier, quantity, discount, tax, fees and final payable amount. The stored order must represent
server-calculated economics. Do not merely hide the endpoint. Do not allow a fake pending order to become a valid
payable order later through caller-controlled pricing.

### Gate 12 — Payment method consistency

Every payment record must preserve the actual provider method (M-PESA → mpesa, CARD → card). Do not write card → mpesa.
Do not infer the method from the UI. Use the authoritative IntaSend/provider response.

### Gate 13 — Browser fabrication census

Search all 17 trees for patterns representing paid, completed, verified, success, paymentReference, transactionId and
checkout success. Classify each value as DISPLAY_ONLY, INITIATION_ONLY, SERVER_CONFIRMED or BROWSER_AUTHORITY. Any
BROWSER_AUTHORITY payment completion is a blocker. Known cases include BnB, landlord and old POS. Find all others, and
fix each one through the existing server authority.

### Gate 14 — Foundation

Foundation donation/payment functions follow the same architecture: amount calculated/validated server-side → IntaSend →
webhook → verified donation record → Foundation ledger. Never: browser says paid → Foundation balance increases. Payouts
may spend only verified Foundation funds. Keep the existing multi-person payout authorisation and IntaSend confirmation
requirements.

### Gate 15 — Test matrix

Every repaired payment rail needs VALID_PAYMENT, INVALID_AMOUNT, PARTIAL_PAYMENT, WRONG_ORDER, WRONG_BUYER,
MISSING_PAYMENT, UNVERIFIED_PAYMENT, DUPLICATE_CALLBACK, REPLAY_CALLBACK, FAKE_REFERENCE,
BROWSER_SUCCESS_WITHOUT_PROVIDER and WRONG_CURRENCY. For each test record: test id, expected, observed, pass/fail,
mutation/attack used, database effect, money effect, order effect, ledger effect. A test suite exit code of 0 is not
sufficient evidence by itself.

### Gate 16 — Production revision proof

Before calling any issue "live fixed", identify the current production revision with gcloud. Record service/function,
revision, deployment time, source lineage, commit if available, and traffic allocation. Do not infer current production
code from an old deployment note.

### Gate 17 — Deployment control

No blanket Functions deployment. Every deployment names exact functions, for example
`firebase deploy --only functions:webhookIntasend`; list any additional functions explicitly. Before deployment run
`git status --short`, `git diff`, `git diff --cached`, `git rev-parse HEAD` and `git show --stat <approved-commit>`. Then
deploy only the authorised set. No unrelated agent work may be swept into the deployment.

### Gate 18 — Memory

512 MB free memory is a hard prerequisite. Below 512 MB: no emulator, no gcloud verification requiring the blocked
environment, no compiled-size measurement, no deployment. Do not lower the threshold. Do not force the deployment around it.

### Gate 19 — Release order

Once memory and guard authorisation are satisfied:

1. security-critical IntaSend webhook repair (scoped exact Functions only)
2. sokoni-2f Foundation functions
3. sokoni-5b review/AdminOS functions
4. hosting pages, rebased on live
5. storage rules
6. emulator proof
7. compiled-size measurement
8. Firestore rules
9. live browser proof
10. final production revision verification

Payment/security repairs must not be delayed merely because they were originally grouped under Foundation.

### Final green criteria

SOKONI may only be called INTASEND-ONLY when every item is proven:

- [ ] 17-tree census clean
- [ ] no active Daraja payment path
- [ ] no browser payment confirmation
- [ ] no fake/simulated payment
- [ ] Till IntaSend
- [ ] Merchant Dashboard IntaSend
- [ ] Marketplace IntaSend
- [ ] POS IntaSend
- [ ] all SOKONI-mediated hubs have server-priced IntaSend routes
- [ ] one authoritative IntaSend webhook
- [ ] exact payment/order binding
- [ ] exact buyer/payment binding
- [ ] exact amount match
- [ ] exact currency match
- [ ] verified provider status
- [ ] idempotent webhook
- [ ] card recorded correctly
- [ ] no landlord browser authority
- [ ] no fake BnB confirmation
- [ ] no fake POS confirmation
- [ ] public create-order pricing repaired
- [ ] Foundation payment authority repaired
- [ ] emulator adversarial matrix green
- [ ] live revision verified
- [ ] exact scoped deployments only
- [ ] post-deploy live attack tests pass

Until every item is proven: **INTASEND-ONLY = NOT CERTIFIED.**

Hard constraints: no blanket deploy, no weakening the guard to manufacture green, no Daraja reintroduction, no browser
payment authority, no production deployment below the 512 MB prerequisite, and no claim of "fixed" without
deployed-revision and behavioural evidence.
