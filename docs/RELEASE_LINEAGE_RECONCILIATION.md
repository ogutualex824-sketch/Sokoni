# Release lineage reconciliation — 18a / ADR-017 provenance

**Status:** 📋 PROVENANCE REPORT ONLY. **No cherry-pick, merge, or code change performed.**
**Date:** 2026-09-03

---

## The headline finding — this is bigger than two missing commits

`release/multishop-checkout-certified` (the branch this entire session's work is committed to —
18b, 18c, ADR-018/018c, the KASS AI audit, the release-stack ledger) **is not on the production
lineage.** Live production is `d592d8f` / v632 — confirmed just now against
`https://mysokoni.co.ke/version.json`, which additionally reports `"branch":
"release/r1-pos-printer-fn"`. That is not this branch.

```
git merge-base --is-ancestor d592d8f HEAD   →  NO   (production is NOT an ancestor of our HEAD)
git merge-base --is-ancestor HEAD d592d8f   →  NO   (our HEAD is NOT an ancestor of production either)
git merge-base HEAD d592d8f                 →  3dcf572  (2026-08-13, "gate-inventory environment-aware fix")
```

**The two branches are siblings from a single 2026-08-13 common ancestor, not one built on the
other.** From that point:

| | commits since `3dcf572` | relationship to deployed production (`d592d8f`) |
|---|---|---|
| `release/multishop-checkout-certified` (our HEAD) | 82 | **not an ancestor, not a descendant — unrelated** |
| `release/r1-pos-printer-fn` | 610 | `d592d8f` **is** an ancestor (576 commits in), tip is 34 commits **beyond** deployed production |

`release/r1-pos-printer-fn` is checked out at worktree `C:/temp/sok-r1`.

---

## Answering the exact chain requested

```
current HEAD
   ↓
which commits are ancestors?
```
**None.** Verified individually: `d592d8f` (production itself), `8fc3673` (18a), `d627355` (18a
docs), `59d2225` (ADR-017 close) — every one of these returns `false` for
`git merge-base --is-ancestor <commit> HEAD`.

```
   ↓
which required files/changes are actually present?
```
Mixed — checked file-by-file, not assumed:

| file/change | on our HEAD? | detail |
|---|---|---|
| `functions/inventory-fraud.js`, `-health`, `-import`, `-pricing`, `-recall`, `-simulate`, `-webhooks`, `-workflows` (8 files) | ✅ present | but **without** the `59d2225` ADR-017 authority-debt fix (~26-28 added lines per file on r1) — we have an older baseline of these files, not the fixed version |
| `functions/pos-inventory-pro.js` | ✅ present | but r1's `8fc3673` has **already stripped ~449 lines** from it (handler retirement) — the exact `createPurchaseOrder`/`receivePurchaseOrder`/etc. surface I flagged as a "RETIRE candidate" in `ADR-018c` may already be retired, independently, on that branch |
| `scripts/gate-authority-resurrection.js` | ❌ absent | new to r1's lineage entirely |
| `scripts/test-adr017-authority.js` | ❌ absent | new file, 267 lines, part of `59d2225` |
| `scripts/test-retire-18a.js` | ❌ absent | new file, 149 lines, part of `8fc3673` |
| `docs/adr/ADR-018-legacy-retirement-graph.md` | ⚠️ **present, but a different document** | see below — a direct filename collision, not a missing file |

```
   ↓
which are only in another worktree?
```
Everything in the 34-commit stack listed below — all of it lives only on
`release/r1-pos-printer-fn` (`C:/temp/sok-r1`), not on this branch or this worktree.

```
   ↓
which need a clean cherry-pick/merge?
```
**Neither is clean.** See "Why this isn't a 3-commit cherry-pick" below.

---

## The ADR-018 filename collision — read before touching either document

`release/r1-pos-printer-fn`'s `d627355` creates `docs/adr/ADR-018-legacy-retirement-graph.md` —
**the exact same path** as the ADR-018 this session wrote for 18b (commit `1f89550` on this
branch). They are **different, unrelated documents**:

| | this branch's `ADR-018` (commit `1f89550`) | r1's `ADR-018` (commit `d627355`) |
|---|---|---|
| scope | retiring `posSendPurchaseOrder` specifically (18b) | broader: `pos*` inventory/procurement graph and bare `purchaseOrders`, sourced from their own `311daed` |
| evidence base | this session's `cf-invocation-census.json`, 20/20 `test-retire-18b.js` | their own: "493 assertions, 12 suites, 0 frozen authority debt" (larger) |
| status | Accepted, 18b executed | "READ-ONLY GRAPH — retirement NOT authorised... as a single slice" |
| production baseline cited | n/a (didn't check at the time) | `d592d8f` / v632 — **the actual deployed baseline** |

**This means r1's ADR-018 has almost certainly already covered ground this session's 18c discovery
and ADR-018c re-derived independently** — including, plausibly, the exact `posPurchaseOrders`/
`posBatches`/`procPurchaseOrders` questions this session just spent significant effort tracing.
`git diff` between the two versions shows 120 insertions / 114 deletions — i.e. they don't share a
common origin text either; this is two independent documents that happen to claim the same
filename and number, not a divergent edit of one document.

**Recommended before any further 18c/ADR-018c work:** read r1's `ADR-018` in full
(`git show d627355:docs/adr/ADR-018-legacy-retirement-graph.md`) to check for contradiction or
duplication before treating this session's ADR-018c disposition as the operative one. Not done in
this pass — flagged, not executed, per "provenance check only."

---

## The 34-commit stack already sitting on live production (r1 lineage)

This is the **actual** answer to "current known stacked release" — every item named maps directly
onto commits here, cleanly ahead of `d592d8f`, not onto anything on this branch:

```
adb56c0 chore(release): record v632 pipeline artifacts (d592d8f)   ← deployed production, HEAD of that state
fe37a91 docs(adr): ADR-015 — one canonical inventory authority
1ef8382 fix(delivery): recover pickupHandover into the lineage — ported, not merged
d9010ec fix(commission): recover the 48-hour receivable rail into the lineage
5c8fb6f fix(boost): recover expireBoosts AND its activation path into the lineage
019f4c8 test(commission): certify the PRODUCTION c2b caller, executed against the real settlement
3b9ccbc feat(merchant): Supplier Hub — restock made easy, honest when it knows nothing
8f8938a feat(tenant): enforce tenant authority in the inventory AI callables         ← "tenant authority"
167f344 docs(adr): ADR-015 §5a — an unverifiable POS actor quarantines attribution
0360227 feat(pos): a till sale now writes a canonical inventory movement (ADR-015 §5/§5a)
d4cb214 docs: correct ADR-015 actor-unavailable behavior
f026fac fix: enforce tenant authority in POS inventory                              ← "POS inventory authority"
f62c45b docs: map ADR-015 C2 path convergence
888f0ef fix: bind POS document handlers to the owning tenant                        ← "POS document authority"
7ec2360 docs: map supplier and purchase-order graph
af7525f docs: record Model C procurement disposition
ae97419 docs: finalize ADR-015 procurement and inventory graph
c5ff85b fix: enforce tenant authority in procurement                                ← "procurement authority"
5bd32ac docs: map receipt destination and inventory authority
8100c1e docs: record QR receipt and verification defects                            ← "receipt bridge" (context)
04f3026 fix: bind inventory engine tenant authority                                 ← "inventory engine authority"
3cd5eac docs: map branch and warehouse identity
5cf2f02 docs: record retired merchant authority defect
fcff2cb docs: design retired merchant authority enforcement
5189365 fix: enforce live merchant authority                                        ← "merchant authority"
145ca5a docs: decide branch warehouse identity
1678d33 docs: design canonical warehouse authority
7788661 fix: add canonical warehouse authority                                      ← "warehouse authority"
101b946 feat: add idempotent procurement receipt bridge                             ← "receipt bridge"
af38694 feat: add authority resurrection gate and debt record
59d2225 fix: close ADR-017 inventory authority debt                                 ← "ADR-017 remediation"
311daed feat: add canonical warehouse management UI                                 ← "warehouse management UI"
d627355 docs: map legacy inventory retirement dependencies                          ← "legacy retirement 18a" (docs)
8fc3673 refactor: retire legacy POS inventory handlers                              ← "legacy retirement 18a" (code)
```

Every named item in the user's "current known stacked release" list is accounted for here, in
order, on the branch that is actually deployed. **None of it is on `release/multishop-checkout-certified`.**

---

## Why this isn't a 3-commit cherry-pick

The three commits named (`8fc3673`, `d627355`, `59d2225`) sit at the **tip** of a 34-commit chain
that itself sits 576 commits past the two branches' last common ancestor. They plausibly depend on:
- `scripts/gate-authority-resurrection.js` (introduced mid-chain, modified again by `59d2225`) —
  absent from our branch entirely.
- The ADR-015 tenant-authority work threaded through most of the chain (`f026fac`, `8f8938a`,
  `c5ff85b`, `04f3026`, `888f0ef`) — our branch's own tenant/merchant work (the 82-commit "2D"
  merchant consolidation series) evolved independently and may model tenant/merchant authority
  differently.
- `docs/adr/ADR-018-legacy-retirement-graph.md` — a hard path collision with this session's own
  file, as detailed above.

A mechanical `git cherry-pick 8fc3673 d627355 59d2225` onto this branch would very likely conflict
on the ADR-018 path immediately, and even if force-resolved, would land code depending on
infrastructure (`gate-authority-resurrection.js`, the ADR-015 tenant binding it assumes) that
doesn't exist here. **This needs deliberate reconciliation — deciding which lineage's tenant/merchant/
inventory-authority model is authoritative, and either rebasing this branch's independent work onto
r1's lineage or the reverse — not a cherry-pick.** No such decision is made here.

---

## What this means for the release-stack rule going forward

Per your own instruction: *"we should no longer say 'we have completed X' merely because it was
completed in another worktree."* Applied honestly, that now includes almost everything this
session has framed as "the release stack" up to this point:

- This session's 18b/18c/ADR-018/ADR-018c/KASS-AI-audit work is real, committed, and correctly
  attributed to `release/multishop-checkout-certified` — but that branch is **not** the one 34
  commits ahead of live production. Continuing to call `d592d8f`/v632 "the production this branch
  builds toward" is not accurate until these two lineages are reconciled.
- The items named as "current known stacked release" (tenant/POS-inventory/POS-document/
  procurement/inventory-engine/merchant/warehouse authorities, receipt bridge, ADR-017, 18a,
  warehouse management UI) are **real, committed, and already sitting cleanly on production** — on
  `release/r1-pos-printer-fn`, not here.

**Recommendation, not a decision:** before adding further implementation work to
`docs/RELEASE_STACK_LEDGER.md` under the assumption it will become "the" release stack, decide
whether `release/multishop-checkout-certified` or `release/r1-pos-printer-fn` is meant to be the
release-stack branch going forward — or whether they need to be merged first. That decision isn't
mine to make from a provenance check.

## Related

`docs/RELEASE_STACK_LEDGER.md` (this reconciliation feeds its 🔴 rows) ·
`docs/adr/ADR-018-legacy-retirement-graph.md` (this branch's version — compare against r1's before
relying on either) · `docs/adr/ADR-018c-purchase-order-batch-disposition.md`
