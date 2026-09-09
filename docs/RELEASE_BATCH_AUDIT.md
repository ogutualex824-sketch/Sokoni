# SOKONI — pre-deployment batch reconciliation

**Date:** 2026-09-09 · **Read-only.** Nothing deployed, nothing mutated, no working tree cleaned.

# 🔴 BLOCKED

**The batch cannot be assembled, and the reason is structural rather than a missing check.**
The branch holding the work you asked to batch — MiniShop, multi-shop cart, message UI/UX —
is **not downstream of production**. "Everything changed since the last deployment" is not a
computable set on it.

---

## §1 · Production baseline

```
PRODUCTION BASELINE
  Hosting      d592d8f  ·  release/r1-pos-printer-fn  ·  built 2026-09-02T20:04:26Z   🟢 PROVEN (live version.json)
  Functions    NO SINGLE COMMIT — 54 deployment generations across 1002 Cloud Run services
                 d6655bd   820 services   🟢 PROVEN (blob identity)
                 7d115bc     5 services   🟢 PROVEN
                 919333e, 3583202, 2ba509b, ed1c16b, c4013d1  🟢 PROVEN per module
                 f51ce5e8    2 services   🔴 UNRECOVERABLE (payment-destination pair)
                 51 further generations   ⚪ UNPROVEN
  Cloud Run    1002 services, all regions
  Repository   no single commit corresponds to the deployable surface
  Verified-at  2026-09-09
  Confidence   Hosting PROVEN · Functions MULTI-LINEAGE · Repository UNPROVEN as a single point
```

`d592d8f` is a **Hosting** stamp. It is not the Functions baseline — disproven at `ee24802`
and unchanged since.

## §2 · The enumeration cannot be performed

```
c6a1e68 (release/multishop-checkout-certified)  208 commits AHEAD of d592d8f
d592d8f (production)                            576 commits AHEAD of c6a1e68
```

**Diverged, not advanced.** Taking this branch as a release candidate would:

```
1125 files changed · 79,283 insertions · 216,666 DELETIONS
464 files deleted · 417 modified · 243 added
```

That reproduces the recorded catastrophe almost to the line — the earlier measurement was
216,523 deletions across 464 files. The divergence has not closed.

So "all changes since the baseline" on this branch means **208 commits of new work plus the
removal of 576 production commits**. The second half is not a change to batch; it is a
regression to prevent.

### Only 7 branches descend from production

```
release/r1-pos-printer-fn                 +34    (production's own branch)
rules/production-lineage-reconciliation   +36
rc/lineage-slice1                         +14    (this Slice 1 work)
release/r1-fold-candidate                 +51
release/reconcile-d592d8f                +313
feature/tax-compliance-engine            +342
release/merchant-launch-rc               +377
```

**`release/multishop-checkout-certified` is not among them.** The MiniShop, cart, multi-shop
cart and message UI/UX work sits on a lineage production never received.

## §4–§6 · Why the UI/MiniShop/cart audit cannot proceed

Not because those changes are unimportant — because they cannot be *isolated*. Auditing them
means diffing against a baseline they do not descend from, so every unrelated production
advance appears as a deletion. Under those conditions the classification A–G would be
meaningless: nearly everything would land in E (regression) as an artefact of the diff, not
of the work.

**Getting them into a release candidate requires the lineage reconciliation first.** That is
Slice 1, and it is currently blocked on: `index.js` export governance, `projectSeller`, and
the Daraja reference resolution.

## §10 · Payment non-regression — vacuously true

```
payment behaviour changed      NO
Till-On behaviour changed      NO
card behaviour changed         NO
wallet behaviour changed       NO
commission behaviour changed   NO
```

No candidate was assembled, so nothing could regress. **Not evidence of safety** — evidence
that no change was attempted.

## §11 · Worktree

The shared tree carries **235 uncommitted entries** (81 `scripts/`, 55 `docs/`, 30
`functions/`, plus root files) belonging to other workstreams. **Not touched, not cleaned, not
stashed** — CLAUDE.md forbids it and the batch does not require it.

The Slice 1 worktree `C:/temp/sok-slice1` is clean.

---

## What *is* deployable today

`release/r1-pos-printer-fn` is **+34 commits** ahead of production on the production lineage —
71 files, +11,230/−655. Procurement, inventory and warehouse authority work: canonical
warehouse authority, tenant authority in procurement, an idempotent receipt bridge, legacy POS
inventory handler retirement.

It is a genuine, correctly-based deployable increment. **But it is not the work this audit was
asked to batch**, and 11 of its files are payment/POS/card-named and would need classification
against the freeze before it could be certified.

Recorded as an option, **not proposed** — it was not audited here.

---

## Final status

```
overall                        🔴 BLOCKED
production baseline            Hosting PROVEN · Functions multi-lineage · Repository UNPROVEN
included changes               NONE — no candidate assembled
excluded changes               all — the source branch is not downstream of production
frozen changes detected        none touched
MiniShop verdict               BLOCKED — not on a deployable lineage
cart verdict                   BLOCKED — same
multi-shop cart verdict        BLOCKED — same
message UI/UX verdict          BLOCKED — same
security verdict               unchanged; application-lifecycle gate intact
payment non-regression         vacuous — nothing changed
tests                          none run; a batch with no candidate has nothing to certify
production deployed            NO
production mutated             NO
worktree                       clean (slice1) · shared tree untouched at 235 entries
```

### Missing evidence, precisely

The batch needs a candidate branch descended from the production baseline. Producing one is
the Slice 1 lineage reconciliation, which remains blocked on three items already recorded:
`index.js` export governance (7 deployed-but-unexposed functions), `projectSeller`, and the
Daraja reference resolution (`initiateSTKPush` documented inside live code).

**Until a deployable-lineage candidate exists, batching UI/MiniShop/cart work would mean
deploying a tree that deletes 464 production files.** That is the finding.
