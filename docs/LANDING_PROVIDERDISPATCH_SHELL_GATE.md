# Landing — `providerDispatch` shell gate, candidate `c7e26b6`, DEPLOYED (owner-authorized)

**Deployed 2026-09-30T02:07:13Z** with `firebase deploy --only functions:providerDispatch --project sokoni-aeb26` from `C:/temp/sok-pd-cand` at branch tip `bed11db` (functions tree **`c7e26b6`**), **no `--force`**. Final preflight at 01:54:43Z green; no Cloud Build in progress; no function updated in the preceding 30 minutes; all three peer sessions confirmed holding; candidate tree verified equal to `c7e26b6` before the command. **Packet:** `docs/release-gates/providerdispatch-landing.json`. Scope honoured: one function; no hosting, no rules, no provider-onboarding change, no Kasindi read or write.

## 1 · New revision, proven from its own source archive

| Check | Observed |
|---|---|
| Revision | Cloud Run `providerdispatch-00050-rur`, Ready, **100 %** traffic; function state ACTIVE |
| Source archive | generation **1790733957691735**; downloaded and compared: **388 / 388 candidate files byte-identical**, `.env` hash-identical to the tracked copy; archive has 389 files (the candidate's 388 + `.env`) |
| `minInstances` | source `0`; live `minInstanceCount` unset (0) — matches |
| Ops | 61 in the deployed dispatcher; `businessWorkspace` present, `workspaceHome` present |
| `business-workspace.js` | present in the deployed archive |
| 59 pre-existing ops preserved | of the old archive's 23-module closure, **22 byte-identical** in the new archive; the only differing file is `provider-dispatch.js` (the merge, two routes, `minInstances`) |
| `provider-onboarding.js` | byte-identical to the OLD deployed archive — the security repair is **not** in this release |
| Secrets / environment | no secret bound; env keys unchanged (`ALGOLIA_APP_ID`, `AT_ENV`, `AT_SENDER_ID`, `ETIMS_ENV`, `TYPESENSE_NODES` + platform-set); memory 512 Mi, timeout 120 s, max instances 80 — as before |
| Rollback | `providerdispatch-00048-qiz` still exists, Ready = True |
| Container startup | new instance started 02:07:02Z for the rollout; **STARTUP TCP probe succeeded after 1 attempt**; no module-load or runtime error in the revision's logs — the 34-module closure loads in production |

## 2 · Smoke — what could and could not be exercised

- **Endpoint liveness:** `businessWorkspace`, an existing op (`providerGetProfile`) and a nonsense op all answer `UNAUTHENTICATED` from the callable endpoint, exactly as before the deploy. App Check (`enforceAppCheck: true`) answers before the op is examined, so an unauthenticated probe **cannot** distinguish old from new code and **cannot** exercise the two new ops; identity is established by the archive comparison above, not by these probes.
- **Functional smoke of the two new ops in production: not attempted.** It requires a browser session with a real provider account and a valid App Check token. The only account of that kind in scope is Kasindi's, which is excluded. The behaviour is the harness-proven one (shell-gate 21/0, archive-compat 9/0, mutations 9/0 on this exact tree). This is stated as harness evidence, not live evidence.
- **Consequence for users today: none yet.** The live hosting (`49e0f3a`, v644) serves **no** `sokoni-business-workspace.js` (404) and the live `provider-dashboard.html` does not load one, so nothing in production calls the new ops. The gate takes effect only when the hosting counterpart (consumer + completion surface) ships from the live hosting line — a separate, unauthorized step.

## 3 · Isolation

Firestore counts after the deploy: `adminAudit` 22, `applications` 13, `applicationDecisions` 0, `providers` 11 — unchanged; Kasindi's record not read. No other function changed by this deploy (scoped command; the estate's other rows are as the preflight recorded them).

## 4 · Next (each needs its own authorization)

1. Hosting counterpart for the gate: `sokoni-business-workspace.js` (consumer with the REAPPLICATION_REQUIRED redirect), `complete-application.html`, `sokoni-complete-application.js`, ported onto the **current** live line `49e0f3a` (not `ec452fb`), preflighted like the acknowledgement surface was. Until then the 18 misrouted accounts are unchanged.
2. Provider-onboarding security repair: its own candidate on the same pinned-archive method.
3. Kasindi: acknowledgement gate on the owner's signal, then the fresh decision through the c4 handler locally.

Related: [[CANDIDATE_PROVIDERDISPATCH_SHELL_GATE_C7E26B6]] · [[DEPLOY_PREFLIGHT_PROVIDERDISPATCH_SHELL_GATE]] · [[COMPLETE_APPLICATION_SHELL_GATE]]
