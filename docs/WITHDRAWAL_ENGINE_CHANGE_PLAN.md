# Withdrawal engine — implementation audit and exact change plan

**Date:** 2026-09-02
**Status:** PLAN ONLY. No code written, nothing deployed.
**Prerequisite reading:** `docs/POS_PAYMENT_RAIL_AUDIT.md` (rail, withdrawal domain, commission)

---

## 1 · The live surface — measured, not read from the tree

`gcloud functions list` against `sokoni-aeb26`: **1,711 deployed functions**, of which
**19 touch payout or withdrawal**.

**Five request-side entry points are live at once, across three collections:**

| live callable | source | collection | last deployed |
|---|---|---|---|
| `requestWithdrawal` (+`approve`/`reject`/`get`) | `commission.js` | **`withdrawals`** | 2026-08-22 |
| `requestPayout` | `finos.js` | `wallets` | 2026-08-22 |
| `requestSellerPayout` | `wallet.js` **(frozen)** | **`payoutRequests`** | 2026-08-22 |
| `finosRequestBankPayout` | `finos-router.js` | — | 2026-08-22 |
| `initiateSellerPayout` | `index.js` | — | 2026-08-22 |

Plus supporting live machinery: `adminProcessPayout`, `adminPayoutOps`,
`adminGetPendingPayouts`, `getPayoutHistory`, `getPayoutAnalytics`, `reconcilePayouts`,
`processPayoutRetries`, `processPendingPayouts`, `autoScheduledPayouts`,
`emailOnSellerPayout`, `sweepEarningsToWallet`, `spendFromWallet`, `refundToWallet`,
**`walletV2SavingsWithdraw`** (a sixth withdrawal surface found only in the deployed list —
it does not appear in the files audited).

**This is the scope fact that governs everything below.** The fragmentation is not a
tidiness problem in the repo; it is *deployed and serving*. Any new authority that does not
account for all five request paths will be the sixth.

## 2 · What must be decided before any code

These are not implementation details. Each one changes what gets built.

| # | decision | owner | why it blocks |
|---|---|---|---|
| D1 | Lift the `wallet-backend-v1.0-frozen` freeze for this work, **or** build alongside and cut over | operator | the engine touches `wallets`/`payoutRequests`, which are frozen |
| D2 | POS commission = **absolute plan rate** or **relative plan discount**? | operator | `seller_*` plans carry `commission_discount_pct` (relative); 15/10/5/0 is absolute. They cannot share a field |
| D3 | Does Enterprise 0% override `MIN_COMMISSION_KES`? | operator | otherwise "0%" still charges KES 10 per sale |
| D4 | Which plan catalogue governs a POS merchant — `seller_*` or `services_*`? | operator | they use different fields and different units |
| D5 | Does IntaSend expose a **determinable fee** per payout destination? | **IntaSend** | fail-closed is unimplementable without an authoritative figure |
| D6 | Does IntaSend `send-money` support **Till and PayBill** destinations, and with what fields? | **IntaSend** | `sendMoneyB2C` currently sends a phone number only |

**D5 and D6 are external.** No amount of code reading answers them, and both should be asked
now — they gate design, not implementation.

## 3 · The change strategy: strangler, not surgery

Given five live request paths and a frozen engine, **do not modify the existing payout code
first.** Build the new authority beside it and migrate callers one at a time.

```
                    NEW: withdrawal-engine.js
                              │
                    calculateWithdrawalQuote()      ← pure, no side effects
                              │
                    reserveAndPayout()              ← the only writer
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
           phone            Till           PayBill      ← how to send, never how much
                              │
                    IntaSendAdapter.initiatePayout()
```

**The quote function is pure and separately testable.** It takes balance, amount,
destination type and a fee source; it returns a full breakdown or throws. It performs no
writes, so it can be certified exhaustively before any money moves — the same shape that
made the Rules equivalence harness meaningful.

## 4 · The two calculations, kept apart

```
SALE        gross → POS commission → merchant NET entitlement → wallet credit
WITHDRAWAL  available balance → provider + SOKONI fees → reserve → payout → net received
```

They share no code and no field. The sale path establishes entitlement; the withdrawal path
spends it.

**Commission ordering is non-negotiable:** the atomic event credits the merchant
**net of commission**. There is no moment at which the wallet holds the gross. Implemented
as a single Firestore transaction writing the commission ledger row and the wallet credit
together, keyed by an idempotency key derived from the sale — never two writes.

## 5 · The quote contract

```
calculateWithdrawalQuote({ availableBalance, requestedAmount, destinationType, destination })
  → { requestedAmount, sokoniFee, providerFee, otherFees,
      totalRequired, netAmount, currency, feeSource, quotedAt }
  → throws INSUFFICIENT_BALANCE   when availableBalance < totalRequired
  → throws FEE_INDETERMINATE      when the provider fee cannot be established
```

**`FEE_INDETERMINATE` is the fail-closed path and it must never be defaulted.** A fee of
`0` because a lookup failed is indistinguishable, downstream, from a genuinely free
transfer. `feeSource` records *where the number came from* so a reconciliation can tell an
API-returned fee from a table-derived one.

Note the direction: the merchant receives the **requested** amount and the fee is charged
**on top** (`totalRequired = requested + fees`), matching the worked example. That must be
stated in the UI, because the opposite convention (fee deducted from the requested amount)
is equally common and silently changes what the recipient gets.

## 6 · State machine, and the mapping problem

Proposed: `AVAILABLE → RESERVED → PROCESSING → CONFIRMED`, with
`FAILED → RELEASED → AVAILABLE`.

**`wallet.js` already uses ten statuses**: `pending`, `approving`, `approved`, `processing`,
`retry_scheduled`, `completed`, `paid`, `failed`, `reversed`, `settled_manually` — including
both `completed` **and** `paid`.

The new vocabulary is **not a subset**. Every existing status needs an explicit mapping, or
a reconciliation job that reads both will double-count. This is the same shape as the
settlement-vocabulary defect where a double-credit guard never fired.

**Balance fields are also plural**: `balance`, `available`, `availableBalance`, `pending`,
`pendingPayout`, `pendingTopUp`. Canonical withdrawable is **`balance`, in shillings**. The
reservation must state which field it decrements and which holds the reserve — **adding a
seventh name is forbidden.**

## 7 · Ordered plan

**Phase 0 — decisions.** D1–D6. No code.

**Phase 1 — converge before extending.** Reconcile `withdrawals` → `payoutRequests`, map the
ten statuses, establish which of the five live entry points is authoritative and which are
legacy. *Extending a fragmented authority multiplies the fragmentation* — destinations must
not be added first.

**Phase 2 — the pure quote.** `calculateWithdrawalQuote()` with no writes, certified against
a case matrix including insufficient-balance boundaries, zero fees, indeterminate fees, and
each destination type. Sabotage control: a deliberately wrong fee must fail the suite.

**Phase 3 — POS commission.** Fields on the **existing** single source (a second table fails
`verify-commission-single-source.js`). Atomic commission-then-net-credit. Cash and M-PESA
share this path — cash is provider-independent by construction, since the commission is an
accounting obligation, not a transfer.

**Phase 4 — POS collection rail swap.** Replace only the writer of `posPayments/{ref}`,
Daraja → IntaSend. `posCompleteCheckout` is untouched: it is already rail-neutral.

**Phase 5 — reservation + payout.** Atomic reserve, single-flight payout, release-exactly-once
on failure. Idempotency keyed so a delayed callback cannot produce a second payout.

**Phase 6 — destinations.** Phone first (exists), then Till and PayBill **only if D6
confirms support**.

Each phase certified before the next. No phase deploys on the strength of the previous one's
evidence.

## 8 · What is NOT established

- whether the deployed `darajaSTKPush` / `posCompleteCheckout` / `wallet.js` match this tree
  — the deployed set spans 22 Aug to 1 Sep and is **not one lineage**
- what `walletV2SavingsWithdraw` does, or which collection it writes
- whether IntaSend supports Till/PayBill payouts or exposes per-transaction fees
- whether any of the five live request paths currently carry production traffic

The last one matters for Phase 1: **a path with no traffic can be retired; a path with
traffic must be migrated.** That needs production data, not code reading.

---

# Phase 0 · Step 1 — production provenance inventory of the six withdrawal surfaces

**Date:** 2026-09-02. Read-only. No money moved, no code changed.

| surface | ACTIVE | client callers | collection | amount unit | destination params |
|---|---|---|---|---|---|
| `requestSellerPayout` | LIVE 08-22 | **6** — `merchant-v2.html`, `provider-dashboard.html`, `seller-earnings.html`, `sokoni-wallet-v2.js`, `sokoni-wallet.js`, (`developer-portal.html` docs) | `payoutRequests` | **shillings** (`amount`, min 100) | `method`, `accountNumber`, `bankCode`, `bankName`, `pin`, `idempotencyKey` |
| `requestWithdrawal` | LIVE 08-22 | **1** — `seller-wallet.html` | **`withdrawals`** | **CENTS** (`amountCents`, integer, min 10000) | `method`, `accountDetails{}` |
| `requestPayout` | LIVE 08-22 | **1** — `sokoni-finos.js` | `wallets` | — | — |
| `walletV2SavingsWithdraw` | LIVE 08-22 | **2** — `sfos-core.js`, `sokoni-wallet-v2.js` | **not in this tree** | — | — |
| `finosRequestBankPayout` | LIVE 08-22 | **1** — `sokoni-aos.js`, and it calls `action:"reject"` (an **admin** action, not a merchant withdrawal) | — | — | — |
| `initiateSellerPayout` | LIVE 08-22 | **0** | — | — | — |

## The finding that must be settled first

**Two live withdrawal paths use different money units.**

```
requestWithdrawal    amountCents : 10000  ->  KES    100
requestSellerPayout  amount      : 10000  ->  KES 10,000
```

A **100× divergence** between two deployed callables that both take a number called an
amount and both debit merchant money. Any converged authority must state the unit on both
sides of every assignment, and any migration must convert rather than pass through.

This is the same failure shape as the rules ceiling (source characters compared to compiled
bytes) and the commission ladder (fraction vs percent). It is now the third instance.

## Provisional reading — NOT yet a retirement decision

- **`requestSellerPayout` looks canonical**: six callers, the canonical `payoutRequests`
  collection, shillings, a full destination parameter set, and it is the one the frozen
  wallet engine owns.
- **`initiateSellerPayout` has no client caller** — a retirement candidate.
- **`finosRequestBankPayout` may not be a withdrawal surface at all** — its only caller
  passes an admin `reject` action.
- **`walletV2SavingsWithdraw` is deployed from a lineage not present in this tree.** Its
  source, collection and balance authority are unknown here.

None of this is sufficient to retire anything. A callable with no client caller in this tree
may still be invoked by another lineage, a scheduled job, or a client version still in the
wild.

## TRAFFIC: UNPROVEN, and why

**No traffic figure is recorded here, because none was obtained.**

An initial query returned 4–5 log entries for every surface — including
`initiateSellerPayout`, which has zero callers. Uniform results across a surface known to
differ is the signature of a broken probe, and a follow-up returned empty for the same
filter. These are **gen2 functions (Cloud Run-backed)**, so `resource.type=cloud_function`
does not match them.

What would actually establish it, none of which has been done:
- Cloud Run request-count metrics per service, or logging filtered on the gen2 resource type
- `payoutRequests` / `withdrawals` document counts and most-recent `createdAt` per collection
- a production read of which collections hold rows at all

**Until then, "which paths carry traffic" is open**, and Phase 1's retire-vs-migrate
decision cannot be made.

## Balance authority and status vocabulary — still open

Not yet established per surface: which balance field each one decrements
(`balance` / `available` / `availableBalance`), and which status vocabulary each writes.
`wallet.js` alone uses ten statuses. This must be frozen before the quote engine is built,
per the locked contract.

---

# Phase 0 · Step 2 — production census (read-only)

**Date:** 2026-09-02. Firestore REST, user credentials. **No writes. No payouts.**
Values are never printed — counts, field names and timestamps only, so no PII left Firestore.
Control: an absent collection returned **0**, so the census discriminates.

## Row counts

| collection | rows |
|---|---|
| `payoutRequests` | **7** |
| **`withdrawals`** | **0** |
| `wallets` | 74 |
| `walletTransactions` | 46 |
| `commissionLedger` | 11 |
| `posPayments` | 9 |
| `sellerPayments` | 2 |
| *control (absent)* | 0 |

## The unit question is settled on the evidence

**`withdrawals` is EMPTY.** `requestWithdrawal` — the `amountCents` path in `commission.js`
— has **never successfully written a production row**. `payoutRequests`, written by
`requestSellerPayout` in shillings, holds every withdrawal this platform has processed.

That does **not** prove `requestWithdrawal` is never *called* — a client can invoke a
callable that fails before writing. But it does establish that **no production withdrawal
has ever been recorded in cents**, so the shillings interpretation is the one with
production history behind it. The cents path is a retirement candidate, not a migration
target.

## The entire production withdrawal history is 7 rows

| status | mode | method | fee | netAmount | amount | intasendRef |
|---|---|---|---|---|---|---|
| failed | review | mpesa | 0 | 100 | 100 | yes |
| failed | review | mpesa | 0 | 1000 | 1000 | yes |
| rejected | — | mpesa | — | — | 100 | no |
| paid | review | mpesa | 0 | 100 | 100 | yes |
| paid | review | mpesa | 0 | 100 | 100 | yes |
| paid | review | mpesa | 0 | 100 | 100 | yes |
| paid | review | mpesa | 0 | 100 | 100 | yes |

Latest `createdAt` 2026-08-25, latest `updatedAt` 2026-08-28.

**Five findings, each of which changes the plan:**

1. **Only three statuses have ever been written**: `paid` (4), `failed` (2), `rejected` (1).
   The ten-status vocabulary found in `wallet.js` is **mostly theoretical** — seven of them
   have no production instance. Freezing the vocabulary is therefore a far smaller migration
   than the code implied.
2. **`fee` is 0 on every row, and `netAmount` always equals `amount`.** The schema already
   carries `fee` and `netAmount` — so the fee model exists at the data level — but **no fee
   has ever been charged.** The engine is greenfield in behaviour, not in schema.
3. **`mode` is `review` on every row.** No payout has been automatic; all went through
   review. Consistent with auto-B2C being off.
4. **`method` is `mpesa` on every row.** Till and PayBill have never been used, so there is
   no legacy destination behaviour to preserve.
5. **Maximum amount ever withdrawn: KES 1,000.** Six of seven are KES 100. This looks like
   test traffic, not merchant earnings at scale.

**Consequence: convergence is far less risky than the code fragmentation suggested.** The
frozen engine has almost no production history to protect — seven rows, three statuses, one
method, zero fees.

## Balance authority — settled

`wallets` (6 sampled of 74): **`balance` present on 6/6**, with `currency`, `uid`,
`createdAt` also universal. Everything else is sparse v2 territory — `savingsBalance`,
`cashbackBalance`, `pendingBalance`, `escrow`, `tier`, `pinHash`, `dailyLimit`,
`monthlySpent` — each on 1–2 of 6.

**`available` and `availableBalance` do not appear in production data at all.** They exist in
code but no document carries them. So the canonical withdrawable field is **`balance`**,
confirmed by data rather than by convention, and the six-name divergence is a *code* problem,
not a *data* problem.

## Still open

- **Gen2 request metrics.** Row counts answer "what was written", not "what was called".
  `requestWithdrawal` may be receiving traffic and failing. This needs Cloud Run request
  counts per service — `resource.type=cloud_function` does not match gen2 functions.
- **`walletV2SavingsWithdraw`** — source lineage not in this tree; `savingsBalance` appears
  on 1 of 6 sampled wallets, so the surface is at least partly real.
- **`finosRequestBankPayout`** — still unconfirmed as admin-only.
- **`requestPayout` / `initiateSellerPayout`** — no collection identified, no rows attributed.

**No surface is retired and nothing is crowned canonical on this evidence alone.**

---

# Phase 0 · Step 3 — Gen2 traffic census (read-only)

**Date:** 2026-09-02. Cloud Monitoring `run.googleapis.com/request_count`, 30-day window
(2026-08-03 → 2026-09-02). No Firestore, no writes, no payouts.

**The earlier attempt failed because the filter was wrong**, not because traffic was absent:
all 1,711 functions are **GEN_2**, i.e. Cloud Run services keyed by a *lowercased*
`service_name`. `resource.type=cloud_function` never matched them.

**Control:** 462 services seen, **457 with traffic**, busiest ~104,000 requests
(`oninventoryupdated`). The metric demonstrably reports traffic, so a zero is a real zero.

| callable | requests (30d) | rows written | verdict |
|---|---|---|---|
| `requestSellerPayout` | **3** | 7 (`payoutRequests`) | live, and writing |
| **`requestWithdrawal`** | **2** | **0** (`withdrawals`) | **live, and NOT writing** |
| `requestPayout` | 0 | — | no time series at all |
| `walletV2SavingsWithdraw` | 0 | — | no time series at all |
| `finosRequestBankPayout` | 0 | — | no time series at all |
| `initiateSellerPayout` | 0 | — | no time series at all |

## The finding that matters

**`requestWithdrawal` was invoked twice in the last 30 days and produced zero rows.**

This is exactly the case row counts alone could not see. It is being called — from
`seller-wallet.html`, its only known caller — and nothing reached `withdrawals`. Either it
rejects before writing (its `amountCents` minimum of 10000 rejects any request under
KES 100, and a UI sending **shillings** into a **cents** parameter would send `100` for a
KES 100 request and be rejected as below minimum), or it fails later.

**That is a plausible live merchant-facing withdrawal failure**, and it is the 100× unit
divergence showing up in production behaviour rather than in code review. It is a defect to
diagnose, not a surface to quietly retire — retiring it would remove the only evidence that
a caller exists.

**Not yet established:** whether those two invocations errored, and with what. That needs the
request's response codes or the function's own logs, filtered on the gen2 resource type.

## Classification on the evidence so far

| class | surface | basis |
|---|---|---|
| **Canonical candidate** | `requestSellerPayout` | 3 requests, 7 rows, `payoutRequests`, shillings, full destination params, 6 client callers |
| **Live but failing — investigate** | `requestWithdrawal` | 2 requests, 0 rows, cents contract |
| **No traffic in window** | `requestPayout`, `initiateSellerPayout` | no time series |
| **No traffic, separate domain** | `walletV2SavingsWithdraw` | no time series; `savingsBalance` is a savings concern, not merchant payout |
| **No traffic, likely admin** | `finosRequestBankPayout` | no time series; its only caller passes `action:"reject"` |

**Zero requests in a 30-day window is not proof of unreachability.** A longer window, another
region, or a client released after the window could still call it. Retirement remains an
owner decision, not a conclusion from this table.

---

# Phase 0 · Step 4 — `requestWithdrawal` diagnosed (read-only)

**Date:** 2026-09-02. Cloud Monitoring + source. No writes.

## The anomaly, resolved

30-day window: 2 invocations, 0 rows in `withdrawals`. Response codes:

| surface | code | n |
|---|---|---|
| `requestWithdrawal` | **401 unauthenticated** | **2** |
| `requestSellerPayout` | 200 | 2 |
| `requestSellerPayout` | 401 | 1 |
| *control* `oninventoryupdated` | — | 104,548 |

**Both invocations were rejected 401 before reaching any validation.**

## This refutes the hypothesis I had been carrying

Earlier notes recorded this as *"live, and NOT writing"* and speculated it was the 100×
unit divergence — a UI sending shillings into `amountCents` and being rejected below the
10000-cent minimum. **That is wrong on three counts:**

1. **The calls were 401, not 400.** They never reached the amount check, so the unit
   contract played no part.
2. **The client converts correctly.** `seller-wallet.html:498` sends
   `amountCents: Math.round(amount*100)`. It was never sending shillings.
3. **The call site is unreachable.** `submitWithdrawal()` at line 474 begins:

```js
toast('Withdrawals now happen in your SOKONI Wallet — taking you there…','success');
setTimeout(function(){ location.href='wallet.html'; }, 900);
return;
/* eslint-disable no-unreachable */
```

An unconditional `return`, with an explicit `no-unreachable` disable acknowledging the code
below is dead. **Withdrawals were already converged into the SOKONI Wallet**, and the
comment at line 476 says so: *"The legacy requestWithdrawal is retired."*

The 100× divergence between the two callables' contracts is **real and still worth
eliminating** — it is why the new engine uses `Money{minorUnits}` — but it caused none of
this. A tidy explanation with no evidence behind it is still wrong.

## Reclassified

Previously: *live but failing — investigate before retiring; retiring it would delete the
only evidence a caller exists.*

**Now: a retirement candidate.** Zero rows is fully explained by zero authenticated calls.
No failing write needs to be posited, and no merchant is being blocked by it.

**Caveats that keep it from being a decision:**
- Unreachable **in this tree**. Another lineage, or a cached client still serving the old
  page, could reach it. Hosting serves the working tree, and this file is untracked.
- Something *is* hitting the endpoint — 2 unauthenticated calls in 30 days. Scanner, stale
  client, or signed-out user is **not** established; that needs caller identity, not this
  metric.
- `requestSellerPayout` also shows a 401, so occasional unauthenticated traffic is not
  unique to this surface and is not itself a signal.

## What this unblocks

Phase 1's retire-vs-migrate question for this surface now has evidence: **no production
withdrawal has ever succeeded through it, and its only caller is dead code behind a redirect
to the converged Wallet path.** The remaining zero-traffic surfaces — `requestPayout`,
`initiateSellerPayout`, `walletV2SavingsWithdraw`, `finosRequestBankPayout` — have **not**
been diagnosed and should get the same treatment before any of them is touched.

---

# Phase 0 · Step 5 — the remaining four surfaces, diagnosed

**Date:** 2026-09-02. Cloud Monitoring (42d) + source over the deploy footprint (1,148
shipped files) + read-only Firestore census. No writes.

## First: the 30-day window was misleading

Step 3 reported "NO SERIES — never invoked" for all four. **At 42 days every one of them has
traffic.** Cloud Monitoring retains roughly six weeks; a 30-day window silently truncated it.

**"No time series in the window" was never the same claim as "not invoked", and reading it
as the latter would have retired live surfaces.** The control surface tells the same story:
`requestSellerPayout` at 30d showed 3 requests; at 42d it shows
`{200:7, 400:2, 401:4, 403:1, 429:1}` — 15 requests, and **7 successes exactly matching the
7 rows in `payoutRequests`.**

## The four

| surface | traffic (42d) | callers in deploy footprint | writes |
|---|---|---|---|
| `requestPayout` | `401×2` — never past auth | 1, **reachable** — `sokoni-finos.js:110` | **`payouts`** |
| `initiateSellerPayout` | `403×1` — never past auth | **none** | settlements, paymentLedger, auditLogs, fraudBlocklist, fraudLog, securityEvents, settlementQueue, users, sellerSubscriptions |
| `walletV2SavingsWithdraw` | **`503×1`** | 2, reachable — `sfos-core.js:619`, `sokoni-wallet-v2.js:1314` | **source not in this tree** |
| `finosRequestBankPayout` | `401×1`, **`503×1`** | 1, reachable — `sokoni-aos.js:850`, passing `action:"reject"` | payouts, wallets, finosSnapshots, escrows, fraudAlerts, receipts, emailQueue |

**No surface has had a single successful (2xx) invocation in 42 days.** `requestSellerPayout`
is the only withdrawal surface that has.

## Three findings the earlier inventory missed

**1. A FOURTH withdrawal collection.** `requestPayout` writes **`payouts`** — not
`payoutRequests`, not `withdrawals`, not `wallets`. The earlier inventory recorded "no
collection identified" for it. Censused: **0 rows.**

Collections modelling one concept: `payoutRequests` (7) · `withdrawals` (0) · `payouts` (0)
· plus `settlements` (0), `settlementQueue` (0), `paymentLedger` (0) touched by
`initiateSellerPayout`. **Only `payoutRequests` holds anything.**

**2. Two surfaces returned `503`, not an auth code.** `walletV2SavingsWithdraw` and
`finosRequestBankPayout` each served a **503 — the service failed to respond at all**, which
is a different failure from a rejection: a cold-start failure, a crash, or an unhealthy
revision. It is not evidence about authorization, and it should not be filed alongside the
401s. **Not diagnosed here.**

**3. `initiateSellerPayout` has no caller and the widest write surface of any of them** —
nine collections including `fraudBlocklist`, `securityEvents` and `users`. A callable with
no client caller, a 403, and the authority to write user records deserves its own look
before it is either retired or left alone.

## Classification — only where the evidence reaches

| surface | classification | basis |
|---|---|---|
| `requestSellerPayout` | **RETAIN** — the live withdrawal path | 7×2xx, 7 rows, 6 callers |
| `requestWithdrawal` | **RETIREMENT CANDIDATE** | caller behind an unconditional `return`; 401s only |
| `requestPayout` | **UNDECIDED** | reachable caller, 0 rows, writes a 4th empty collection |
| `initiateSellerPayout` | **UNDECIDED — investigate** | no caller, 403, 9 collections incl. `users` |
| `walletV2SavingsWithdraw` | **SEPARATE DOMAIN, undiagnosed** | savings, not merchant payout; **source absent from this tree**; a 503 |
| `finosRequestBankPayout` | **LIKELY ADMIN, undiagnosed** | its only caller sends `action:"reject"`; a 503 |

## Still not established

- **Reachability.** No traffic in 42 days is not unreachability. Another lineage or a cached
  client can still call any of these, and hosting serves the working tree.
- **The two 503s.** Why the service failed to respond is unknown and is not an auth question.
- **`walletV2SavingsWithdraw`'s implementation.** It is deployed from a lineage this tree
  does not contain, so its collection, balance authority and domain cannot be read here.
- **Whether `initiateSellerPayout` is dead or merely idle**, given it has no caller but
  significant write authority.

Nothing is retired, redirected or migrated on this evidence.

---

# WITHDRAWAL PROVENANCE GATE — `requestPayout`

**Observation window:** 42 days (2026-07-22 → 2026-09-02)
**Environment:** production, Gen2 (Cloud Run)
**Known-busy control:** `onInventoryUpdated` = **115,815** requests in the same query
**Live-surface control:** `requestSellerPayout` = `{200:7, 400:2, 401:4, 403:1, 429:1}`

> A first attempt at this query returned **0 for the control**, which had reported 115,755
> minutes earlier. The filter escaping had collapsed in an inline shell invocation. The
> control caught a broken probe before it could be read as "no traffic" — which is the
> second time in this programme a control has done exactly that.

| # | dimension | verdict | evidence |
|---|---|---|---|
| 1 | Caller / lineage | **PROVEN** | one wrapper, `sokoni-finos.js:110`, exported `:250`. Loaded **only** by `finos.html`, which uses `FS.formatKES` for display and **never calls the payout wrapper**. `wallet.html:1529`'s `W2.requestPayout()` is a **name collision** — it calls `requestSellerPayout` (`sokoni-wallet-v2.js:1028`). **No page invokes this callable.** |
| 2 | Authentication | **PROVEN** | `_assertAuth(request)` is the first statement (`finos.js:25` → `HttpsError('unauthenticated')`). 42d traffic `{401:2}` confirms it fires and that **no authenticated call has arrived**. |
| 3 | Authorization | **PROVEN ABSENT (unreached)** | no role or ownership check exists before the throw. The dead code below scopes to `_uid(request)` only — self-service, no admin path. |
| 4 | Validation reached | **PROVEN NOT REACHED** | line 348: an **unconditional** `throw new HttpsError('failed-precondition', '…This method is retired.')`, followed by `/* eslint-disable no-unreachable */`. No input is ever validated. |
| 5 | Write collection | **PROVEN** | `db.collection('payouts')` — a **fourth** payout collection. Censused **0 rows**, consistent with the code being unreachable. |
| 6 | Balance authority | **PROVEN DIVERGENT** | dead code reads `wallet.availableBalance`. The retirement comment states why: *"earnings now converge into wallets.balance … this FinOS payout reads availableBalance and would **double-pay** against the swept balance."* And `availableBalance` appears in **no production wallet document**. |
| 7 | Money unit | **PROVEN** | `amountCents` — CENTS. Minimum **100 cents = KES 1**, a **third** minimum: `requestWithdrawal` requires 10000 cents (KES 100), `requestSellerPayout` requires 100 **shillings**. |
| 8 | Status vocabulary | **PROVEN (unreached)** | writes `status:'pending'` with `attempts`, `retryAt` — a retry-shaped lifecycle distinct from `payoutRequests`' ten statuses. |
| 9 | Idempotency | **PROVEN DEFECTIVE (unreached)** | `generateIdempotencyKey(['payout_request', uid, String(amountCents), String(Date.now())])` — the key **includes `Date.now()`**, so every retry produces a different key. It is a unique-id generator, not an idempotency key. |
| 10 | Production role | **PROVEN RETIRED** *(mechanism)* / **UNPROVEN** *(residual traffic)* | the handler retires itself unconditionally and names the hazard. **But why it still received 2 unauthenticated calls in 42 days is not established** — scanner, stale client, or another lineage. Not answerable from this tree. |

## Contradictions found

- **A fourth payout collection.** `payouts` is neither `payoutRequests` (7 rows, canonical)
  nor `withdrawals` (0) nor `wallets`. Empty, and now known to be unreachable.
- **A third money minimum** across three surfaces: KES 1, KES 100 (cents), KES 100
  (shillings). Two different units and three different floors for one concept.
- **A balance field with no production instance.** `availableBalance` is read here and
  appears in no wallet document — the divergence the retirement comment describes.
- **An idempotency key that cannot deduplicate.** Time-seeded, so a client retry double-books
  by construction. Unreachable today; **must not be copied into the new engine.**

## Unresolved lineage

- The **origin of the 2×401** is unknown.
- Whether any **non-tree lineage** still calls it. Hosting serves the working tree, so a
  cached client could hold the old `finos.html`.

## VERDICT

**RETIREMENT CANDIDATE** — stronger than `requestWithdrawal`'s, on two counts: the
**server** retires itself (not merely a dead client call site), and its only wrapper has no
invoking page.

**Retirement is not the same as deletion, and nothing is done here.** The export still
absorbs traffic and returns a clear, correct refusal; removing it converts a 400
`failed-precondition` into a 404 for any caller that still exists. The 401 source should be
identified before the export is removed.

**Must not be revived.** Doing so would re-introduce a double-pay against the swept
`wallets.balance` — stated by the code itself as the reason it was retired.

```
NO CODE CHANGES · NO DEPLOYMENT · NO PRODUCTION WRITES
```

---

# WITHDRAWAL PROVENANCE GATE — `initiateSellerPayout`

**Observation window:** 42 days (2026-07-22 → 2026-09-02)
**Environment:** production, Gen2 (Cloud Run)
**Known-busy control:** `onInventoryUpdated` = **115,875** requests
**Live-surface control:** `requestSellerPayout` = `{200:7, 400:2, 401:4, 403:1, 429:1}`

> **CORRECTION to Step 5.** That step reported this function writing **nine** collections
> including `users` and `fraudBlocklist`, and I used that breadth to argue it was dangerous
> to retire. **That was wrong.** The figure came from a fixed 220-line scan window that bled
> into neighbouring functions. Bounded properly by brace-matching, `initiateSellerPayout`
> spans lines **9215–9273 (59 lines)** and writes **three** collections: `settlements`,
> `paymentLedger`, `auditLogs`. The conclusion still holds — but not for the reason given,
> and the reason given was an artifact of my own tooling.

| # | dimension | verdict | evidence |
|---|---|---|---|
| 1 | Caller / lineage | **PROVEN NONE** | no caller anywhere — not in the deploy footprint, not in `functions/`, not admin tooling. The only other match in the repo is its own `console.error` string. |
| 2 | Authentication | **PROVEN** | `request.auth` required; a missing token yields `permission-denied`. |
| 3 | Authorization | **PROVEN — ADMIN ONLY** | `request.auth.token.admin` is required (line 9218) → `HttpsError('permission-denied', 'Admin only.')`. The 42d `{403:1}` is exactly this: one non-admin caller turned away. |
| 4 | Validation reached | **UNPROVEN** | the single 403 never passed the admin check, so `sellerId/amount/phone` validation has not been observed executing. The code path is **live and reachable** — unlike `requestPayout`, there is no retirement throw. |
| 5 | Write collection | **PROVEN** | `settlements`, `paymentLedger`, `auditLogs`. Censused: `settlements` **0**, `paymentLedger` **0**. |
| 6 | Balance authority | **PROVEN — NONE** | it reads **no wallet at all**. No `wallets/{uid}`, no `availableBalance`, no balance assertion. It disburses the `amount` the caller supplies. |
| 7 | Money unit | **PROVEN — SHILLINGS** | `Math.round(Number(amount))` is sent to IntaSend `send-money/mpesa` as `amount`, which takes KES major units. Matches `requestSellerPayout`; differs from the two cents-based surfaces. |
| 8 | Status vocabulary | **PROVEN** | `processing` → `submitted` \| `pending_network`. A **fourth** vocabulary, sharing no values with `payoutRequests`' ten. |
| 9 | Idempotency | **PROVEN — NONE** | no key, no `checkIdempotency`, and `settlements.doc(ref).set()` — **`set`, not `create`**. `ref` defaults to `_genRef("PAY")` = timestamp + 4 random bytes, so **two identical calls disburse twice**; a *repeated* `reference` silently **overwrites** the prior settlement rather than refusing. |
| 10 | Production role | **UNPROVEN** | admin disbursement tooling by shape, but **no caller and no successful invocation** have been observed. Whether it is intended for an admin console, a runbook, or is abandoned is not established. |

## This surface is LIVE, and that is the finding

Unlike `requestWithdrawal` (dead client) and `requestPayout` (server retires itself), there
is **no retirement here**. Given an admin token it will execute, and it calls
**`https://payment.intasend.com/api/v1/send-money/mpesa/`** — real money out.

Three properties make that materially riskier than "unused":

1. **No balance check whatsoever.** The amount is taken from the caller. Nothing verifies
   the seller is owed it, that a wallet covers it, or that it was not already paid.
2. **No idempotency.** A retried call disburses again. The generated `ref` is unique per
   call by construction, so the two disbursements do not even collide.
3. **A failed disbursement still records success.** The IntaSend call is wrapped in
   `catch (e) { console.error(...) }` and execution **continues**. On a network failure
   `disbursementResult` is `null`, `finalStatus` becomes `'submitted'`, and a
   `paymentLedger` entry is written claiming `settlement_initiated`. A non-`PN` error
   response reaches the same place. **The ledger can assert money moved when it did not.**

## Contradictions found

- **A fourth status vocabulary** (`processing`/`submitted`/`pending_network`) alongside
  `payoutRequests`' ten, `payouts`' retry-shaped set, and `withdrawals`' unknown set.
- **`settlements` and `paymentLedger` are both empty**, consistent with no successful
  invocation — but they are *live* targets, not dead ones.
- **It bypasses every control the new authority establishes**: no Money unit discipline, no
  balance authority, no idempotency, no atomic transaction, no fail-closed on provider error.

## Unresolved lineage

- **Why one 403 arrived.** A non-admin caller exists somewhere; scanner, stale console, or
  another lineage is not established.
- **Whether an admin console outside this tree calls it.** Absence here is not absence.

## VERDICT

**UNDECIDED — INVESTIGATE. Do not retire, do not integrate, do not call.**

Retiring it on absence would be wrong: it is admin-gated, live, and may be a documented
runbook step. Integrating it would be worse: it disburses without a balance check, without
idempotency, and records success on failure.

**The safe interim position is the current one** — it has no caller and admin-only access,
so it is not presently disbursing anything. The decision needs an owner who knows whether
admin payout tooling is meant to exist, not more code reading.

**Nothing from this function may be copied into the new withdrawal authority.**

```
NO CODE CHANGES · NO DEPLOYMENT · NO PRODUCTION WRITES
```

---

# WITHDRAWAL PROVENANCE GATE — `walletV2SavingsWithdraw`

**Observation window:** 42 days (2026-07-22 → 2026-09-02)
**Environment:** production, Gen2 (Cloud Run) · GEN_2 · ACTIVE · deployed 2026-08-22 · 256Mi · 60s
**Known-busy control:** `onInventoryUpdated` = 115,875 requests

> **CORRECTION.** Steps 3 and 5 recorded *"source not located in this tree"* and
> *"source absent from this tree"*. **That was wrong.** The source is at
> `functions/wallet-engine.js:1150`, re-exported at `functions/index.js:11889`. My
> diagnostic reported "not located" because I passed that surface **no file to search** —
> a limitation of my own tooling, stated as a fact about the repository. The gate below
> therefore rests on read source, and the dimensions the plan expected to mark UNPROVEN are
> in fact provable.
>
> This is the third time in this programme a tooling limit has been reported as a finding —
> after the empty-block detector (29 vs 1) and the chunk-wise decode (a false DIVERGED). The
> pattern is the same each time: *my instrument could not see it, therefore it is not there.*

| # | dimension | verdict | evidence |
|---|---|---|---|
| 1 | Caller / lineage | **PROVEN** | 2 reachable callers: `sfos-core.js:619`, `sokoni-wallet-v2.js:1314`. Source lineage `31d282c` *"Wallet 2.0 — premium fintech UI + 18 new Cloud Functions"*. |
| 2 | Authentication | **PROVEN** | `_requireAuth(request)` is the first statement. |
| 3 | Authorization | **PROVEN — OWNER-BOUND** | `vault.ownerUid !== uid` → `permission-denied`, checked **inside** the transaction. Plus `_assertNotFrozen(db, uid)`. |
| 4 | Validation reached | **UNPROVEN** | the only observed call was a **503**; no invocation is known to have reached validation. |
| 5 | Write collection | **PROVEN** | `wallets/{uid}` (balance, savingsBalance), `wallets/{uid}/savings/{vaultId}`, `walletTransactions`. |
| 6 | Balance authority | **PROVEN — `wallets/{uid}.balance`** | reads `walletSnap.data().balance`, writes `balance: newBalance` **and** `savingsBalance: increment(-amount)` in one transaction. **This is the canonical balance field** — the same authority the new adapter uses. |
| 7 | Money unit | **PROVEN — SHILLINGS** | `Number(amount)`, minimum *"at least KES 1"*. Matches `requestSellerPayout`. |
| 8 | Status vocabulary | **PROVEN** | writes `status: 'completed'` on a `walletTransactions` row with `type: 'savings_withdrawal'`, `direction: 'in'`, `category: 'savings'`. A **terminal-only** vocabulary — no pending state, because nothing leaves the platform. |
| 9 | Idempotency | **PROVEN — NONE** | `txId = _genId('swth')` is generated per call and written with `t.set()`. A retried call moves the money again. **Mitigated, not solved**, by being an internal transfer: a double call over-withdraws a vault but does not leave the platform. |
| 10 | Production role | **PROVEN — SAVINGS, NOT PAYOUT** | it moves money **vault → wallet**, both inside `wallets/{uid}`. No provider call, no external destination, no IntaSend. It is not a withdrawal from SOKONI at all. |

## It does not belong in the withdrawal domain

Everything it touches is internal:

```
wallets/{uid}/savings/{vaultId}.currentAmount   −amount
wallets/{uid}.balance                           +amount
wallets/{uid}.savingsBalance                    −amount
walletTransactions                              type: savings_withdrawal, direction: 'in'
```

**`direction: 'in'`** is the tell — from the wallet's perspective money is arriving, not
leaving. The name collides with the payout surfaces; the behaviour does not.

It also encodes a product rule the payout surfaces have no equivalent of: a **locked vault**
cannot be withdrawn from before `vault.deadline`, enforced server-side inside the
transaction.

## Production evidence for the domain

| | |
|---|---|
| wallets sampled | 40 of 74 |
| carrying `savingsBalance` | **3** |
| with `savingsBalance > 0` | **0** |
| `walletTransactions` rows | 46 (type distribution not examined) |

So the savings feature exists on a handful of wallets and **holds no money today**. Combined
with the single 503, there is no evidence of a successful savings withdrawal in the window.

## The 503 is a health question, not a role question

One `503` in 42 days: the service failed to respond — unhealthy revision, cold-start failure,
or a crash before the handler ran. **It says nothing about what the function is for, whether
it works, or whether it is needed.** Its cause is **UNPROVEN** and is a separate
investigation from this gate.

## VERDICT

**SEPARATE DOMAIN — SAVINGS. Not a withdrawal surface. Exclude from the withdrawal
authority convergence entirely.**

It is correctly built on the canonical balance field, owner-bound, and transactional. It is
**not** a candidate for retirement, migration, or merger into `payoutRequests` — those
questions do not apply to it.

**Two items it does contribute to the programme:**
1. **Confirmation that `wallets/{uid}.balance` is the live balance authority**, written
   transactionally by a deployed function — independent support for D1=(c).
2. **A missing idempotency key** (`_genId` + `set()`), the same shape as
   `initiateSellerPayout` and `requestPayout`. Three of the five surfaces examined generate
   a unique id and call it idempotency. **The new authority must not.**

**Still UNPROVEN:** why the 503 occurred; whether any savings withdrawal has ever succeeded.

```
NO CODE CHANGES · NO DEPLOYMENT · NO PRODUCTION WRITES
```

---

# WITHDRAWAL PROVENANCE GATE — `finosRequestBankPayout`

**Observation window:** 42 days (2026-07-22 → 2026-09-02)
**Environment:** production, Gen2 (Cloud Run)
**Known-busy control:** `onInventoryUpdated` = 115,875 · **Live control:** `requestSellerPayout` = `{200:7, 400:2, 401:4, 403:1, 429:1}`

> **CORRECTION.** Step 5 reported this writing **seven** collections — `payouts`, `wallets`,
> `finosSnapshots`, `escrows`, `fraudAlerts`, `receipts`, `emailQueue`. Bounded by
> brace-matching it spans **852–916 (65 lines)** and writes **two**: `payouts`, `wallets`.
> Same fixed-window artifact as `initiateSellerPayout`. **Both inflated claims came from the
> same tool, and both were used to argue about risk before being checked.**

| # | dimension | verdict | evidence |
|---|---|---|---|
| 1 | Caller / lineage | **PROVEN — AND MISMATCHED** | one caller, `sokoni-aos.js:850`, reachable. It passes `{payoutId, action:"reject", note}`. **The handler accepts none of those fields.** |
| 2 | Authentication | **PROVEN** | `_assertAuth(request)` first; 42d shows `401×1`. |
| 3 | Authorization | **PROVEN ABSENT (unreached)** | no role check before the retirement throw. Dead code scopes to `_uid(request)` — **seller self-service, not admin.** |
| 4 | Validation reached | **PROVEN NOT REACHED** | unconditional `throw HttpsError('failed-precondition', '…This method is retired.')` before any validation, followed by `eslint-disable no-unreachable`. |
| 5 | Write collection | **PROVEN** | `payouts` (0 rows), `wallets` — both in unreachable code. |
| 6 | Balance authority | **PROVEN DIVERGENT** | dead code reads `availableBalance || balance`. The retirement comment states the hazard: *"reads availableBalance and would double-pay."* |
| 7 | Money unit | **PROVEN — CENTS**, min `100_00` = **KES 1,000** | a **fourth** minimum: KES 1 (`requestPayout`), KES 100 cents (`requestWithdrawal`), KES 100 shillings (`requestSellerPayout`), KES 1,000 here. |
| 8 | Status vocabulary | **PROVEN (unreached)** | `status: 'pending_review'` — *"Bank transfer — requires admin manual processing"*. A fifth vocabulary. |
| 9 | Idempotency | **PROVEN DEFECTIVE (unreached)** | `generateIdempotencyKey(['bank_payout', uid, String(amountCents), String(Date.now())])` — **time-seeded**, identical to `requestPayout`. |
| 10 | Production role | **PROVEN — SELLER BANK PAYOUT REQUEST, retired.** **NOT admin.** | the handler is a seller-initiated bank transfer request. Step 5's "likely admin" was inferred **from the caller**, and the caller is wrong. |

## The finding: an Admin OS control is calling the wrong function

In one file, two adjacent handlers:

```js
async function approvePayout(id) {
  await _call("adminProcessPayout", { requestId: id, status: "approved" });   // correct
}
async function rejectPayout(id) {
  await _call("finosRequestBankPayout", { payoutId: id, action:"reject", note });  // WRONG
}
```

`adminProcessPayout` (`functions/wallet.js`) takes `{requestId, status, note}` and
**explicitly accepts `'rejected'`**: `validStatuses = ['approved','rejected','paid']`. It is
the obvious counterpart to `approvePayout` and the evident intent.

Instead, **Reject** calls a **retired seller bank-payout request**, which:
- accepts none of the fields sent,
- throws `failed-precondition` unconditionally,
- surfaces to the operator as `_toast(e.message, "error")` —
  *"Withdrawals now go through your SOKONI Wallet (Wallet → Withdraw). This method is retired."*

**Approve works. Reject cannot.** An admin rejecting a payout gets an error about SOKONI
Wallet withdrawals, and the payout stays in whatever state it was in.

**Not established:** whether any admin has attempted it. The 42d traffic is `401×1` and
`503×1` — neither is an authenticated admin reaching the retirement throw, which would be a
`400`. So there is **no evidence an admin has clicked Reject in the window**, and none that
they have not.

## VERDICT

**Two verdicts, because there are two artifacts.**

**The callable — RETIREMENT CANDIDATE.** Server-side unconditional retirement, same as
`requestPayout`, same stated double-pay hazard, same time-seeded key. Must not be revived.

**The caller — LIVE DEFECT, out of scope for this gate.** `sokoni-aos.js:850` is a broken
Admin OS control. Fixing it is a one-line change to a client file (`finosRequestBankPayout`
→ `adminProcessPayout` with `status:'rejected'`), but it is a **client behaviour change on
an admin money surface** and belongs in its own authorized slice with its own evidence —
not folded into a provenance gate.

**Retiring the callable before fixing the caller would turn a clear error message into a
404.** Order matters: fix the caller first, then retire.

```
NO CODE CHANGES · NO DEPLOYMENT · NO PRODUCTION WRITES
```
