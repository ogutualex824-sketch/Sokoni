# Delivery Rail Convergence — `packageRequests` is canonical

**Status:** decision recorded, census complete, **no code changed, nothing deployed**
**Date:** 2026-09-13
**Decision owner:** platform owner
**Related:** [[DELIVERY_D1_VERIFICATION_CONTRACT]] · [[project_delivery_rider_selfmint_live]]

---

## Decision

> `packageRequests` + the DL-01 Cloud Functions path is the **canonical** delivery
> assignment and fulfilment workflow. Root `deliveries` is a legacy parallel rail and
> **must not become an independent delivery authority.**

`deliveries` is **not** deleted by this decision. Retirement is a later, explicit gate; this
document establishes the evidence and the plan.

---

## Why two rails exist

| | Server rail — **canonical** | Client rail — **legacy** |
|---|---|---|
| Records | `packageRequests` — **13** | `deliveries` — **0** |
| Queue | `dispatchQueue` — 0 | — |
| Presence | `rideDrivers`, `drivers` | `deliveryRiders` (2), `deliveryLocations` (1) |
| Proof of delivery | — | `deliveryProofs` — **0** |
| Producer | `sokoni-delivery.js` | `delivery-hub.js:327` |
| Authority | Cloud Functions, DL-01 gated | **100% client-side, zero CF involvement** |
| Pricing | server calculation | own `VEHICLES` table (`base`/`perKm`) |

Both rails are loaded by `driver.html` and `delivery-tracking.html`, so those pages
currently host two delivery systems at once.

---

## Census findings that drive the plan

### 1. There is no server producer of root `deliveries`

Every root-`deliveries` reference in `functions/*.js` is a **read**:

| File | Line | Operation |
|---|---|---|
| `automation-engine.js` | 433 | read |
| `ecc.js` | 135 | read (health probe, `limit(1)`) |
| `email-triggers.js` | 836 | read |
| `fulfilment-scan.js` | 188 | read by doc id |
| `index.js` | 1546 | read `where orderId` |
| `index.js` | 5713 | **count** `where status in ['assigned','in_transit']` |
| `logistics-plus.js` | 736, 763, 794, 815 | read `where shopId` |

The **only** producer is `delivery-hub.js:327`, client-side.

### 2. Those ten server readers are already dead

Because the only producer has created **zero** records, every one of those reads returns
empty **today**. Shop delivery analytics, the active-delivery count, the order→delivery
lookup, fulfilment scan and the email trigger all silently resolve to nothing.

**This is a pre-existing defect, not a consequence of the decision.** It also means
blocking `deliveries` costs nothing in behaviour: the consumers already receive nothing.

### 3. `deliveries` is a NAME COLLISION — two unrelated things share the word

**Not the delivery rail, must never be swept:**

* `webhooks/{uid}/endpoints/{hookId}/deliveries` — webhook attempt log (`developer-portal.js:186`)
* `{webhookDoc}/deliveries` — webhook attempt log (`inventory-webhooks.js:77`)
* `…/{tenantId}/deliveries/{deliveryId}` — tenant-scoped, `firestore.rules:3050`

These are **subcollections** at different paths. A name-based sweep destroys webhook
logging. This is the `mpesa-c2b.js` lesson repeating: **classify by path and endpoint,
never by name.**

### 4. Rules: exactly one root block, so a block would be effective

`firestore.rules:1900` is the sole **root-level** (`indent 4`) `match /deliveries/{deliveryId}`.
The only other is tenant-nested at `indent 8`, a different path. There is therefore **no
duplicate-match UNION hazard** — see [[reference_firestore_duplicate_match_or]], where a
`write:false` is void because a second block allows.

### 5. The create rule restricts no fields

```
allow create: if isAuthed() && request.resource.data.senderUid == request.auth.uid;
```

`deliveryFee` and `proofPIN` are protected on **update** but not on **create**, so the
sender sets the fee at creation. Client-set money — on a rail that has never been used.

---

## Consumer classification

| Consumer | Path | Class | Rationale |
|---|---|---|---|
| `delivery-hub.js:327` create | root | **BLOCK** | the only producer; blocking prevents the second rail becoming populated during convergence |
| `delivery-hub.js` updates (127, 378, 431, 609) | root | **BLOCK** (by consequence) | nothing to update once creation is blocked |
| `logistics-plus.js` ×4 | root | **REDIRECT** | shop delivery analytics should read `packageRequests`; currently always empty |
| `index.js:5713` count | root | **REDIRECT** | active-delivery count should read `packageRequests` |
| `index.js:1546` order lookup | root | **REDIRECT** | order→delivery join belongs on the canonical rail |
| `fulfilment-scan.js:188` | root | **REDIRECT** | |
| `automation-engine.js:433` | root | **REDIRECT** | |
| `email-triggers.js:836` | root | **REDIRECT** | |
| `ecc.js:135` | root | **RETAIN** | health probe only; reads `limit(1)`, indifferent to contents |
| `developer-portal.js:186` | **subcollection** | **RETAIN — DO NOT TOUCH** | webhook log, unrelated |
| `inventory-webhooks.js:77` | **subcollection** | **RETAIN — DO NOT TOUCH** | webhook log, unrelated |
| tenant `deliveries` (rules:3050) | **nested** | **RETAIN — DO NOT TOUCH** | different path and tenancy model |

---

## Proposed blocking mechanism (NOT YET AUTHORIZED)

**One line, in rules, not in code.**

```
allow create: if false;   // root /deliveries — rail retired, see DELIVERY_RAIL_CONVERGENCE.md
```

Rules are chosen over a client edit because they are **server-enforced**: a stale or
modified client cannot bypass them, and no client deploy is required. A code-only block in
`delivery-hub.js` would leave the collection writable by anyone with the served rules.

**Safety argument**

* 0 existing records — nothing is orphaned by blocking creation
* only one producer, and it is the rail being retired
* every server consumer is a read that already returns empty
* exactly one root match block, so the denial cannot be unioned away
* reversible by restoring the clause

**Deliberately NOT proposed here**

* deleting the `deliveries` block or collection
* touching `read`, `update` or `delete` on that block
* touching the tenant-nested or webhook subcollection paths
* editing `delivery-hub.js`, `driver.html`, `delivery-tracking.html` or `delivery.html`
* the REDIRECT work — that is implementation, and it is a separate gate
* any rules deployment: **this document proposes, it does not deploy**

---

## Sequence from here

```
A. rail decision            DONE — packageRequests canonical
B. pricing authority        DECIDED — server canonical (not yet implemented)
C. money-bearing identity   OPEN — xrH21J5GFbW8… holds a wallet; investigation only
D. implementation           blocking gate, then REDIRECT gate
E. certification            fixture-based financial harness
F. production gate          rules deploy, then functions
```

**Area 4 note.** `riderEarnings`, `driverEarnings`, `earnings` and `payouts` are all **0**,
and no delivery has ever had a rider assigned. The delivery financial path has never
executed in production. Certification therefore cannot be historical — it must be a
deterministic **fixture-based** harness exercising the whole chain, including rejection,
reassignment, cancellation, duplicate callbacks, retry idempotency and ledger
reconciliation.
