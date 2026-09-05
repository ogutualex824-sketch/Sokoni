# RELEASE GO / NO-GO — candidate `de79337`

# ⛔ VERDICT: **NO-GO**

**Not a marginal call.** Deploying this candidate would delete **216,523 lines** and **464 files**
that are live in production right now, including **11 `functions/` modules currently serving
traffic**. The require-closure gate being green says the candidate is *self-consistent*; it says
nothing about whether it is *newer than production*, and it is not.

Dated 2026-09-05 · Branch `release/multishop-checkout-certified` · **No deployment attempted.**

---

## 1. What is intended for release

| | |
|---|---|
| candidate | **`de79337`** on `release/multishop-checkout-certified` |
| working tree | **192 uncommitted entries**, other workstreams' — a deploy from this directory ships *files*, not `HEAD` |
| require-closure | **GREEN** — `functions/index.js` loads from a clean checkout (389 blobs, 1718 exports) |

## 2. Candidate versus live — the blocking finding

Live re-read from `https://mysokoni.co.ke/version.json` with a cache-buster:

```
commit        d592d8f   branch release/r1-pos-printer-fn
cacheVersion  sokoni-20260902200425-v632
buildTime     2026-09-02T20:04:26.419Z
```

**The lineages diverged at `3dcf5724`.**

| direction | commits |
|---|---|
| candidate ahead of merge-base | 202 |
| **live ahead of merge-base** | **576** |

`d592d8f` is **not** an ancestor of `de79337`. This is not a fast-forward and never was.

### What deploying the candidate would destroy

```
1123 files changed, 78,493 insertions(+), 216,523 deletions(-)
464 files exist live that the candidate does not have at all
```

Eleven of those are live `functions/` modules:

`entitlement-authority.js` · `merchant-identity.js` · `pos-commission-collection.js` ·
`print-intents.js` · `role-vocabulary.js` · `shared/product-authority.js` ·
`shared/sellability.js` · `shop-access.js` · `subscription-pay-methods.js` ·
`verification-engine.js` · `verification-vocabulary.js`

Live is also substantially ahead inside files the candidate *does* have —
`functions/index.js` (+740), `pos-zero-friction.js` (+534), `application-lifecycle.js` (+476),
`pos-staff-ops.js` (+365).

**A functions deploy from this candidate would remove eleven authority modules from production.**

## 3. ⚠️ The rollback guard would NOT stop this

`scripts/deploy/guard-no-rollback.js` exists precisely for this hazard, and by its own
documented logic it would **allow** this deploy:

> `HEAD` is an ANCESTOR of live → ROLLBACK → abort.
> **otherwise (ahead / diverged / live commit unknown here) → allowed.**

Our candidate is **diverged**, not an ancestor — the branch the guard permits. And it is wired
into **`hosting.predeploy` only**; `functions.predeploy` has no rollback guard at all.

So the two mechanisms that look like protection do not cover this case:

| mechanism | covers this? |
|---|---|
| `gate-functions-require-closure` (functions, first) | No — it proves self-containment, not recency |
| `guard-no-rollback` (hosting only) | No — "diverged → allowed", and not wired to functions |

**Recorded as a finding, not fixed here.** Changing a deploy guard's semantics is a deployment
configuration decision and belongs to an explicit release decision, not to this assessment.

## 4. Dirty production build — materially resolved

Production reports `dirtyWorkingTree: true`. Its five `dirtyPaths` are:

`scripts/bisect-script-execution.js` · `scripts/diagnose-home-button-handlers.js` ·
`scripts/measure-home-buttons-postconsent.js` · `scripts/measure-home-card-interception.js` ·
`scripts/probe-consent-banner.js`

All five are **diagnostic/measurement scripts**. None is application code, none is under
`functions/`, and none is present in this candidate at all. A functions deploy ships only
`functions/`; hosting serves static files but never executes these.

**Correction — the content is benign; the provenance is not.** `scripts/release-gate.js`
independently fails this and is right to be stricter than my first reading:

> `FAIL  build was produced from a DIRTY working tree — it matches no commit`

Whether the dirty files were harmless is a different question from whether the live build can be
reproduced. It cannot: no commit corresponds to what is running. That is a genuine open
provenance item for production itself, separate from this candidate, and it is **not** resolved
by the five paths turning out to be inert.

## 4b. The release gate's own verdict on LIVE production

`node scripts/release-gate.js` → **exit 1**, *"RELEASE GATE FAILED — 3 gate(s) failed. DO NOT
DEPLOY."* All three are findings about the **currently deployed site**, not the candidate:

| gate | finding |
|---|---|
| `verify-domain-cutover.js` | **no AAAA record** — IPv6-only clients cannot reach the site; legacy host `217.20.124.84` **still serving** (HTTP 404, LiteSpeed) |
| build identity | build came from a dirty tree, **matches no commit** |
| browser render | **4 unexpected console errors** — two 403s, `requestStorageAccess: Permission denied`, `[SOKONI] Security verification failed. Please refresh and try again.` |

The render checks otherwise pass (CSS applied, premium dark theme, no horizontal scroll, 0
broken images, service worker activated, 0 placeholders).

*Measurement note: my first run of this gate appeared to exit 0 because I piped it through
`tail` — the pipeline's status, not node's. The gate exits 1 correctly. Same class as the
`cmd.exe` caret defect already on record: never read an exit code through a pipe.*

## 5. The four capability dispositions

| item | state | blocking? |
|---|---|---|
| `manual_payment` | **OFF.** `checkout-mode.js` returns `manual_payment_unavailable`, verified unmodified | Correct as-is |
| manual-till lifecycle | **NOT CERTIFIED — 67/81.** All 14 failures are the unbuilt POS attestation queue | Blocks *enabling*, not this verdict |
| `revenueConfig/commission_vat` | **UNSET**, verified absent in production → every issuing path refuses | Correct as-is; **do not fabricate** |
| `order-claim` attribution | **OPEN.** owner `null`. 27/0 emulator evidence supports the *code*, not the *ownership* | Governance, open |

## 6. `merchant-identity` — resolved, and not where I was looking

Earlier passes searched feature branches and found two divergent versions. The decisive fact was
on the production lineage all along:

| ref | blob | size |
|---|---|---|
| **`d592d8f` (LIVE)** | **`ccc43cf`** | **20,818** |
| `release/merchant-identity` | `ccc43cf` | 20,818 — **identical to live** |
| `audit/employee-attribution` (`7ecd119`) | `a36997f` | 46,554 — the outlier |

**The canonical version is the one running in production**, and `release/merchant-identity`
matches it byte for byte. The 46,554-byte version is the divergent one, not the baseline.

This is information for that workstream's owner, not an action taken here — their file was not
touched and neither version was copied.

## 7. What a GO would require

1. **Resolve the lineage.** Either release from a tree that contains live's 576 commits, or
   merge `d592d8f` into the candidate and re-certify. A merge decision, not a fast-forward.
2. Re-run require-closure and the full regression **on the merged tree** — closure is a property
   of a tree, and this one's green verdict does not transfer.
3. Close, or explicitly accept, the four capability items in §5.
4. Decide whether `guard-no-rollback` should refuse the diverged case and cover functions.
5. Resolve production's own open items surfaced by the release gate: the missing AAAA
   record, the legacy host still answering, the four console errors, and the unreproducible
   live build.
6. Then an explicit human **GO**.

---

**No deployment is authorised by this document.** Production remains `d592d8f` / v632.
The require-closure gate is green; the release is not.
