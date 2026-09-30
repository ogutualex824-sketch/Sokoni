# Candidate — `providerDispatch` shell gate, minimal — constructed and certified; NOT deployed

**Date:** 2026-09-30 · **Worktree** `C:/temp/sok-pd-cand` (mine) · **Branch** `candidate/providerdispatch-shell-gate` · **Tip** `40693c6` (functions tree fixed at **`c49c712`**; later commits are test-only under `scripts/`) · **Packet:** `docs/release-gates/providerdispatch-candidate-manifest.json` (every file under `functions/` with its git blob hash and origin; the exclusion proof; the dispatcher closure). Owner scope honoured: deployed archive as pinned baseline + the 12-module closure + the two-line dispatcher merge; everything else excluded. **No deployment, no Kasindi write, no provider-onboarding change.**

## 1 · Provenance — pinned by bytes, not by commit proximity

| Commit | What it is |
|---|---|
| `8c1c4fe` (2026-08-25) | branch point — the commit whose functions tree matched the most archive blobs (371 / 378); carries the tracked `functions/.env` |
| **`e521e03` pin** | `functions/` replaced by the deployed archive **byte-for-byte**: `gs://gcf-v2-sources-24799054989-us-central1/providerDispatch/function-source.zip#1787386174474483` (uploaded 2026-08-22T08:09:34Z), **378 files, 0 mismatches**, no file the archive lacks, no file the archive has that the tree lacks. The 7 files where `8c1c4fe` differed (`application-lifecycle`, `business-bootstrap`, `commission`, `index`, `order-settlement`, `platform-health`, `pos-zero-friction`) hold the archive's bytes, whose blobs trace to `ed1c16b` / `0dbb200` / `f4422b4` / `b29d4fb` / `8c1c4fe` — the archive was a working tree between those commits; the pin does not pretend otherwise |
| **`c49c712` gate** | + 10 new modules, identical to `slice/c4-capability-consumer`: `business-workspace.js`, `shared/approval-remediation.js`, `shared/business-capabilities.js`, `shared/business-scope.js`, `shared/cleanup-claimed-ids.json`, `business-category.js`, `capability-authority.js`, `healthcare-category.js`, `healthcare-plans.js`, `healthcare-workspace.js`; `subscription-core.js` and `subscription-catalog.js` stay at the **archive** versions (the 12-module closure is complete with them); `provider-dispatch.js` = archive + the two edits below |
| `32b18d9`, `40693c6` | test-only infrastructure under `scripts/` (never deploys) |

`functions/.env`: tracked at `8c1c4fe`, **hash-identical** to the archive's copy, untouched (values never read or printed). No credential-like file tracked under `functions/`.

## 2 · The exact dispatcher diff (the only modified file)

```
-      require('./booking-resolution')._h);         /* Slice 2: affected-booking resolution engine */
+      require('./booking-resolution')._h,          /* Slice 2: affected-booking resolution engine */
+      require('./business-workspace')._h);         /* shell gate: the ONE business workspace authority (derived approval state) */
+  'businessWorkspace',
+  'workspaceHome',
```

Not merged, not routed: `healthcare-workspace._h`, `provider-directory._h`, `providerRequestShop`. No secret declared or bound (the archive dispatcher binds none; the c4 one binds `QR_SIGNING_SECRET` for the excluded `providerRequestShop`).

## 3 · Closure and exclusion proof

- **Dispatcher require closure: 34 modules** = the archive's 23 + the 11 gate modules (10 new + `provider-dispatch.js` itself); all present on disk; `gate-functions-require-closure.js` PASS on the candidate.
- **Excluded modules — proven** (`candidate-manifest.js`, 0 violations): **ARCHIVE-IDENTICAL** — `commission-config`, `finos-utils`, `subscription-core`, `subscription-catalog`, `notify`, `sms-service`, `provider-onboarding`, `provider-ops`, `booking-service`, `booking-payment-sweep`, `availability`, `legal-agreements`, `financial-os`, `kasshop`, `application-lifecycle`, `universal-onboarding`; **ABSENT** — `provider-shop`, `sokoni-till`, `sokoni-qr-authority`, `event-ops`, `entertainment-bookings`, `ent-availability`, `ent-rate-cards`, `ent-enquiries`, `creator-hub`, `venue-payments`, `provider-directory`, `reputation`, `provider-hub`, `role-authority`, `business-wallet`, `money-authority`, `seller-trial`, `tenant-identity`, `shop-employees`, `business-approval-admin`.
- Manifest counts: **388 files** = 377 archive-identical + 10 gate + 1 dispatcher edit; **0 unexpected**.

## 4 · Certification on the candidate tree

| Proof | Result |
|---|---|
| `test-shell-approval-gate.js` (gate matrix: VALID routes; DJ / Kasindi / stub / role-only → REAPPLICATION_REQUIRED; Heights PENDING; King Bruce REFUSED; cleanup-claimed withheld; buyer; unreadable fail-closed; homeFor shop gate; handler; read-only; static cleanup copy digest) | **21 / 0** (+1 n/a: the hosting consumer is not in this tree) |
| `test-candidate-shell-gate-compat.js` — gate running against the **archive's own** `subscription-core` / `subscription-catalog`, unstubbed; dispatcher merges/routes exactly the two ops | **9 / 0** |
| `test-shell-gate-mutations.js` — 7 mutations of the authority (gate removed; NO_APPROVAL treated as valid; cleanup ownership ignored; REFUSED not held; fail-open on unreadable; shop homes ungated; dashboard route instead of completion) — each must make the gate suite fail **by assertion** | **9 / 0**, failures 9 / 8 / 1 / 1 / 1 / 1 / 4, no crash, file restored byte-identical |
| `test-business-capabilities.js` · `test-business-workspace.js` · `test-workspace-capability.js` | 46 / 0 · 30 / 0 · 51 / 0 |
| `gate-functions-require-closure.js` · `verify-commission-single-source.js` · `verify-delivery-engine-sync.js` · `predeploy-payout-gate.js` (this base's functions predeploy chain + the closure gate) | PASS · PASS · PASS · exit 0 |
| `predeploy-syntax-gate.js` | **pending — running on the candidate tree at the time of writing** (see CHANGELOG follow-up) |
| `functions-allowlist.js providerDispatch` | not blocked; prints `firebase deploy --only functions:providerDispatch`; runs nothing |
| Comparison against the live archive | `git diff e521e03 c49c712 -- functions`: 11 files, +2,073 / −1; nothing else |
| Configuration | `.env` identical to the archive's; no secrets bound or declared by the dispatcher |
| Worktree | clean at `40693c6`; no deploy command run |

## 5 · What this candidate changes in production, and only that

`providerDispatch` gains two ops (`businessWorkspace`, `workspaceHome`) answered by the derived approval state. All 59 existing ops keep the **archive's** code byte-for-byte — no commission schedule, no subscription store change, no SMS change, no entertainment stack, no onboarding change. The provider-onboarding security repair remains its **own** candidate (deliberately not here). The hosting counterpart (`complete-application.html`, its module, the `sokoni-business-workspace.js` consumer) ships separately, from the live hosting line, **after** this function, so the consumer never calls an op that does not exist.

## 6 · Release recipe (not authorized; recorded so the decision is exact)

From `C:/temp/sok-pd-cand` at `40693c6` (functions tree `c49c712`), clean tree: re-`describe` `providerDispatch` (revision must still be `providerdispatch-00048-qiz`); `firebase deploy --only functions:providerDispatch --project sokoni-aeb26`; verify: `gcloud functions describe` shows a new revision, a signed-in provider account you own (not Kasindi) gets `businessWorkspace → approval.state`, an unrelated existing op (e.g. `providerGetProfile`) answers as before; rollback = route traffic back to `providerdispatch-00048-qiz`, never `run services update`.

Related: [[PROVIDERDISPATCH_LINEAGE_CENSUS]] · [[FUNCTIONS_PREFLIGHT_SHELL_GATE]] · [[COMPLETE_APPLICATION_SHELL_GATE]]
