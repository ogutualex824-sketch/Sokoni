# Candidate `c7e26b6` — `providerDispatch` shell gate, minimal, runtime configuration matched to live — re-certified; NOT deployed

**Date:** 2026-09-30 · **Worktree** `C:/temp/sok-pd-cand` · **Branch** `candidate/providerdispatch-shell-gate` · **Tip / functions tree** **`c7e26b6`** · **Supersedes** `b28567c` (tree `c49c712`), which the Firebase CLI correctly refused before upload because the archive's dispatcher declared `minInstances: 1` while the live service runs with 0 ([[CANDIDATE_PROVIDERDISPATCH_SHELL_GATE]], CHANGELOG 2026-09-30). `b28567c` is preserved in history as the attempted candidate; this is a **new** candidate identity. **Packet:** `docs/release-gates/providerdispatch-candidate-c7e26b6-manifest.json`. Owner authorization for this step covered exactly the config-only correction + re-certification. **No deployment, no Kasindi read or write, no hosting change, no `--force`.**

## 1 · The one change since `b28567c`

`functions/provider-dispatch.js` `_OPTS.minInstances`: `1 → 0`. Manifest diff against the `b28567c` manifest: **one blob differs** (`provider-dispatch.js`); every other file identical. Live service: `minInstanceCount` 0 (Cloud Run `providerdispatch-00048-qiz`). Archive `_OPTS` vs candidate `_OPTS`: identical in region, `enforceAppCheck: true`, `timeoutSeconds: 120`, `memory: '512MiB'`; only `minInstances` differs, and it now equals live. No behavioural change.

## 2 · The complete dispatcher diff against the pinned archive (`e521e03`)

```
-  minInstances:    1,
+  minInstances:    0,     /* MATCHES THE LIVE SERVICE (minInstanceCount 0) … */
-      require('./booking-resolution')._h);
+      require('./booking-resolution')._h,
+      require('./business-workspace')._h);         /* shell gate */
+  'businessWorkspace',
+  'workspaceHome',
```

## 3 · Required evidence

| Requirement | Result on `c7e26b6` |
|---|---|
| Candidate manifest regenerated | 388 files = 377 archive-identical + 10 gate + 1 dispatcher edit; 0 unexpected; 0 exclusion violations |
| Shell-gate suite | **21 / 0** (+1 n/a, hosting consumer not in tree) |
| Archive-compatibility suite (archive `subscription-core` / `subscription-catalog`, unstubbed) | **9 / 0** |
| Mutation suite (7 mutations, each must fail by assertion) | **9 / 0** — 9 / 8 / 1 / 1 / 1 / 1 / 4 failing assertions, no crash, file restored byte-identical |
| Closure exactly the intended set | **34**, same set as certified |
| 59 existing ops unchanged; only two added | `ROUTES` 59 → 61, added `businessWorkspace`, `workspaceHome`, removed none |
| provider-onboarding excluded | `provider-onboarding.js` ARCHIVE-IDENTICAL; `universal-onboarding.js` ARCHIVE-IDENTICAL |
| No secret / environment change | candidate declares no secret; live binds none; `functions/.env` hash-identical to the archive's copy (values never read) |
| Runtime configuration matches live | `minInstances: 0` = live `minInstanceCount` 0 |
| Workspace suites | capabilities 46 / 0 · business-workspace 30 / 0 · workspace-capability 51 / 0 |
| Syntax gate | see §4 |
| Worktree | clean at `c7e26b6` |
| Kasindi | not read, not written |
| Hosting | untouched (live hosting is now `49e0f3a`, released by another session at 00:20Z; any future hosting candidate descends from it) |

## 4 · Before any deployment attempt (not authorized yet)

Fresh final preflight (scratchpad `deploy-preflight-pd.sh`, read-only) immediately before; confirm no Cloud Build in progress and no function updated in the preceding 30 minutes; peers asked to hold; **never `--force`**; command `firebase deploy --only functions:providerDispatch --project sokoni-aeb26` from `C:/temp/sok-pd-cand` at `c7e26b6`; rollback = traffic back to `providerdispatch-00048-qiz`. Post-deploy identity proof: the new revision's source archive contains `business-workspace.js` and the candidate's `provider-dispatch.js` bytes (an unauthenticated call cannot discriminate old from new because App Check answers first).

Related: [[CANDIDATE_PROVIDERDISPATCH_SHELL_GATE]] · [[DEPLOY_PREFLIGHT_PROVIDERDISPATCH_SHELL_GATE]] · [[PROVIDERDISPATCH_LINEAGE_CENSUS]]
