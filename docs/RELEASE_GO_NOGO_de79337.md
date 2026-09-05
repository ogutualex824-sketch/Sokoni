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
into **`hosting.predeploy` only**.

### ⚠️ CORRECTION — production already has a functions guard, and the candidate would DELETE it

An earlier revision of this section said *"`functions.predeploy` has no rollback guard at all."*
That is true of **the candidate** and false of **production**. Live's `functions.predeploy`
begins with `scripts/deploy/guard-functions-safety.js` — a file that **does not exist in this
candidate at all**.

It was built for precisely this failure class, observed 2026-08-28, and says so:

> A functions deploy must not silently remove the payment-path protections that are already
> live. […] For several hours, `firebase deploy --only functions` from the hosting lineage would
> have silently reverted MSISDN validation on the live customer STK path, the fail-CLOSED
> seller-phone ownership check (back to fail-OPEN), and the sandbox callback lane. Nothing
> warned. `guard-no-rollback` compares the HOSTING tree against live hosting; it says nothing
> about functions. This closes that gap.

It guards by **properties, not commit ancestry** — deliberately, because converging fixes by
cherry-pick creates new SHAs, so the code can be present and correct while the original commits
are not ancestors. That is a better design than the ancestry test, and the candidate does not
have it.

**So this compounds the verdict rather than qualifying it:** deploying the candidate would not
only revert live code, it would remove the guard that exists to stop exactly that.

| mechanism | covers this case? |
|---|---|
| `gate-functions-require-closure` (candidate, functions, first) | No — proves self-containment, not recency |
| `guard-no-rollback` (both, hosting only) | No — "diverged → allowed", never wired to functions |
| `guard-functions-safety` (**live only**, functions, first) | Would have — **but the candidate deletes it** |

**Recorded as findings, not fixed here.** Changing deploy-guard semantics is a
deployment-configuration decision. Reconciliation must bring `guard-functions-safety.js`
forward and merge it with the candidate's closure gate — both belong in
`functions.predeploy`, and they answer different questions.

## 4. Dirty production build — content benign, provenance NOT resolved

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

## 6b. Reconciliation cost — measured, not estimated

`git merge-tree --write-tree d592d8f HEAD` (read-only; nothing in the working tree touched):

**173 conflicted paths.** This is not a mechanical merge.

| conflicted, highest risk | why it matters |
|---|---|
| `firebase.json` | both lineages changed `functions.predeploy` — live has `guard-functions-safety.js` first, the candidate has `gate-functions-require-closure.js` first. Both must survive. |
| `firestore.indexes.json` | index governance diverged on both sides |
| `functions/index.js` | the deploy entrypoint itself |
| `functions/procurement.js` | the Supply A-M engine — live changed it too |
| `functions/business-bootstrap.js`, `application-lifecycle.js`, `delivery-authority.js`, `delivery-pin.js`, `merchant-inventory.js` | live authority modules |

`firestore.rules`, `package.json` and `version.json` merge clean.

**This must NOT be attempted in this working tree.** It carries **192 uncommitted entries
belonging to other workstreams**; a 173-conflict merge here would put their unsaved work at
risk, and CLAUDE.md forbids overwriting it. Reconciliation belongs in a clean, dedicated
worktree, as its own authorised slice.

## 7. The route to a GO — three slices, in this order

> **Governing principle:** *never allow a green dependency gate to masquerade as a green release
> gate.* Require-closure exit 0 proves the tree is self-contained. It proves nothing about
> lineage, recency, runtime properties, or production health.

### Slice 1 — LINEAGE RECONCILIATION · **FIRST · NOT YET AUTHORISED**

A real integration project, not a merge: **173 conflicted paths** (§6b). **Only in a clean,
dedicated worktree** — never in this shared tree with its 192 entries of other workstreams'
uncommitted work.

**Both Functions predeploy controls must survive.** They answer different questions and neither
replaces the other:

```
production   guard-functions-safety.js         protects deployed RUNTIME PROPERTIES
candidate    gate-functions-require-closure.js protects GIT-TREE DEPENDENCY CLOSURE
```

Special treatment, because Supply and the production lineage both modify them:
`firebase.json` · `firestore.indexes.json` · `functions/index.js` · `functions/procurement.js`

Then re-certify the merged tree **as a new subject**. None of the Supply A→M evidence transfers:
closure is a property of a tree, and every suite was run against a different one.

### Slice 2 — GUARD SEMANTICS · SECOND

**Do not blindly change the guard to "diverged = fail."** The corrected evidence shows the real
protection is **property-based, not ancestry-based** — deliberately, because cherry-picked
convergence creates new SHAs, so correct code can sit on non-ancestor commits. An ancestry test
would have failed the very convergence it was meant to protect.

The design question to trace and specify before implementing:

> How do we keep property-level protection while also refusing a deploy from an unreviewed
> divergent lineage?

The answer likely needs all three, **composable rather than one replacing another**:

```
lineage safety  +  runtime/property safety  +  require-closure
```

### Slice 3 — PRODUCTION REMEDIATION · THIRD

Its own production-correctness slice, independent of any candidate: missing **AAAA record** ·
legacy host `217.20.124.84` still responding · four console errors including two **403s** and
`[SOKONI] Security verification failed` · the **unreproducible dirty build**.

The dirty build deserves particular weight: **a production artifact that cannot be reconstructed
from a known tree undermines the whole evidence chain**, even while its runtime behaviour looks
healthy. Everything else in this document reasons from "what is live"; that premise is currently
unverifiable.

### Then

Close or explicitly accept the four capability items in §5, re-run the full RVS block on the
reconciled tree, and issue a new GO/NO-GO. **Only an explicit human GO permits a deployment.**

---

**No deployment is authorised by this document.** Production remains `d592d8f` / v632.
The require-closure gate is green; the release is not.
