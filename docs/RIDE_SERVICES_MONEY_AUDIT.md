# Ride + Services — Revenue & Collection Audit

**Stage 1 — read-only money-flow map.** No code written, nothing deployed.
**Date:** 2026-08-27
**Related:** [[COMMISSION_INVOICE_SPEC]] · [[MERCHANT_OWNED_PAYMENTS]] · [[COMMISSION_ENFORCEMENT_CONTRACT]]

Classification: **EXISTS · PARTIAL · BROKEN · MISSING · UNPROVEN · DEPLOYED · NOT DEPLOYED**

---

## 0. The finding that reframes the question

> **"Ride" in SOKONI is not passenger ride-hailing. It is delivery.**

| Evidence | |
|---|---|
| `fare` logic anywhere in `functions/` | **zero files** |
| `collection("rides")` | **3 sites, all reads** — admin listing, status counts. No writer found. |
| `dispatch.js` money handling (`amount`/`fare`/`price`/`commission`/`payout`) | **none** |
| Actual rider money | `deliveryFees` → `riderFeeKES`, `status: 'credited'` |

So there are **two** commercial models here, not three, and the second one barely exists:

* **Services / Provider bookings** — a real, platform-collected financial rail.
* **Delivery riders** — a rider-earnings path. **See §0b: this section understated it.**
* **Passenger ride-hailing** — no fare engine found. **See §0b for the confidence caveat.**

**This must be settled before anything is designed.** If passenger ride-hailing is intended,
it is a greenfield build. If "ride" means delivery, the money question is about rider fees
and is already partly answered.

## 0b. ⚠️ CORRECTION to §0 — issued 2026-08-27, same day

**§0 understated the delivery rail, and it did so because a probe was broken.**

The search behind "no fare logic" was scoped to `functions/` and its **control returned 0**
(the control pointed at `service-pricing.js` without the `functions/` prefix). A detector
whose control fails proves nothing, and I drew a classification from it anyway.

What a working search found:

| | |
|---|---|
| `collection(trips)` | **EXISTS** — `functions/navigation.js`, statuses `assigned → en_route_pickup → arrived_pickup → en_route_delivery → arrived_delivery` |
| Trip earnings | `trips.earnings` field, aggregated for driver reporting |
| Earnings trigger | `driverEarningQueue` → **FinOS earnings credit** |
| Duplicate protection | "duplicate trigger delivery ignored" guard present |

And the payout path is not only present, it is **documented as server-authoritative and
exactly-once** (`navigation.js:563`):

> *"any client-supplied `earnings` is intentionally IGNORED — never trust the client for a
> payout amount. The rider is credited server-authoritatively by `onOrderStatusChange` when
> the order flips to `delivered` — the ONE proven, exactly-once delivery-payout path."*

**Revised classification**

| Track | Was | Is |
|---|---|---|
| Delivery rider earnings | PARTIAL / untraced | **EXISTS · DEPLOYED** — queue, exactly-once credit, client amount refused |
| Trip record | not found | **EXISTS** — `trips`, with earnings and proof-of-delivery |
| Passenger ride-hailing fare engine | MISSING | **still not found**, but now stated with less confidence: one probe here has already failed its control |

**What survives from §0:** "ride" in SOKONI is delivery, not passenger transport — the trip
lifecycle is pickup→delivery, and there is no passenger fare engine. **What does not survive:**
the implication that the rider money path is thin. It is built, deployed, and hardened
against exactly the client-trust defect that would matter most.

**Method note.** This is the second time in this session that a zero result came from a
broken probe rather than an absent feature. A conclusion of "X does not exist" needs a
control that demonstrably finds something — otherwise the honest classification is UNKNOWN,
not MISSING.

## 1. Who collects — the question that decides everything

### Services / Provider bookings — **PLATFORM COLLECTS**

```
customer → SOKONI (IntaSend) → providerBookings (held) → completion
                                      ↓
                        providerPayouts { gross, commission, net }
                                      ↓
                          provider wallet credited
```

`provider-ops.js` writes `providerPayouts` with `gross`, `commission`, `net`,
`walletCredited: true`, `netShillingsCredited`, transactionally. SOKONI **genuinely
custodies** this money.

> **Escrow/hold/release semantics ARE meaningful here** — unlike the merchant-owned
> marketplace rail, where they would be false. `booking-payment-sweep.js` already implements
> a real hold: an unpaid booking holds a payable slot for `expiresAt` (5 min), then expires,
> "terminal + idempotent".

**Status: EXISTS · DEPLOYED.** Gross/commission/net split, wallet credit, payout record,
hold-and-expire, transactional writes.

### Delivery riders — **EXISTS · DEPLOYED** (revised, see §0b)

`trips` (`navigation.js`) → `driverEarningQueue` → FinOS credit, with the payout written
**server-authoritatively and exactly-once** by `onOrderStatusChange` on `delivered`. A
client-supplied `earnings` is explicitly ignored. `deliveryFees` (`riderFeeKES`, `credited`)
carries the fee record; `analytics-reconcile.js` reconciles it.

**Still NOT TRACED:** whether the *customer* pays a delivery fee into SOKONI custody, and how
that relates to `riderFeeKES`.

### Passenger rides — no fare engine found

No fare authority or payment intent located. Stated with reduced confidence — see §0b.

## 2. Commission authority — already centralised

Provider commission resolves through `commission-config.js`, the single source guarded at
predeploy. The provider path uses the `subscriptionRole: 'provider'` compatibility branch —
opt-in, reachable from **exactly one call site** (`provider-ops.js:134`), and documented in
the single-source allowlist.

> ⚠️ Recorded there and worth re-reading before touching provider pricing:
> `ROLE_DEFAULT_COMMISSION.merchant` is **0.20 against a canonical 0.08**, unreachable today
> **only because no marketplace call site passes `subscriptionRole`**. If one ever does,
> that stops being true.

**Status: EXISTS.** Do **not** add a ride or service commission calculator. The authority is
the same one the marketplace uses.

## 3. Known divergence — two booking collections

| Collection | Sites |
|---|---|
| `providerBookings` | 42 — canonical per the project record |
| `bookings` | 33 |

**Status: BROKEN (pre-existing).** Same class as the three POS sale collections. Any new
work must pick the canonical one deliberately, not by copying whichever appears nearest.

## 4. What already exists — do NOT rebuild

| Capability | Status | Where |
|---|---|---|
| Commission rate authority | **EXISTS · DEPLOYED** | `commission-config.js` + predeploy guard |
| Immutable double-entry ledger + reversal | **EXISTS** | FinOS `ledger`, `reverseLedgerEntry` |
| Wallet credit / debit / hold / release | **EXISTS** | `finos-utils.js` |
| Provider payout record (gross/commission/net) | **EXISTS · DEPLOYED** | `providerPayouts` |
| Booking hold + expiry | **EXISTS · DEPLOYED** | `booking-payment-sweep.js` |
| Service pricing engine | **EXISTS** | `service-pricing.js` |
| Platform invoice (KRA) | **EXISTS · DEPLOYED** | `etimsPlatformInvoice` |
| Settlement idempotency | **EXISTS** | `commissionSettlements` |
| Rider earnings credit (exactly-once) | **EXISTS · DEPLOYED** | `navigation.js` → `driverEarningQueue` → FinOS |
| Trip record with earnings + proof-of-delivery | **EXISTS** | `trips` |
| Delivery fee record | **EXISTS** | `deliveryFees` (`riderFeeKES`) |
| **Passenger fare engine** | **not found** (see §0b) | — |

> **No `ridePayments`, `servicePayments`, `rideLedger` or `serviceLedger` exists.** That is
> good news: there is nothing to duplicate, and nothing should be created. The platform has
> already paid for nine commission tables, three POS sale collections, three schemas inside
> one `invoices` collection, and two booking collections.

## 4b. Money findings — **UNVERIFIED**, recorded 2026-08-27

> **SUPERSEDED by §4f.** Both were traced the same day. F1 main settlement is
> VERIFIED, F2 is VERIFIED as intentional, and only the deposit-forfeit remainder remains
> open. The §77 reading below is corrected in §4f. Kept for the record of how each was
> reached.

> Both are **findings, not confirmed defects.** Each is stated with the evidence that
> produced it and the question that would settle it. Earlier in this audit a classification
> was published from a probe whose control had failed; these are deliberately held at
> UNVERIFIED until their counter-question is answered.

Tested against the rule: **if a customer pays KES X, where does every shilling go?** —
`GROSS = COMMISSION + PROVIDER NET + OTHER AUTHORISED COMPONENTS`, with no silent remainder.

### F1 — deposit-forfeit rounding leaves an unallocated remainder

`provider-ops.js:102-104`, the deposit-forfeit path on booking cancellation:

```js
const providerNetC     = Math.max(0, forfeitC - forfeitCommissionC);   // cents
const forfeitShillings = Math.floor(providerNetC / 100);               // shillings
```

Driven through the shipped arithmetic:

| gross / commission | net (c) | credited (c) | **remainder** |
|---|---|---|---|
| 1234 / 62 | 1172 | 1100 | **72c** |
| 999 / 50 | 949 | 900 | **49c** |
| 150 / 8 | 142 | 100 | **42c** |
| 99 / 5 | 94 | **0** | **94c** — and `providerPayouts` is **not written at all** |

The payout row records `net: providerNetC` in cents while the wallet receives
`netShillingsCredited` in floored shillings. The two disagree by up to **99 cents per
transaction**. Below one shilling the guard `if (forfeitShillings >= 1)` skips the write
entirely, so no payout record exists for money that has already left the customer side.

**UNVERIFIED — the question that settles it:** is the remainder *intentionally retained as
platform revenue* — in which case it must be booked as such, not merely dropped — or is it
genuinely unallocated? Wallet balances are canonically **shillings**, so flooring may be a
deliberate granularity choice. A deliberate choice still needs the remainder recorded
somewhere.

**Scope caution:** this is the **forfeit** path specifically. Whether the main completion
path rounds identically is **NOT YET TRACED**.

### F2 — customer and provider credited to different wallet stores

Inside the **same transaction** (`provider-ops.js`, forfeit path):

| Party | Written to | Field |
|---|---|---|
| Customer refund | `users/{uid}` | `walletBalance` |
| Provider credit | `wallets/{uid}` | `balance` |

**UNVERIFIED — the question that settles it:** are these intentionally distinct wallet
domains — a customer store-credit balance versus a provider payable balance — or an
accidental split of one concept across two collections? The project record names
`wallets/{id}.balance` as the canonical withdrawable balance, which makes the customer side
the one to trace.

If accidental, it is the same class as the three POS sale collections and the two booking
collections: one concept, two homes, reconciled by nobody.

### Neither is actionable yet

No code changes on either finding until its question is answered. F1 in particular could be
"correct by design with a missing ledger entry" or "money quietly lost" — and those need
different fixes.

## 4c. F2 traced — canonical wallet identified, refund destination is not it

**Upgraded from UNVERIFIED to TRACED, 2026-08-27.** One question remains open (below).

### `wallets/{uid}.balance` is canonical — stated by the code, not inferred

`scripts/sfos-reconcile.js:38` — *"Get canonical balance from `wallets/{uid}`"* — reconciles
the SFOS ledger sum against it. Every spend/withdraw reader uses the same field:

| Reader | Field |
|---|---|
| `wallet-engine.js:1105`, `:1192` | `wallets/{uid}.balance` |
| `pos-crm-pro.js:1163` | `wallets/{uid}.balance` |
| `sfos-engine.js:2649` | `wallets/{uid}.balance` |

> ⚠️ These sites assign it to a local variable **named `walletBalance`** while reading the
> field `balance`. That naming is what made the two stores look like one during the first
> pass. The variable name is not the field name.

### `users/{uid}.walletBalance` is a different field — displayed, not canonical

Read by **14 client surfaces** including `account-centre.html`, `profile.html`,
`driver.html`, `seller.html`, `pos-customers.js`.

Written by three customer-refund paths:

| Writer | Credits | Also writes `wallets/`? |
|---|---|---|
| `provider-ops.js:115` | customer refund on cancellation | yes (provider side only) |
| `booking-payment-sweep.js:83` | customer refund on expired booking hold | **no** |
| `automation-engine.js:627` | — | **no** |

### Three facts that hold together

1. **No synchronisation exists** between the two fields — no mirror, sync or copy logic found.
2. **`sfos-reconcile.js` does not cover `users.walletBalance`.** It compares ledger sum against
   `wallets.balance` only, so this field is outside the integrity audit entirely.
3. Two of the three writers never touch `wallets/` at all.

**So a customer refund credits the field that is DISPLAYED, not the field that is CANONICAL,
and nothing reconciles the two.**

### The one remaining question

Are these refund credits **intentionally display-only / non-spendable store credit**, or are
customers expected to spend them through the canonical wallet? The spend path reads
`wallets/{uid}.balance`, which these refunds never touch — so if spending is intended, the
money is visible and unusable.

Until answered, this is **not yet a production defect**. It is a precise, evidenced
divergence with one unanswered intent question.

## 4d. Ride Hub — a hub without a backend

**`/ride-book` is LIVE in production and is a mockup.**

| Probe on `ride-book.html` (17.5 KB, 13 `<script>` blocks) | |
|---|---|
| `firebase` | **0** |
| `fetch(` | **0** |
| `<form>` / submit handler | **0** |
| `collection(` / `addDoc` / `setDoc` | **0** |
| `httpsCallable` | **0** |

The 13 `fare` hits are **CSS class names and hardcoded caption text** — `KES 80 base + 15/km`,
`KES 120 base + 20/km`, `KES 200 base + 35/km`, `KES 60 base + 10/km`. Not a calculation.

**Controls that make this trustworthy:** `pos.html` returns `httpsCallable: 2` on the same
probe, so the detector finds callables where they exist; and `/definitely-not-a-page` returns
404 while `/ride-book` returns 200, so the reachability result is real.

This resolves the apparent contradiction in §0/§0b — no server fare engine **and** a live ride
page. Both true. It is not backend artifacts without a hub; it is **a hub without a backend**.

> A customer can reach a production page advertising concrete per-kilometre fares for a
> service that cannot take a booking or a shilling.

### The decision is a product one, not an engineering one

Only two honest options:

* **In scope** — build the transactional chain: authoritative distance/time → server-side
  fare → payment intent → trip lifecycle → completion → gross/commission/driver-net →
  wallet → ledger → receipt → reconciliation. Nothing should be coded before that chain is
  designed.
* **Not in scope** — the public surface should not advertise prices for a service that
  cannot book or collect.

**Nothing should be built until this is chosen.**

## 4e. Method — three probe failures, all producing "absent"

Recorded because the pattern is now unmistakable and each near-miss was in the same direction.

| # | Broken probe | False conclusion it produced |
|---|---|---|
| 1 | `curl` without `-L` (301 stub, empty body) | "the Till UI is not live" — for the wrong reason |
| 2 | control pointed at `service-pricing.js` instead of `functions/service-pricing.js` | "no fare logic exists" — understated the whole delivery rail |
| 3 | `Grep` glob `*.{html,js}` silently missed root files | **"`users.walletBalance` is write-only — customer refunds vanish"** |

Each failure mode was **absence**, and absence is precisely what prompts someone to build a
replacement. #3 would have justified rebuilding a wallet.

> **A conclusion of "X does not exist" requires a control that demonstrably finds something.
> Without one, the honest classification is UNKNOWN — never MISSING.**

Every finding above carries its control.

## 4f. F1 and F2 — FINAL CLASSIFICATION (2026-08-27)

### F1 main provider settlement — **VERIFIED**

`provider-ops.js:237` states the rule the codebase holds itself to:

> *"sub-shilling remainder for exact reconciliation — **never round up (money integrity)**"*

And implements it:

```js
const settleShillings = Math.floor(settleCents / 100);
const remainderCents  = settleCents - settleShillings * 100;   // :255
...
remainderCents,   // :301 — "sub-shilling not withdrawable; recorded for reconciliation"
```

Persisted to `providerPayouts` (`:301`), returned to the caller (`:352`, `:357`), logged.

| Property | Evidence |
|---|---|
| `GROSS = COMMISSION + NET + RECORDED REMAINDER` | `:254-255`, `:301` |
| Commission from the single authority | `finos-utils.calculateCommission` |
| Canonical wallet receives provider net | `wallets/{uid}` — `:262` |
| Exactly-once | `runTransaction` re-reads booking status inside the txn (`:245`) |
| Settlement source is immutable | booking snapshot `data.price` / `data.fee`; never re-reads `providerServices` |

**No unexplained money disappears on the path that runs for every completed booking.**

### F2 — **VERIFIED, intentional by design. NOT a defect.**

`provider-ops.js:71-72` documents the destination explicitly:

> *"Refund → the customer's existing wallet (`users.walletBalance`, whole KES + a `ledger`
> row — **the platform's established refund destination, decision c**)"*

So the two stores are **two wallet domains, deliberately**:

| Domain | Store | Used by |
|---|---|---|
| Customer | `users/{uid}.walletBalance` | refunds; 14 client surfaces |
| Provider / merchant | `wallets/{uid}.balance` | canonical spend & withdraw; SFOS reconciliation |

A `ledger` row accompanies each refund, so the movement is recorded.

**Residual observation (not a defect):** `sfos-reconcile.js` reconciles the SFOS ledger sum
against `wallets/{uid}.balance` only. The customer wallet is outside that integrity audit.
Whether it needs equivalent coverage is a separate question from whether it is correct.

### F1-open — deposit forfeiture — **DOCUMENTATION GAP, bounded**

The split is **exact at cents**. `heldC = commission + providerNet + refund` holds precisely:

| held / deposit | exact split (c) | credited (c) | **unallocated** |
|---|---|---|---|
| 250050 / 100000 | 5000 + 95000 + 150050 | 95000 + 150000 | **50c** |
| 99999 / 49999 | 2500 + 47499 + 50000 | 47400 + 50000 | **99c** |
| 10099 / 5099 | 255 + 4844 + 5000 | 4800 + 5000 | **44c** |

Two independent floors — `refundShillings` (`:103`) and `forfeitShillings` (`:104`) — each
drop up to 99c, so **up to 198c per cancellation** is neither credited nor recorded.

> **This is not "money lost generally."** It is one path, bounded at under KES 2, on
> cancellations only — and it is inconsistent with the sibling path 150 lines away that
> treats recording the remainder as a money-integrity requirement.

**Why it is not yet classified DEFECT:** the contractual question stands — on a forfeited
deposit, who is entitled to the sub-shilling remainder? If the platform is, the current
behaviour may be correct but the accounting destination must be made explicit. If the
customer or provider is, the forfeit path needs the `remainderCents` treatment its sibling
already has.

**Correction to the earlier reading of §77.** "deposit forfeited + remainder refunded" refers
to the **non-deposit portion of the held money** (`refundC = heldC − depositC`), *not* a
sub-shilling remainder. It offers no evidence about entitlement, and §4b's suggestion that it
did was wrong.

### What changed across this audit

Four findings were initially classified as missing or defective. All four narrowed or
reversed on evidence:

| Initially | Actually |
|---|---|
| delivery rail thin | exactly-once, server-authoritative, client amount refused |
| no trip record | `trips` with earnings and proof-of-delivery |
| `users.walletBalance` write-only | read by 14 client surfaces; documented refund destination |
| rounding loses money | main path records the remainder; only forfeit does not |

**The audit's own rule earned its place: a first search that does not find something is not
evidence it does not exist.**

## 5. NOT YET TRACED — Stage 2

Deliberately unclassified rather than guessed:

* Does the customer pay a delivery fee into SOKONI custody, and how does it relate to
  `riderFeeKES`?
* Refunds and disputes on provider bookings — `qa-booking-refund-e2e.js` and
  `qa-booking-resolution-e2e.js` exist; the production paths are untraced.
* Idempotency on the provider payment path (the booking sweep claims "terminal + idempotent";
  unverified here).
* Reconciliation between `providerPayouts`, the FinOS `ledger`, and wallet balances.
* Receipts / eTIMS for service bookings — does a customer get a fiscal receipt?
* Whether `bookings` vs `providerBookings` split money or only metadata.
* Authorization on the payout paths.

## 6. Recommendation

**Do not write collection code for rides or services.**

1. **Settle whether passenger ride-hailing is in scope.** If yes it is greenfield and needs
   its own commercial decision (who is MoR, who collects) before any schema. If "ride" means
   delivery, say so and this track narrows to rider fees.
2. **Services need no new financial system.** Platform-collected, gross/commission/net,
   wallet credit, holds — all built and deployed. Any gap is likely reconciliation or
   receipts, not collection.
3. **Stage 2 traces §5** before any design.

The escrow distinction settled for the marketplace applies in reverse here: **services
genuinely are custodial**, so hold/release is correct language on that rail — and using it on
the merchant-owned marketplace rail would still be false.

## 6. END-TO-END RECONCILIATION MATRIX

One map, four commercial flows. Every cell is evidence from shipped code, not intent.

### 6.1 Where money enters and who holds it

| | **Marketplace** | **Services** | **Delivery** | **POS Till (manual)** |
|---|---|---|---|---|
| Who pays | customer | customer | customer (inside order total) | customer |
| Money enters | IntaSend *(merchant-owned Daraja planned)* | IntaSend | **inherits the order's rail** | merchant's own Till |
| SOKONI custody | yes today; **no** under merchant-owned | **yes** | **inherited** — not independent | **no** |
| Escrow language valid? | today yes; merchant-owned **no** | **yes** — real hold | follows the order | **no** |

> **Delivery has no payment rail of its own.** The fee is a component of the order total, so
> its custody is whatever the order's rail was. That is why "who collects delivery money" had
> no separate answer — the question resolves to the order.

### 6.2 Obligation, commission, and the split

| | **Marketplace** | **Services** | **Delivery** |
|---|---|---|---|
| What creates the obligation | buyer-attested completion (§6a) | booking completion, `paid_held` | order → `delivered` |
| Commission source | `commission-config.js` | `finos-utils.calculateCommission` | `finos-utils` via `_delComm` |
| Separate commission table? | **no** | **no** | **no** |
| Split | gross − commission | `net = price − commission`, `+fee` passthrough | `riderFee = deliveryFee − platformFee` |
| Reconciles? | receivable model | `GROSS = COMM + NET + remainderCents` ✓ | `deliveryFee = platformFee + riderFee` ✓ |

**All three resolve commission through the one authority.** No ride/delivery/service commission
engine exists, and none should be created.

### 6.3 Who receives, and where it is recorded

| | **Services** | **Delivery** |
|---|---|---|
| Provider / rider receives | `wallets/{uid}.balance` (canonical) | rider credited exactly-once via `driverEarningQueue` |
| Customer refund receives | `users/{uid}.walletBalance` + `ledger` row — *"decision c"* | n/a |
| SOKONI's cut | commission on `providerPayouts` | `platformFeeKES` on `deliveryFees` — **recorded, not moved** |
| Sub-shilling remainder | `remainderCents` recorded ✓ | fees are already KES-denominated |
| Exactly-once | txn re-reads booking status | `onOrderStatusChange` on `delivered`; client `earnings` refused |

> **SOKONI's delivery cut is a record, not a movement.** `platformFeeKES` appears only on the
> `deliveryFees` document and in an ops report. That is coherent *when SOKONI already holds the
> order money* — there is nothing to transfer. It stops being coherent the moment an order is
> collected merchant-owned, because then the platform fee is in someone else's Till and only a
> record says otherwise.

### 6.4 Reconciliation coverage

| Store | Reconciled by | Covered? |
|---|---|---|
| `wallets/{uid}.balance` | `sfos-reconcile.js` vs SFOS ledger | **yes** |
| `users/{uid}.walletBalance` | — | **no** |
| `providerPayouts` | `remainderCents` enables exact reconciliation | recorded |
| `deliveryFees` | `analytics-reconcile.js` → deliveries / riderEarnings | partial |
| `commissionLedger` | `commissionSettlements` claims | idempotent |

### 6.5 Observations carried forward — none are defects

**O1 — client-supplied delivery fee.** `index.js:3674`:
`deliveryFee = Math.min(Math.max(clientDelivery, 0), 5000)` — a client value, clamped to
0–5000. The alternative path (`:3652`) uses a calculated `_calc.fee`. Since
`riderFee = deliveryFee − platformFee`, a client-understated fee reduces the **rider's**
earning, not SOKONI's. Bounded and clamped; worth confirming which path production takes.

**O2 — customer wallet outside SFOS reconciliation.** `users/{uid}.walletBalance` is the
documented refund destination and carries a `ledger` row, but no integrity script reconciles
it the way `sfos-reconcile.js` covers the canonical wallet.

**O3 — delivery platform fee under merchant-owned collection.** §6.3. Not a problem today;
becomes one exactly when the merchant-owned rail is authorised, and should be resolved as part
of that work rather than separately.

### 6.6 The question, answered for each flow

> *If a customer pays KES X, where does every shilling go?*

* **Services** — `X = commission + provider net + recorded remainder`, with refunds ledgered.
  **Answerable to the cent.**
* **Delivery** — `deliveryFee = platformFee + riderFee`, rider credited exactly-once, platform
  fee recorded. **Answerable**, conditional on the order's rail.
* **Marketplace** — receivable model; SOKONI does not observe the customer payment under
  merchant-owned collection, and the contract says so rather than pretending otherwise.
* **POS Till (manual)** — operator-attested; `paymentVerified: false`. **Deliberately not
  claimed as observed.**
* **Passenger ride** — no flow exists. `/ride-book` is a mockup.

**No silent remainder in any implemented flow except the deposit-forfeit path (§4f), which is
bounded under KES 2 per cancellation and awaiting an entitlement decision.**

## 6b. Client-supplied delivery fee — TRACED, no realised defect

### No monetary incident has occurred

| Production evidence | |
|---|---|
| `deliveryFees` records | **2**, both `total: 0, platform: 0, rider: 0` (`no-rider`, `pending`) |
| `delivery_fee_mismatch` audit rows | **0** |
| `delivery_fee_unverified` audit rows | **0** |
| **CONTROL** — `auditLogs` has other entries | **yes** — `stk_callback_ip_rejected`, `mpesa_callback` |

The control is what makes the zeros meaningful: the collection is written and the query works.
**No order has ever carried a non-zero delivery fee.** Do not describe this as a historical
incident — there is none.

### The code is stronger than the first observation implied

**Path A — merchant HAS `deliveryConfig`:** the server computes the fee via
`shared/delivery-engine.calculateDelivery(cfg, {subtotal, distanceKm, zone})`. A client figure
that disagrees is **rejected**, not overwritten:

> *"Silently substituting the server figure would charge a total the customer never saw."*

It returns the authoritative figure so the client can refresh honestly, and logs
`delivery_fee_mismatch` at **severity: high** when the client figure is lower — underpayment
attempts are already classified.

**Path B — no `deliveryConfig`:** `clamp(clientDelivery, 0, 5000)`, with a
`delivery_fee_unverified` audit row on every use, noting *"legacy clamp applied"*.

So a client value can become authoritative **only** on a legacy fallback, bounded, and audited
each time. Instrumented, not unguarded.

### The real number is a rollout metric

**2 of 8 sellers have `deliveryConfig`** (both enabled); **6 of 8** take the legacy path.

Since `riderFee = deliveryFee − platformFee`, an understated fee reduces the **rider's**
earning, not SOKONI's. So the correct framing is not "fix a vulnerability" but
**`deliveryConfig` rollout is incomplete** — completing it moves merchants onto the
server-calculated path. The `delivery_fee_unverified` count is the progress metric; it should
reach zero.

**Classification: READINESS ITEM, not a security emergency.**

## 6c. ⛔ LAUNCH INVARIANT — merchant-owned collection × delivery

> **No merchant-owned order containing a non-zero delivery fee may be enabled until the
> platform delivery component and the rider component have an actual money-movement and
> reconciliation path, rather than merely records.**

### Why this gate exists

Today the platform-collected path is correct **because SOKONI holds the money**:

| Component | Today | Under merchant-owned collection |
|---|---|---|
| `platformFeeKES` | **recorded, never moved** — nothing to transfer, SOKONI already holds it | sits in the **merchant's Till**; the record asserts an entitlement SOKONI does not hold |
| `riderFee` | credited from SOKONI's side, exactly-once | SOKONI would be paying a rider out of money it never received |

The delivery fee has **no payment rail of its own** — it is a component of the order total, so
its custody is whatever the order's rail was (§6.1). That is precisely why this coupling is
invisible until the rail changes.

### What must be true before the gate opens

- [ ] `deliveryConfig` rollout complete, or the legacy path explicitly excluded from
      merchant-owned orders
- [ ] a defined settlement path for `platformFeeKES` when the merchant receives the customer
      payment — a receivable like commission, or collected separately
- [ ] rider earnings reconcile exactly, with the funding source named
- [ ] the mixed case tested end to end: merchant-owned payment + delivery + commission +
      rider payout

### What this does NOT justify

**Do not modify the existing delivery settlement machinery.** The platform-collected path is
already correct. The new requirement is specifically the **cross-rail** case, and changing
working code before that case is designed would risk the path that works today for the sake of
one that does not yet exist.

## 7. Boundaries — unchanged

`productionAuthorized` false · `revenueConfig/commission_vat` unset, no commission invoice can
issue · no Daraja/STK/C2B · nothing in this audit touched code.
