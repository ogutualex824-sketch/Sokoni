# `posProducts` — rules-ownership finding (decision input for migration graph step 2)

**Status:** 📋 READ-ONLY. No code changed, no rules changed, no deploy, no r1 touch.
**Date:** 2026-09-03 · Gathered as input for step 2 of `docs/POSPRODUCTS_MIGRATION_GRAPH.md`
(*"decide `seller.js`'s mirror write's fate"*) — a decision that is the user's to make, not made here.

**Authority caveat, first:** everything below reads the **repository** `firestore.rules`. Per
`project_rules_repo_served_divergence` / `reference_deployed_ruleset_authority`, that file is a
proposal artifact in the deploy slot and the **served** ruleset is the authority; the two have
diverged before. Fetching the served ruleset requires a token that needed explicit approval earlier
this session and was not attempted here unasked. Treat this as a strong lead, not proof about
production.

---

## The question the graph left open — answered, per repo rules

The graph flagged the `seller.js` mirror write as an "unverified rules permission" — i.e. it was not
known whether that direct client `setDoc` to `posProducts` is even allowed, or is dead code failing
silently inside its swallow-everything `catch`.

`firestore.rules:2451`:
```
match /posProducts/{productId} {
  allow create: if claimsPosOwner() && name is non-empty string && price is number >= 0;
  allow read:   if isPosOwner() || isAdmin();
  allow update: if isPosOwner() || isAdmin();
  allow delete: if isPosOwner() || isAdmin();
}
```
with, at `:2434`:
```
isPosOwner()     := isAuthed() && resource.data.sellerId         == request.auth.uid
claimsPosOwner() := isAuthed() && request.resource.data.sellerId == request.auth.uid
```

`seller.js:1065-1070` writes `sellerId: sellerUid`, and `sellerUid` is the signed-in user's own uid
at every site that sets it (`seller.js:946, 1858, 2032, 2946` — all `u.uid`). It also writes `name`
(string) and `price` (number). So its `setDoc(..., {merge:true})` — a `create` on a new doc —
**passes `claimsPosOwner()` and the shape checks.** No catch-all `match /{document=**}` exists to
widen or narrow this (checked: zero matches).

**Conclusion for step 2: the mirror is a live, permitted second writer — not dead code.** The
decision is real; "it never worked anyway" is not available as a shortcut.

## The corollary — the same schema split, now at the rules layer

Ownership in this block is keyed on **`sellerId`**. `posUpsertProduct` — the canonical server writer
(`pos-inventory-pro.js:1633`) — writes `merchantId` and **no `sellerId` at all**. Therefore, for every
document the canonical writer creates, `resource.data.sellerId` is undefined and `isPosOwner()` is
**false for every non-admin**. Per repo rules:

- no client can `read` a `posUpsertProduct`-created product
- no client can `update` or `delete` one either

The server writer's own documents are client-unreadable under the collection's own rules. This is the
`sellerId`-vs-`merchantId` divergence the graph documented at the *data* layer, appearing a third
time at the *rules* layer. It does not affect Admin-SDK Cloud Functions (rules do not apply to them),
which is why the four backend fixes certified in `docs/POSPRODUCTS_FIELD_MISMATCH_REMEDIATION.md`
are unaffected.

## What this qualifies about the slice just certified — stated plainly

`pos-inventory.js`'s catalogue listener (fix #11 in that slice) is a **client-SDK** `onSnapshot`
(`window.firebase.firestore()`). The fix corrected its *query* (`active == true`, so canonical
products are no longer excluded by the missing-`status` field). The isolated certification proved the
query logic. It **cannot** prove the rules layer admits the read — and per repo rules it does not:
`isPosOwner()` fails on canonical documents, so that listener would be permission-denied for exactly
the products the fix was meant to surface. In production the fix is therefore **necessary but not
sufficient** for canonical products to reach the POS app's own sync; the rules gap is the remaining
blocker. The `seller.js`-mirrored products (which *do* carry `sellerId`) are unaffected.

This was not discoverable from the query code alone — it required tracing to the rules, which is the
standing rule (`feedback_never_infer_authz_from_client_writer`: trace UI → caller → backend → served
rules → doc). Recorded here rather than left implicit in a "21/21 certified" that would otherwise
read as end-to-end.

## What this does NOT do

Does not decide step 2. Does not change `firestore.rules` (live headroom is ~596 bytes per
`reference_rules_compiled_size_ceiling`, and a rules deploy from a stale lineage has regressed
production before — any rules change is its own gated slice). Does not fetch the served ruleset.
Does not touch `seller.js`, `pos-inventory.js`, or any code. Does not deploy. Does not touch
`C:/temp/sok-r1`.

## Related

`docs/POSPRODUCTS_MIGRATION_GRAPH.md` (step 2 is the decision this feeds) ·
`docs/POSPRODUCTS_FIELD_MISMATCH_REMEDIATION.md` (the slice this qualifies) ·
`functions/pos-inventory-pro.js` (canonical writer, no `sellerId`) · `seller.js:1065` (mirror
writer, `sellerId` = own uid)
