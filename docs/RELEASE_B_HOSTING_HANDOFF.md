# Release B — Hosting Snapshot Handoff (marketplace 3%→5% client rates)

**Status:** Authorized, blocked locally, ready for CI. **Date:** 2026-08-29

> Marketplace commission moved **3% → 5%**. The server (functions) is **already live at 5%** —
> Release A. Release B publishes the matching **client rate snapshot** so the UI stops
> displaying the stale 3%. It is a **single-file hosting change** and nothing else.

---

## Current board

| Release | State |
|---|---|
| **A — production functions** (14 commission GCFs, reconciled lineage, marketplace 5%) | ✅ **GREEN / live at 5%** |
| **B — hosting snapshot** (`sokoni-commission-rates.js` → 5%) | ⛔ **Authorized, blocked locally** — this handoff |
| **Real-transaction acceptance at 5%** | ⏳ **OPEN, deferred** (genuine Daraja sale → 5% receivable → C2B collection; never fabricated) |

**Known, explicitly-recorded temporary mismatch:** until Release B ships, the **server charges 5%**
while the **client snapshot displays 3%**. This is documented, not hidden. No hosting release has occurred.

---

## What to deploy

- **Branch:** `fix/commission-subsystem-converge`
- **Commit:** `26b415d` (on top of `960ac72`)
- **The only client change:** `sokoni-commission-rates.js` — `"marketplace": { "pct": 5 }` (was 3),
  regenerated from `functions/commission-config.js` via `scripts/build-commission-snapshot.js`.
  Every other category is unchanged (services 15, food 5, property 2, digital 10, …).

The branch also carries the Release-A function convergence (already live). A **hosting** deploy
publishes only client assets; it does not touch functions.

## Why it is blocked locally (do NOT try to "fix" this as part of Release B)

The local hosting deploy stopped at the **`perf-guard`** predeploy gate. The failures are
**environmental, not the change**:

- `guard-no-rollback` **passed** (`26b415d contains live 712fb34`).
- The real cache-version check **passed** (`v577 → v578`, strictly ahead, no regression).
- What fails: `test-cache-version-floor` **self-test CONTROLS** reference a stale `live v564`
  (live is v577), plus **persona-gated** and **browser-dependent** cart/auth tests. This is the
  known "full hosting gate never exits 0 on this workstation" instability.
- **No failing check references `sokoni-commission-rates.js`.**

The stale v564 control and the persona/browser failures are **separate gate-maintenance work**.
Do **not** bundle that into this money-policy display release, and do **not** bypass or weaken
`perf-guard` to push Release B through.

## Operator / CI steps (run in the established CI / persona-equipped environment where the v577 hosting gate is valid)

```
git fetch && git checkout fix/commission-subsystem-converge   # @ 26b415d
firebase deploy --only hosting --project sokoni-aeb26
```

- Deploy **only** the hosting change. No functions, rules, indexes, reCAPTCHA, ETIMS, POS/settlement,
  other hosting files, or any rate change beyond the certified marketplace 3%→5%.
- Do **not** bypass gates or modify gate controls as part of Release B. If the valid-gate environment
  still fails on `perf-guard`, stop and treat it as gate maintenance — separate from this release.

## Post-deploy verification (Release B close condition)

Verify against live `https://mysokoni.co.ke` — use `curl -sL` **without** `?cb` (cache-buster
`?cb` triggers cleanUrls 301-loops and gives false diffs):

1. Live `sokoni-commission-rates.js` reports **marketplace `pct: 5`**.
2. **services** remains **15**.
3. **food_delivery** remains **5**.
4. The snapshot **matches the deployed server rate table** (server already 5% — Release A).
5. **No unrelated hosting assets changed** (spot-check `checkout.html`, `index.html`, `product.html`
   unchanged vs pre-deploy).

Then record **Release B GREEN**, and the board becomes: **A GREEN → B GREEN → real-transaction
acceptance OPEN/deferred**.

## Verifying Release A stayed intact (reference)

Deployed function source is readable without gcloud, via ADC:
CF v2 `getFunction` → `buildConfig.source.storageSource` → GCS `…?alt=media` download → extract.
Live `posCompleteCheckout` bundle confirmed: `commission-config` marketplace `pct:5`; services 15;
`0fe23f1` (`_assertSellAuthority`), `3747f01` (double-credit fix), `merchant-authority.js`, and the
webhook boost-activation all present (no revert). Certification: `scripts/test-commission-converge.js` (20/0).
