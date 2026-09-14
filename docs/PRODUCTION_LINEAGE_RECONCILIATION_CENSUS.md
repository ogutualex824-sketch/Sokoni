# Production Lineage Reconciliation — Census

**Date:** 2026-09-14 · **HEAD:** `1ef1d72` (`release/multishop-checkout-certified`)
**Status:** READ-ONLY. **No merge, no rebase, no cherry-pick, no worktree created, no deploy, no
deletion.** Every comparison below used `git show` / `git merge-base` / `git merge-tree`, none of
which touch the working tree.

Related: [[PRODUCTION_DRIFT_DEPLOYMENT_PREFLIGHT]] · [[INTASEND_WEBHOOK_RETIREMENT_CENSUS]] ·
[[project_pos_card_terminal_rail]] · [[project_functions_provenance_divergence]]

---

## 1. What is actually serving production

| | commit | branch | note |
|---|---|---|---|
| **Hosting** | `d592d8f` | `release/r1-pos-printer-fn` | built 2026-09-02, `dirtyWorkingTree: true` |
| **Functions** | *not commit-stamped* | — | deployed 2026-09-09 06:0x; build label `firebase-functions-hash: cc80b419…` |

**Functions carry no commit provenance.** `version.json` is a hosting artifact; the deployed
functions record only a content hash and a Cloud Build id. So "which commit is in production" is
answerable for hosting and **only inferable** for functions. That asymmetry is itself a finding:
a functions rollback has no commit to roll back *to* without reconstructing it from the hash.

`d592d8f` is contained by **nine** local branches. The branch production names,
`release/r1-pos-printer-fn`, has since moved on to `8fc3673` — so even the named production branch
is **34 commits ahead of what is live**.

---

## 2. Our branch is the only one that left the production lineage

| branch | tip | ahead of live | behind live |
|---|---|---:|---:|
| `release/merchant-launch-rc` | `7507b1a` | 614 | **0** |
| `integration/rc-converged` | `d080528` | 425 | **0** |
| `release/reconcile-d592d8f` | `3e1a13a` | 313 | **0** |
| `slice/realtime-control-plane` | `25b5e00` | 229 | **0** |
| `release/r1-pos-printer-fn` | `8fc3673` | 34 | **0** |
| **`release/multishop-checkout-certified`** | **`1ef1d72`** | **240** | **576** |

Every other active branch **contains** the live commit. Ours does not. The "576 commits" from the
preflight are not an obstacle between two peers — they are the production mainline that **our
branch alone never took**.

That settles the direction of integration before any conflict analysis: **the certified payment
work must move onto the production lineage, not the lineage onto us.**

---

## 3. Two findings that make the direction non-negotiable

### 3.1 The Daraja retirement already exists on the mainline — by another route

| lineage | `darajaSTKPush` | `sendTestSTKPush` | `validateDarajaCredentials` | `intasendWebhook` |
|---|---|---|---|---|
| `d592d8f` (live) | 1 | 1 | 1 | 1 |
| `release/r1-pos-printer-fn` | 1 | 1 | 1 | 1 |
| `integration/rc-converged` | **0** | **0** | **0** | 1 |
| `release/merchant-launch-rc` | **0** | **0** | **0** | 1 |
| `slice/realtime-control-plane` | **0** | **0** | **0** | 1 |
| **ours** | **0** | **0** | **0** | **0** |

Four lineages already removed the Daraja outbound rail, via the earlier `2165817` work. **Only the
`intasendWebhook` retirement is genuinely unique to our branch.** Most of what we would be
"porting forward" is already there, arrived at independently.

### 3.2 Our branch would RE-EXPORT a quarantined card-terminal surface

| lineage | `posInitiateTerminalPaymentV1` | `posCancelTerminalPaymentV1` |
|---|---|---|
| `d592d8f` (live) · `r1-pos-printer-fn` · `rc-converged` · `merchant-launch-rc` | **0** | **0** |
| **ours** | **1** | **1** |

`rc-converged` renamed them `const _retired_posInitiateTerminalPaymentV1 = …`; our branch still has
`exports.posInitiateTerminalPaymentV1 = onCall(…)`. The de-export commit `8c1c4fe` (2026-08-25) is
**not in our history at all.**

Both are **live in production today**. Making our branch the production lineage would re-export a
rail that [[project_pos_card_terminal_rail]] records as quarantined, whose V1 bodies use the weaker
`businesses.uid` tenancy check.

**This is the decisive argument.** Promoting our branch would not merely miss 576 commits — it
would actively resurrect a surface four other lineages deliberately closed.

---

## 4. The certified chain — bounded and portable

**14 commits, 48 files**, `12fc4e7~1..1ef1d72`:

```
12fc4e7  handset verification prepared        1f8ac7b  POS QR ownership authority
dd30f71  handset verification RUN (FAIL)      68e0b53  wiring gate HELD, self-arming
1a6ab43  RES-1b cleanup                       754704a  Daraja setup console retired (UI)
2e09929  P1 — confirmation asks the gateway   d2e1c40  Daraja outbound deleted from prod
3dc56d2  P2 — the till prompt is sent         a5b13cb  P3-A — callback association
cefa0ec  P3 — dead match-back removed         98059f8  P3-A suite commit-state independent
800decc  D1+D2 — Daraja retired / QR rail     1ef1d72  intasendWebhook retired
```

**Five new modules, none of which can conflict (pure additions):**
`shared/intasend-verify.js` (P1) · `shared/pos-payment-ownership.js` ·
`shared/pos-qr-association.js` (P3-A) · plus `shared/stk-gateway.js` and
`shared/merchant-identity.js`, which already exist elsewhere.

> `shared/stk-gateway.js` is **byte-identical** to the copy on `slice/realtime-control-plane`
> (blob `96fffd7f…`) — because P2 recovered it verbatim from `cc93c24` rather than rewriting it.
> `shared/merchant-identity.js` **differs** between the two and is a genuine reconciliation item.

---

## 5. Minimal forward integration — measured, not assumed

Dry-run merges (`git merge-tree`, no working tree touched):

| target | total conflicts | **of which are OUR certified files** |
|---|---:|---:|
| `release/r1-pos-printer-fn` | 194 | — |
| `release/merchant-launch-rc` | 52 | 13 |
| **`integration/rc-converged`** | **39** | **9** |

**`integration/rc-converged` is the smallest reconciliation surface**, and its merge-base with us
is `adb619f` (2026-09-05) — a month closer than `r1-pos-printer-fn`'s `3dcf572` (2026-08-13).

The nine conflicting certified files:

```
CHANGELOG.md                 functions/index.js          payments.html
merchant-v2.html             pos.js                      seller.html
sokoni-endpoints.js          sokoni-merchant-store-ui.js sokoni-mpesa.js
```

**So a minimal forward integration IS possible**: nine files to resolve, not 1192, and the five new
modules carry across as additions.

### One warning that must not be lost

`functions/pos-qr.js` was changed on **both** sides (4 commits ours, 1 theirs) yet git reports **no
conflict** — it auto-merged on non-overlapping hunks. **A clean textual merge of a payment file is
not evidence of a correct one.** P1/P2/P3 must be **re-certified against the merged tree**, not
assumed to have survived. `functions/mpesa-c2b.js` was changed by them and not by us, so their
version simply wins — which is correct, but again needs asserting rather than assuming.

---

## 6. Classification of every payment-relevant difference

| difference | classification | disposition |
|---|---|---|
| Daraja outbound exports | already retired on mainline | **nothing to carry** |
| `intasendWebhook` export | certified SOKONI work, unique to us | **carry forward** |
| P1 verification + `intasend-verify.js` | certified, unique to us | **carry forward** |
| P2 gateway wiring | certified; module identical, wiring differs | **carry, reconcile wiring** |
| P3 `pendingMpesaPhone` removal | certified, unique to us | **carry forward** |
| P3-A association + module | certified, unique to us | **carry forward** |
| POS ownership authority | certified, unique to us | **carry forward** |
| Daraja UI retirement (`payments.html` etc.) | certified, unique to us | **carry forward** |
| `posInitiateTerminalPaymentV1` / `Cancel` | **obsolete/retired on mainline** | **DO NOT carry — take theirs** |
| `merchant-identity.js` divergence | two certified versions | **reconcile explicitly** |
| `pos.js`, `seller.html`, `merchant-v2.html` | another-agent + production work | **take theirs, re-apply ours** |
| the other 1143 differing files | existing production work | **preserve — do not touch** |

---

## 7. The clean lineage this gate proposes

```
d592d8f ─ live hosting
   │
   └── integration/rc-converged  (d080528)   ← contains live; Daraja already retired
              │
              └── release/payments-reconciled   ← NEW, created from rc-converged
                        │
                        ├── the 5 new shared modules (pure additions)
                        ├── P1 · P2 · P3 · D2 wiring into pos-qr.js
                        ├── P3-A association into webhookIntasend
                        ├── intasendWebhook retirement
                        └── Daraja UI retirement
                        │
                        └── PRODUCTION CANDIDATE  (re-certified, then deployable)
```

Built **from a clean `git worktree` on a named commit**, never from the current working tree — which
carries 34 dirty files under `functions/` alone, belonging to other agents.

### Explicitly NOT carried forward

* `posInitiateTerminalPaymentV1` / `posCancelTerminalPaymentV1` — our branch's exports are stale;
  the mainline's `_retired_*` rename wins.
* Our `CHANGELOG.md` ordering — append, never overwrite.
* Any of the 240 commits on our branch unrelated to the payment chain.
* The 4 uncommitted other-agent exports and 34 dirty `functions/` files.

---

## 8. The deployment guard — the exact smallest change

Current logic, from the file's own header: *"otherwise (ahead / **diverged** / live commit unknown
here) → allowed."*

```js
// now:  abort only when HEAD is strictly BEHIND
git merge-base --is-ancestor <HEAD> <live>     → abort

// proposed: allow only when HEAD is strictly AHEAD (or equal)
git merge-base --is-ancestor <live> <HEAD>     → allow, else abort
```

One inverted ancestry test. Evaluated read-only, **with a positive control so it is not merely
more restrictive**:

| tree | current | proposed |
|---|---|---|
| ours (`1ef1d72`, diverged) | **allowed** ← the gap | **ABORTS** ✔ |
| `release/merchant-launch-rc` (genuinely ahead) | allowed | **allowed** ✔ not over-blocking |

The fail-open behaviour when production is unreachable must be **kept** — a guard that blocks
deploys during an outage is its own incident.

**Not changed in this census.** The analysis establishes the exact smallest change; applying it is
its own gate.

---

## 9. Certified artifacts unchanged

`functions/shared/`, `functions/pos-qr.js`, `payments.html`, `merchant-v2.html` and every
`scripts/certify-*.js` are **unmodified**. The only dirty file among them is `functions/index.js`,
which carried another agent's four hunks before this census began and still does.

---

## 10. What this census changes about the plan

The preflight recommended one safe operation: a named-only functions update from `1ef1d72`.
**This census withdraws that recommendation.**

Deploying functions from `1ef1d72` would ship a tree that **re-exports the quarantined Terminal V1
rail**, and would leave every retirement one ordinary mainline deploy away from being undone.
The correct order is:

1. create `release/payments-reconciled` from `integration/rc-converged`, in a clean worktree;
2. carry the certified payment work forward — nine files to resolve;
3. **re-run all 13 suites against the reconciled tree** (a clean merge is not a certification);
4. strengthen the guard;
5. *then* open the production deployment authorization gate.

**Nothing in steps 1–5 has been done.** This gate ends here.
