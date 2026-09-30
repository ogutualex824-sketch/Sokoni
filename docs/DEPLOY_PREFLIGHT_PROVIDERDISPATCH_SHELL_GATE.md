# Deployment preflight — `providerDispatch` shell-gate candidate — READ ONLY; deployment NOT authorized

**Run:** 2026-09-30T01:04:48Z · **Candidate:** `C:/temp/sok-pd-cand` @ `b28567c` (functions tree `c49c712`, clean) · **Packet:** `docs/release-gates/deploy-preflight-providerdispatch.json` · **Script:** scratchpad `deploy-preflight-pd.sh` (gcloud describes, one archive re-download, three Firestore `count()` reads; no writes). Follows [[CANDIDATE_PROVIDERDISPATCH_SHELL_GATE]].

| # | Check | Observed | Verdict |
|---|---|---|---|
| 1 | Rollback target still active | Cloud Run `providerdispatch`: latest ready **`providerdispatch-00048-qiz`**, **100 %** traffic, `latestRevision: true` | ✔ |
| 2 | Live source still the archive `e521e03` pins | `providerDispatch` updateTime 2026-09-09T06:02:15Z, source generation **1787386174474483**; the archive re-downloaded and **sha256-identical** to the copy the pin was built from (`6a312842…`) | ✔ |
| 3 | Candidate package = the 34-module closure | closure recomputed on `b28567c`: **34**, same set as the certified manifest | ✔ |
| 4 | Only two behavioural additions | `ROUTES`: archive 59 → candidate 61, added `businessWorkspace`, `workspaceHome`, removed none; dispatcher text identical to the archive outside the two edits | ✔ |
| 5 | 59 existing ops byte-identical | manifest: 377 archive-identical files, 10 gate, 1 dispatcher edit, 0 unexpected; every file/blob identical to the certified manifest | ✔ |
| 6 | No provider-onboarding files in the package | `provider-onboarding.js` **ARCHIVE-IDENTICAL**; `universal-onboarding.js` ARCHIVE-IDENTICAL; 0 exclusion violations | ✔ |
| 7 | Secrets / environment unchanged | live: **no secret bound**; env keys ALGOLIA_APP_ID, AT_ENV, AT_SENDER_ID, ETIMS_ENV, TYPESENSE_NODES (+ platform-set); candidate dispatcher declares **no** secret; `functions/.env` hash-identical to the archive's copy (values never read) | ✔ |
| 8 | Functions estate / Cloud Run unchanged underneath | **Changed, by peers, not on this function:** since 2026-09-29 22:5xZ the estate grew 1,720 → 1,722 and 8 rows changed — delivery (`availableDeliveries`, `claimAvailableDelivery`, `dispatchDelivery`, new `riderPresence`; 22:47Z, the D2 delivery release), `webhookWhatsapp` (new, 00:12Z), `initiateSTKPush`, `initiateSellerPayout`, `verifyIntasendPayment` (00:39Z). **`providerDispatch` row unchanged** (2026-09-09), Cloud Run revisions 49 as before. | ⚠ noted — the estate is live and other agents are deploying; **one deploy at a time** must be coordinated at the moment of any release |
| 9 | No overlapping providerDispatch work by others | git, all refs, since 2026-09-29, on `provider-dispatch.js` / `business-workspace.js` / `shared/approval-remediation.js`: only this session's commits (Alex Ogutu, capability line + candidate); no other worktree on a providerDispatch branch | ✔ |
| 10 | Kasindi untouched | Kasindi's own record **not read** (its gate is one-shot, on the owner's signal); instead `adminAudit` count **22** (unchanged since King Bruce), `applications` **13** (unchanged), `applicationDecisions` **0** — no decision of any kind has landed | ✔ |
| 11 | Hosting not part of this release | command scope `firebase deploy --only functions:providerDispatch`; the hosting predeploy chain does not run; the candidate's hosting files are `8c1c4fe`'s and are not deployed by that command | ✔ |
| 12 | Rollback revision available and usable | `providerdispatch-00048-qiz` exists, **Ready = True**, created 2026-08-22T08:09:35Z, currently serving 100 % | ✔ |

## Basis for a separate authorization

Eleven checks pass; the twelfth is a live-estate caveat, not a defect: other agents deployed delivery, WhatsApp and IntaSend functions overnight, none of them `providerDispatch`. Any release must be sequenced with them (never two concurrent deploys) and this preflight re-run immediately before the command, since the estate moves.

If authorized, the exact command and verification are in the candidate packet §6; rollback = traffic back to `providerdispatch-00048-qiz`. Kasindi's gate and the provider-onboarding security repair remain separate.

Related: [[CANDIDATE_PROVIDERDISPATCH_SHELL_GATE]] · [[PROVIDERDISPATCH_LINEAGE_CENSUS]]
