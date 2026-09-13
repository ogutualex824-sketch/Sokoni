# Step 2 — Identity Reconciliation Matrix (`shopId` / `sellerUid` / `storeId`)

**Status:** CENSUS ONLY — no code edited, no data written, nothing deployed
**Verdict:** 🟡 **AMBER** — an authoritative mapping exists, but using it requires design, not a query rewrite
**Date:** 2026-09-13
**Related:** [[DELIVERY_STEP1_READER_CONVERGENCE]] · [[project_store_identity_gate]]

---

## 1. The contract, from the producer

`application-lifecycle.js:777-778` — `projectSeller`, the canonical shop projection:

```js
const declared = app.shopId && !isPlaceholderShopId(app.shopId) ? String(app.shopId) : null;
const shopId   = declared || String(uid);
```

and `isPlaceholderShopId` rejects only six tokens:

```js
PLACEHOLDER_SHOP_IDS = ['main', 'default', 'branch', 'null', 'undefined', '']
```

**So `shopId === sellerUid` is a DEFAULT, not an invariant.** Any application supplying a real
`shopId` string produces `shopId ≠ uid`. The branch is live, reachable, and gated only by a
six-token blacklist. The projection itself records which path was taken —
`shopIdSource: declared ? 'application.shopId' : 'account_shop'` — which is an admission by the
code that the two are not the same thing.

This settles the contradiction found in Step 1: `index.js:3147` passing `shopId: after.sellerUid`
is correct **only** on the default path and silently wrong on the declared path.

---

## 2. Identity matrix

| Field | Authoritative source | Meaning | Cardinality | Historical coverage | Deterministic? |
|---|---|---|---|---|---|
| `shops/{shopId}` doc id | `projectSeller` | the shop's identity | 1 per shop | 2 live shops | — |
| `shops/{shopId}.ownerId` | `projectSeller` (`ownerId: String(uid)`) | **the owning seller** | **exactly 1 per shop** | 2/2 present | ✅ **YES — shopId → sellerUid** |
| `packageRequests.sellerUid` | `delivery-complete.js`, `index.js:8645`, `pos-marketplace-sync.js` | the selling account | 1 per request | **13/13** | ✅ present |
| `packageRequests.shopId` | **no producer** | — | — | **0/13 — field never written** | ❌ absent |
| `users/{uid}.activeShopId` | `projectSeller` | the account's active shop | 1 per user | present for the live seller | ⚠️ "active", not "all" |
| sellerUid → shopId (reverse) | none | — | **1 : N permitted** | untested | ❌ **NOT deterministic** |

### Measured corpus

```
shops              2     both have documentId == ownerId
owners with >1 shop 0
packageRequests   13     from exactly ONE distinct sellerUid
that sellerUid        resolves: shops/{sellerUid} exists, activeShopId == uid
```

---

## 3. Why this is AMBER and not GREEN

**The forward mapping is deterministic and authoritative.** `shops/{shopId}.ownerId` gives the
owning seller, exactly one per shop. It is *read*, never inferred — and `logistics-plus._assertRole`
**already loads that very document** to authorise the caller. Nothing needs to be guessed.

Three things stop this being GREEN:

**(a) The reverse direction is not deterministic, and that is the direction a redirect needs.**
`logistics-plus` asks "deliveries for shop X". `packageRequests` can only be filtered by
`sellerUid`. Resolving `shopId → ownerId → sellerUid` and querying on it returns rows for **every
shop that owner holds**. Today that is harmless (0 owners hold more than one shop). The moment one
does, a shop-scoped analytics endpoint silently aggregates a *sibling shop's* deliveries — a
cross-shop data leak introduced by the redirect itself, not present today.

**(b) The evidence base cannot support an invariant.** 2 shops, 1 distinct seller — and that seller
is the same identity that appears everywhere else in this system (the driver, the sandbox config).
`n=1` establishes that the declared-shopId branch *has not fired here*, not that it cannot.

**(c) The redirect would be INERT anyway.** `packageRequests` has no `shopId` field and **no
producer writes one**. A `where('shopId','==',X)` against it returns empty — Firestore does not
error on an absent field. So a naive repoint changes nothing; a working redirect requires either a
query rewrite onto `sellerUid` (which inherits defect (a)) or writing `shopId` at creation time.

---

## 4. Recommended canonical contract

> **`shops/{shopId}.ownerId` is the authoritative shop→seller mapping and must be READ, never
> inferred from `sellerUid === shopId`.**
>
> **`packageRequests` should carry `shopId` written by its producers at creation**, rather than
> having consumers reconstruct it. A delivery belongs to a shop; that fact should be recorded
> where the delivery is created, not derived downstream by every reader.

This makes the four `logistics-plus` sites a straight field-for-field redirect with no inference
and no cross-shop leakage — but it is a **producer change plus a backfill decision for the 13
historical records**, which is design work, not a redirect. Hence AMBER.

The 13 historical records **are** deterministically mappable (their single `sellerUid` resolves to
exactly one shop), so a backfill is feasible — but it is a data write and belongs in its own gate.

---

## 5. Affected consumers

| Consumer | Blocked by | Unblocked if |
|---|---|---|
| `logistics-plus.js` 736, 763, 794, 815 | no `shopId` on `packageRequests` | producers write `shopId` + historical backfill |
| `index.js:3147/3164/3179` analytics | assumes `shopId === sellerUid` | **pre-existing defect, independent of this step** — wrong today for any declared-shopId seller |
| Step 1 redirect gate | the above | — |

**`index.js:3147` is a live defect this census exposed**, not something the redirect creates. It is
currently correct only because no seller has a declared shopId. It should be recorded separately.

---

## 6. Unresolved ambiguity

1. **Is one seller allowed multiple shops?** Nothing in the projection prevents it; `activeShopId`
   implies a *set* with one active member. Product decision, not an engineering finding.
2. **Is `storeId` a third name for this?** `firestore.rules` uses `shops/{storeId}`; the projection
   uses `shopId`. Same path, two names — cosmetic here, but it is how the Business→Store question
   became confusing in the first place.
3. **Should historical `packageRequests` be backfilled**, or should readers treat pre-backfill
   records as out of scope? A cutoff is cheaper and loses August analytics that nobody currently sees.

---

## 7. Verdict

🟡 **AMBER.** A deterministic authoritative mapping exists (`shops/{shopId}.ownerId`) and requires
no inference. But the redirect direction the consumers need is not deterministic under a permitted
1:N ownership model, `packageRequests` carries no shop identifier at all, and the corpus (2 shops,
1 seller) cannot establish an invariant.

**Per the gate's own rule, we stop here rather than inventing the identity relationship.** The
narrowly scoped `logistics-plus` redirect gate should NOT open. What could open instead, each on
its own evidence:

* a **producer contract gate** — write `shopId` onto `packageRequests` at creation
* a **backfill gate** — the 13 historical records, deterministically mappable, as a data write
* a **defect record** for `index.js:3147`'s `shopId === sellerUid` assumption

Nothing in this document authorises any of them.
