# SOKONI — Deployment Safety Checklist (Cloud Functions)

**Purpose:** guarantee that a full `firebase deploy --only functions` **cannot delete production functionality**.
**Current status: 🔴 NOT SAFE** — a full deploy would delete **7** live functions.

---

## 🔴 The rule that matters

> **Firebase deletes any deployed function that is absent from your source exports.**
> A full deploy is safe **only** when `deployed ⊆ exported`.

**Today:** deployed **1,410**, exported **1,403** → **7 would be deleted.**

**Until `orphans == 0`: targeted deploys ONLY.**
```bash
firebase deploy --only functions:<name>          # ✅ safe, never deletes
firebase deploy --only functions                 # 🔴 FORBIDDEN — deletes 7
```

---

## ✅ Pre-deploy gate (run before EVERY full functions deploy)

```bash
# 1. Snapshot production
firebase functions:list > .fnlist.txt

# 2. Reconcile deployed vs source (loads index.js — sees dynamic exports)
node scripts/deployment-integrity.js .fnlist.txt
```

**PROCEED only if the reconciler prints:**
```
ORPHANS (prod, not in source): 0
UNDEPLOYED (source, not in prod): <expected new functions only>
```

| Reconciler output | Meaning | Action |
|---|---|---|
| `ORPHANS: 0` | Source is a superset of production | ✅ **Safe to deploy** |
| `ORPHANS: > 0` | Deploy will **DELETE** those functions | 🔴 **STOP.** Re-export them (`recovery-plan.md` Path A) |
| `UNDEPLOYED: > 0` | Deploy will **CREATE** these | ⚠️ Confirm intentional + Cloud Run quota headroom |

---

## ⚠️ Never count exports with a regex

The reconciler **loads `functions/index.js`** and enumerates `Object.keys(module.exports)`. This is mandatory.

A static scan (`grep '^exports\.'`) **cannot see dynamically-generated exports** and produced a **147-function false positive** — `algoliaSync_*` (54), `searchSync_*` (18), `ts_*` (75) are all created in loops/factories. Acting on that false reading would have **deleted the entire Algolia/Firestore search-sync layer**.

> **Rule: if a tool tells you a Firestore trigger is "orphaned," distrust the tool before you distrust production.** An onCall dispatcher can never replace an event trigger, so an event-triggered "orphan" is almost always a measurement error.

---

## Classification rules (evidence-based)

| Trigger type | Can it have been consolidated into a dispatcher? |
|---|---|
| `callable` / `https` | **Yes** — client-invoked; a dispatcher can absorb it |
| `firestore` / `scheduler` / `pubsub` / `storage` / `auth` / `eventarc` | **NO** — fires automatically; a dispatcher **cannot** replace it |

**Before deleting ANY function, all must hold:**
- [ ] 30-day invocation count = **0** (Cloud Monitoring — *not* inferred)
- [ ] No Cloud Scheduler job targets it
- [ ] No Eventarc trigger / Pub/Sub subscription bound to it
- [ ] Not a Firestore/Storage/Auth trigger
- [ ] No client (`httpsCallable`) or external/webhook caller
- [ ] A live replacement (dispatcher) is **deployed AND exported**

**If any box is unchecked → do not delete. Re-export instead.**
Never classify a function obsolete because of its *name*.

---

## Quota gate

- Cloud Run ceiling previously hit at **~1,500** services. Current: **1,410**.
- Before a deploy that **creates** functions, confirm headroom: `deployed + new < 1,450`.

---

## Rollback

Targeted deploys are individually reversible:
```bash
git revert <sha>
firebase deploy --only functions:<name>
```
A full deploy that deletes functions is **NOT** cleanly reversible — the deleted service's config, URL, and Eventarc bindings are gone. **This is the entire reason for the gate above.**

---

## Sign-off

A full `firebase deploy --only functions` is authorised **only** when:

- [ ] `node scripts/deployment-integrity.js` reports **ORPHANS: 0**
- [ ] `UNDEPLOYED` contains only functions you intend to create
- [ ] `node scripts/verify-architecture.js` passes
- [ ] Quota headroom confirmed
- [ ] Deploy performed from a **clean working tree** on a tagged commit

**Current sign-off: ❌ BLOCKED — 7 orphans.** Apply `recovery-plan.md` **Path A** (zero-risk re-export) to clear it.

Related: `deployment-integrity-report.md` · `recovery-plan.md` · `orphan-functions.csv`
