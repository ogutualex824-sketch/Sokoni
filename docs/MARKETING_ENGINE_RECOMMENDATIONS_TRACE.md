# `getCrossSellRecommendations` / `getUpsellRecommendations` — read-only trace

**Status:** 📋 READ-ONLY TRACE. No code changed, no rules changed, nothing retired or repaired.
Ends in a recommendation, not a decision — the disposition is yours to make.
**Date:** 2026-09-03 · Follow-up flagged in
`docs/POSPRODUCTS_SELLERJS_RETIREMENT_GRAPH.md`, kept deliberately separate from that retirement.
Does not touch `procForecast`'s missing writer, `expiresAt`'s capability gap, or
`sokoni-reconcile.js`'s remaining posProducts writer — each stays its own item.

---

## 1. Callers — repo-wide, both calling conventions

Neither function is individually exported. `functions/index.js:12377` exports only
`concludeExpiredFlashSales` from `marketing-engine.js` directly; a comment at that line says why:
*"Marketing Engine — consolidated into commerceDispatch above."* The other ten callables,
including both of these, are registered on `marketing-engine.js`'s `_h` object and reached only
through `functions/commerce-dispatch.js`'s single exported `commerceDispatch` callable, which
merges `_h` from three modules and dispatches on `req.data.op`.

Checked **both** shapes a caller could use, not just the direct one:

- Direct name (`getCrossSellRecommendations(`, `getUpsellRecommendations(`) — repo-wide grep,
  **zero** matches in any `.html`/`.js` file (confirmed again this pass, same as the retirement
  graph's earlier check).
- Dispatcher op-name (`op: 'getCrossSellRecommendations'` / `'getUpsellRecommendations'`, any
  quoting) — repo-wide grep, **zero** matches in any real page. The only two hits anywhere are
  `scripts/census-marketing-authority.js` and `scripts/test-merchant-marketing.js` — a
  documentation-generating census script and a test script, neither a caller.

**`commerceDispatch` itself is very much live** — confirmed exported
(`functions/index.js:11798`) and called from four real pages/modules:
`auction-manager.html`, `merchant-success.html`, `rental.html`, `sokoni-wishlist.js`. So the
transport is not dormant; these two specific operations, requested through it, are.

---

## 2. Production invocation evidence

Cloud Run service `commercedispatch` (us-central1), `_Default` log bucket, confirmed **30-day**
retention (re-checked this pass, not assumed from memory).

**Positive control — the pipeline has real traffic, so a zero-result search means something:**
1,283 log entries in the last 30 days, real `200`/`204` HTTP responses observed.

**Targeted search — both op names, any field, full 30-day window: zero matches.** Neither
`getCrossSellRecommendations` nor `getUpsellRecommendations` appears anywhere in
`commerceDispatch`'s logs — not as a request, not in the dispatcher's own
`console.error('[dispatch] op="'+op+'"...')` failure log, not anywhere — across the entire
retained history.

**Conclusion: never invoked in production, as far as logs can prove it.** Combined with §1, this
is not "no caller found in this snapshot of the repo" — it is "no caller has driven this operation
through the one path that reaches it, ever, in the last 30 days of Cloud Run history."

---

## 3. Exact query fields vs. actual document fields

Already established, re-confirmed this pass by re-reading the handler bodies directly:

| function | query field | writer that sets it |
|---|---|---|
| `getCrossSellRecommendations` (AI-match step) | `.where('merchantId','==',merchantId).where('status','==','active')` | `status` — **only ever set by the seller.js mirror**, itself retired this session (`cf02d1b`) |
| `getUpsellRecommendations` (same-category + variant steps) | same `merchantId`+`status` pair, plus `category`/`price`/`variantGroupId` | same |
| `getUpsellRecommendations` (anchor lookup) | `db.collection('posProducts').doc(productId).get()` — direct id lookup, no field filter | throws `not-found` if absent, regardless of writer |
| `getCrossSellRecommendations` (collaborative step) | same direct id lookup pattern | same |

**No writer in the current codebase sets `status` on a `posProducts` document at all, as of this
session.** The canonical writer (`posUpsertProduct`) never did — it writes `active` (boolean).
The seller.js mirror was the only one that ever set `status: 'active'`, and it was retired this
session. `sokoni-reconcile.js`'s remaining write (`sokoni-reconcile.js:146-147`, checked directly
this pass) writes `{name, price, stock, sellerUid, sourceProductId, updatedAt}` — no `status`
field either, and yet another identity-field spelling (`sellerUid`, matching neither `merchantId`
nor `sellerId`). So the `status=='active'` queries are now **structurally guaranteed empty going
forward**, not merely "usually empty" — there is no remaining path that could ever populate a
matching document, short of a legacy document written before this session's retirement.

---

## 4. Whether the query can ever return a result

**No**, for the two `status`-filtered queries, per §3 — no writer produces that field anymore.

The two **anchor lookups** (`doc(productId).get()`, no filter) are a different case: they can
return a result whenever *any* `posProducts` document happens to exist at that id, from *any*
writer, past or present. That's a weaker, pre-existing unreliability (a `productId` that only
ever existed in canonical `products` — the common case, since checkout reads `products` not
`posProducts` — has never had a matching `posProducts` doc), not something this session's
retirement changed.

---

## 5. Intentionally dormant, or simply unconnected?

**Not intentional dormancy — incomplete, already independently documented as unsafe to finish
wiring as-is.** `docs/MERCHANT_MARKETING_AUTHORITY.md` (pre-existing, generated by
`scripts/census-marketing-authority.js`, re-run this pass to confirm it still reflects current
source) classifies **all eleven** `marketing-engine.js` callables, including both of these, as
**BLOCKED** — for a reason independent of, and more severe than, the field-mismatch this trace was
asked to examine:

> *"Every one of these takes `merchantId` from the request and uses it to read or write. A search
> of the whole module for an ownership assertion... returns nothing. `_requireMerchant`
> establishes that the caller has A merchant role; it never establishes that they are THIS
> merchant. So re-exporting them as they stand would publish eleven cross-tenant write/read
> paths."*

The same document independently names the `posProducts` field-mismatch as a second, separate
reason: *"Two of them read a collection the platform moved off... Recommendations built on it
would be empty for the same merchants."* Its own recommendation: *"Everything in
marketing-engine[is BLOCKED], until ownership assertion and the role gate are fixed. Re-exporting
is the last step of that work, not the first."*

This is corroboration from a different author/process at a different time, reaching the same
conclusion independently — not something manufactured for this trace.

---

## Recommendation — not a decision

The evidence supports **retirement over repair**, for reasons beyond the field-mismatch alone:

1. Zero callers, repo-wide, in either calling convention.
2. Zero production invocations in 30 days of Cloud Run logs, against a positive-control-verified
   pipeline.
3. The `status` field the queries depend on can no longer be produced by any writer — fixing the
   field name (`active` instead of `status`) would still leave the function reading a collection
   the checkout, `pos.js`, and this session's own retirement have all already moved off.
4. A pre-existing, independent authority census already blocks these specific two callables (and
   their nine siblings) for a **separate, more serious** cross-tenant authorization defect, and
   explicitly recommends against re-exporting until that is fixed — repairing only the field
   mismatch would not change that verdict.

**Repair would fix a query that reads the wrong collection, feeding a function nothing calls,
gated by an authorization check nothing has verified is safe to expose.** Retirement (or, at
minimum, leaving `getCrossSellRecommendations`/`getUpsellRecommendations` un-repaired and
un-exported until the ownership question is separately resolved) is the disposition the evidence
points to — but this is your call, consistent with how the `seller.js` writer disposition was
handled: evidence gathered and presented, decision made explicitly, then executed as its own slice.

## What this trace does NOT do

Does not retire or repair either function. Does not touch `marketing-engine.js`,
`commerce-dispatch.js`, or `firestore.rules`. Does not touch `procForecast`'s missing writer,
`expiresAt`'s capability gap, or `sokoni-reconcile.js`'s writer — each remains its own, separate,
still-open item. Does not fix the cross-tenant ownership defect the pre-existing census documents
for any of the eleven `marketing-engine.js` callables. Does not deploy. Does not touch
`C:/temp/sok-r1`.

## Related

`docs/POSPRODUCTS_SELLERJS_RETIREMENT_GRAPH.md` (where this follow-up was flagged) ·
`docs/MERCHANT_MARKETING_AUTHORITY.md` (pre-existing, independent, corroborating census —
re-verified current this pass) · `scripts/census-marketing-authority.js` (its generator) ·
`functions/commerce-dispatch.js` (the live dispatcher, confirmed exported and called elsewhere) ·
`functions/marketing-engine.js` (the two functions themselves, untouched)
