# `posProducts` — served-rules verification gate + `seller.js` writer disposition

**Status:** 📋 READ-ONLY GATE — no code, no rules, no deploy, no r1 touch (only scratchpad files
were written; the access token was deleted immediately after the fetch).
**Date:** 2026-09-03 · Upgrades `docs/POSPRODUCTS_RULES_OWNERSHIP_INPUT.md` from "per repo rules"
to **authoritative**, then makes the migration-graph step-2 decision explicit.

---

## 1. Provenance — this is the production ruleset, not a file in the repo

Fetched read-only via the Firebase Rules API (`releases/cloud.firestore` → `rulesetName` →
ruleset source), the same approved path used for the earlier `posPurchaseOrders` question:

```
project      sokoni-aeb26        (gcloud active project; account confirmed)
release      cloud.firestore
ruleset id   1cf1f3f2-8669-4f60-8ccf-70dd24b8c57b
createTime   2026-09-02T13:11:19Z
file         firestore.rules.consolidated-ab   (1 file, 246,602 bytes, 5,365 lines)
```

**Independent corroboration:** ruleset id `1cf1f3f2` and the `consolidated-ab` filename match the
project memory's record of the live structural consolidation ("PUBLISHED `1cf1f3f2` A+B live",
`project_rules_structural_consolidation`) — recorded before this gate, by a different method.

**Controls run against the fetched source (18/18):**
- probe validity — non-trivial size, `rules_version`/`service` header present, a nonsense
  collection name is **not** found (the extractor does not match vacuously)
- positive control — `match /packageRequests/` present **and** carries the
  `assignedDriverId == request.auth.uid` driver-read clause the live PIN flow depends on
- absent control — `match /deliveryPins/` **absent** (deny-by-default, exactly as the live
  `test-delivery-pin-unreachable.js` runs proved earlier this session)

## 2. The finding — served text, verbatim

```
match /posProducts/{productId} {
  allow create: if claimsPosOwner()
                && request.resource.data.name is string
                && request.resource.data.name.size() > 0
                && request.resource.data.price is number
                && request.resource.data.price >= 0;
  allow read:   if isPosOwner() || isAdmin();
  allow update: if isPosOwner() || isAdmin();
  allow delete: if isPosOwner() || isAdmin();
}
function isPosOwner()     { return isAuthed() && resource.data.sellerId         == request.auth.uid; }
function claimsPosOwner() { return isAuthed() && request.resource.data.sellerId == request.auth.uid; }
```

Block and both helpers are **identical** (comment/whitespace-normalised) to the repo's
`firestore.rules`. Ownership is keyed on **`sellerId`** only — the helpers reference neither
`merchantId` nor `tenantId`.

## 3. The four questions, answered from served rules + read writers/readers

| question | answer | evidence |
|---|---|---|
| `seller.js` → `posProducts` **write** | **PERMITTED.** A `setDoc(..., {merge:true})` on a new doc is a `create`; it passes `claimsPosOwner()` (`sellerId: sellerUid`, and `sellerUid` is the signed-in uid at all four sites that set it) and the `name`/`price` shape checks | `seller.js:1065-1070, 946, 1858, 2032, 2946` |
| `seller.js` → `posProducts` **read** | `seller.js` does not read `posProducts` at all — it only writes (`catch(){}` swallows nothing here because the write succeeds) | census below |
| `posUpsertProduct` ownership fields | writes `merchantId`, `branchId` … and **no `sellerId`**, ever | `pos-inventory-pro.js:1633-1649` |
| canonical docs → can intended consumers read them? | **Server (Admin SDK) consumers: yes** — rules don't apply, and after the field-fix slice they read canonical docs correctly. **Client consumers: no — and not only canonical docs; every client *query* on `posProducts` is rejected wholesale** (see §4) | `business-bootstrap.js`, `bi-advanced.js` … vs the client census |

**The critical question — do the two live schemas coexist under current rules?** **No.** Canonical
(`merchantId`-keyed, no `sellerId`) documents fail `isPosOwner()` for every non-admin. Mirror
(`sellerId`-keyed, no `merchantId`) documents are invisible to every `merchantId`-scoped server
consumer. The two schemas coexist on disk and are mutually invisible to each other's readers.

## 4. Client-side census — stronger than "canonical docs are unreadable"

Every client-SDK reader of `posProducts`, complete (repo grep, server/scripts dirs excluded):

| file | query filter | filters on `sellerId`? |
|---|---|---|
| `pos-inventory.js:687` | `status != 'deleted'` | no |
| `pos-inventory.js:696` (added by the field-fix slice) | `active == true` | no |
| `pos-sync.js:716` | `branchId == …` | no |
| `sokoni-reconcile.js:107,135` | `sellerUid == uid` — a **third** field name no writer sets | no (wrong field) |

Firestore rules are not filters: a *query* is admitted only if the rule can be proven for every
document it could return. With `allow read: if isPosOwner()`, a query that does not itself
constrain `sellerId == request.auth.uid` is **rejected as a whole**, before any document is
considered, for every non-admin. None of the four does. So in production:

- `pos-inventory.js`'s catalogue listener fails entirely — both the original listener **and the
  one added in the field-fix slice** — and silently, because its error handler is `() => {}`
- `pos-sync.js`'s product delta fetch fails entirely
- `sokoni-reconcile.js`'s "repair" path fails entirely (and its follow-on `setDoc` never runs)
- **the `seller.js` mirror therefore has zero working consumers anywhere** — no client can query
  its documents, and no server consumer scopes by the field it writes

Confirmed exact: the only client `where('sellerId', …)` near POS code (`pos-sync.js:328`) targets
the `products` collection, not `posProducts`.

**This further qualifies the field-fix slice:** fix #11 corrected `pos-inventory.js`'s *query*
semantics, but the query cannot run under the served rules for any non-admin. Necessary; not
sufficient; and now known to be blocked at the rules layer rather than merely unproven.

## 5. A stale claim in the migration graph — corrected, not silently rewritten

`docs/POSPRODUCTS_MIGRATION_GRAPH.md` row #1 says the checkout's read path
(`pos-zero-friction`) "depends on exactly this shape — do not touch without also updating the
checkout read path." That is no longer true. `functions/pos-zero-friction.js:346-351` reads the
**canonical `products` collection** — its own comment: *"posProducts was empty for most merchants,
so the till failed 'product not found' on every sale … One source now."* `pos.js` likewise reads
`products` (Stage 2 convergence) and never touches `posProducts`.

Consequence: **`posProducts` is no longer the collection a sale is priced or stocked from.** The
stakes of the writer decision are lower than the graph implied — no real sale reads either schema.
A dated correction note is added to the graph; the original text is left in place.

## 6. `seller.js` writer disposition — decided

The user's constraint, honoured: the mirror **cannot** be classified dead on the write side — the
served rules confirm the write is permitted and it lands. The decision therefore rests on
*consumers*, not on schema incompatibility.

| option | assessment |
|---|---|
| **A — converge the writer onto the canonical schema** (write `merchantId`/`branchId`/`stockQty`/`active`) | Would make mirror docs visible to the merchantId-scoped **server** consumers — but a marketplace seller has no `merchantId`/`branchId` in the mirror's data model (it writes `tenantId: sellerUid`), so the "convergence" would be fabricating tenancy fields. And it would not help a single **client** reader, all of which are rules-blocked regardless of schema. Solves the wrong half. |
| **B — preserve the dual-schema writer with explicit compatibility** | Preserves a writer whose documents no reader can consume under production rules. "Compatibility" here would mean teaching four rules-blocked readers a second field — they still wouldn't run. Preserves cost, delivers nothing. |
| **C — retire the mirror after replacing its legitimate consumer(s)** | **Chosen.** Its only *intended* consumer was "POS visibility of marketplace listings" (`seller.js:1029`'s own comment). That purpose has **already been replaced**: the checkout and `pos.js` now read canonical `products` directly (Stage 2 convergence). There is no working consumer left to replace — the replacement predates this decision. Retirement is the honest state of affairs made explicit. |

**Disposition: C.** Retire the `seller.js` → `posProducts` mirror write in its own slice
(`seller.js:1065-1070` only; the `tenants/{uid}/inventory_products` sync two lines above it is a
separate, ADR-015-canonical write and is **not** in scope). Keep it as its own certified slice with a
negative control proving the marketplace listing flow and the `inventory_products` sync are
unaffected. Do not do it inside the migration-graph work.

## 7. What is separate — kept separate, per instruction

- **`procForecast` has no writer** — a distinct defect; not part of this gate or this decision.
- **`expiresAt`** — a capability gap (no writer sets any expiry field), not a field mismatch.
- **`pos-sync.js` branch scope** — correct as written; unchanged.
- **The rules-layer client-read gap itself** (canonical docs unreadable by any client; all client
  queries rejected) — a real, separate follow-up with two viable shapes, neither done here:
  (i) a **rules** slice adding a `merchantId`-based ownership path — gated by the compiled-size
  ceiling (`reference_rules_compiled_size_ceiling`) and by the prior regression from deploying rules
  off a stale lineage; or (ii) route client catalogue reads through the Admin-SDK paths that already
  work (`business-bootstrap` bootstrap fetch / `getIncrementalSync`) instead of direct client
  listeners. That choice belongs to the migration graph now that the rules fact is in it.

## 8. What this gate did NOT do

Did not change `firestore.rules` or any source. Did not write the served ruleset into the repo
(the repo's `firestore.rules.live` slot is a known-stale artifact; provenance is recorded above
instead). Did not retire the mirror. Did not deploy. Did not touch `C:/temp/sok-r1`.

## Related

`docs/POSPRODUCTS_RULES_OWNERSHIP_INPUT.md` (superseded by this, now authoritative) ·
`docs/POSPRODUCTS_MIGRATION_GRAPH.md` (step 2 decided here; row #1 corrected) ·
`docs/POSPRODUCTS_FIELD_MISMATCH_REMEDIATION.md` (fix #11 further qualified) ·
`scripts/verify-rules-release-parity.js` (the fetch mechanics reused)
