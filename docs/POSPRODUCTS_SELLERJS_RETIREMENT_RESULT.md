# `seller.js` → `posProducts` mirror writer — retirement executed

**Status:** implemented, certified 14/14 (with sabotage controls). No rules change, no other
consumer migrated. No deploy. No r1 touch.
**Date:** 2026-09-03 · Executes the disposition proven safe in
`docs/POSPRODUCTS_SERVED_RULES_GATE.md` (Option C) and traced in detail in
`docs/POSPRODUCTS_SELLERJS_RETIREMENT_GRAPH.md`. Scoped narrowly, per instruction, to removing the
mirror write — nothing else.

## What changed

`seller.js`'s `addProduct()` (the single write site, the single trigger — see the retirement
graph) no longer writes `posProducts`. The six lines that built and sent that write are removed;
everything around them is untouched:

- the canonical `products` write (`seller.js:1008`, three lines before the removed block) —
  unchanged
- the `tenants/{uid}/inventory_products` sync — unchanged, still fire-and-forget, still using the
  same locally-computed `_invProduct`/`_sku`/`_img`/`_wh` values
- a dated retirement comment replaces the removed block's explanation, naming the evidence docs —
  matching this session's established convention (18b's `posSendPurchaseOrder` retirement) rather
  than deleting the history silently

## Certification — `scripts/test-posproducts-mirror-retirement.js`, 14/14

Static, comment-stripped source assertions plus sabotage controls (every positive check proven
capable of failing, not just passing):

1. **The mirror write is gone** from `addProduct()`'s isolated body.
2. **The canonical `products` write survives** — regex-matched, then sabotaged (id mutated) to
   prove the detector actually notices when it's broken.
3. **The `inventory_products` sync survives** — same pattern: matched, then sabotaged (deleted) to
   prove the detector notices.
4. **A resurrected mirror write is caught** — the exact regression this slice exists to prevent,
   injected into a copy and confirmed detected.
5. **Cross-contamination control** — a copy shaped exactly like the *pre-retirement* code (mirror
   write re-added, canonical + inventory writes untouched) trips *only* the mirror-write detector,
   proving the three checks are independent rather than accidentally the same regex.
6. **`digital-esoko-seller.html`, `ministore.html`, `seller-wiring.js`** — each diffed against
   `git show HEAD:<file>` and proven byte-identical. The two unrelated `addProduct()`
   implementations and the global patch were not touched, not merely "not intended to be."
7. **Repo-wide git grep** for any `posProducts` write call site: `seller.js` has zero: the only
   other hit is `sokoni-reconcile.js` — a known, pre-existing, deliberately out-of-scope third
   writer (the original migration graph's row #14 already flagged it as *"should probably be the
   one place that's allowed to normalize field names, not migrated away"*), asserted as expected,
   not silently allowed by omission. (`pos-inventory-pro.js`/`procurement.js` write through an
   indirect `prodRef`-style variable this particular grep pattern doesn't match — their absence
   from the hit list is a pattern limitation, not a finding; both were already established as the
   canonical writer and an out-of-scope legacy path respectively.)

Also: `scripts/test-posproducts-field-fixes.js` re-run, unaffected (0 regressions — that suite
tests the *readers*, none of which depended on the mirror still writing). `seller.html`
headless-loaded: 0 console errors.

## What this slice deliberately did not do

Did not touch `firestore.rules`. Did not touch any other `posProducts` consumer or writer
(`pos-inventory-pro.js`, `pos-inventory.js`, `pos-sync.js`, `sokoni-reconcile.js`,
`business-bootstrap.js`, `bi-advanced.js`, `business-health-score.js`, `release-readiness.js`,
`self-heal.js`, `procurement.js`). Did not fix `marketing-engine.js`'s separate
`status=='active'` field-mismatch bug on its two dormant recommendation callables — logged in the
retirement graph as its own future item, explicitly not mixed in here. Did not start the broader
14-consumer migration. Did not deploy. Did not touch `C:/temp/sok-r1`.

## Related

`docs/POSPRODUCTS_SERVED_RULES_GATE.md` (the disposition) ·
`docs/POSPRODUCTS_SELLERJS_RETIREMENT_GRAPH.md` (the read-only trace this executes) ·
`docs/POSPRODUCTS_FIELD_MISMATCH_REMEDIATION.md` (the reader-side fixes, unaffected by this) ·
`docs/POSPRODUCTS_MIGRATION_GRAPH.md` (the broader graph, still gated behind marketing-engine.js's
fix and the remaining consumer migration)
