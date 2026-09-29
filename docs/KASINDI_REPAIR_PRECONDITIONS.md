# Kasindi repair — the two preconditions, built and proven (no production write)

**Date:** 2026-09-29 · **Branch** `slice/c4-capability-consumer` · **Status:** both pieces implemented and tested locally; **nothing deployed, nothing written to production, Kasindi's application untouched.** Follows [[KASINDI_REPAIR_CENSUS]] and the owner's four decisions: (1) a proper user-facing re-acknowledgement surface, not a hidden write; (2) a real admin Auth account decides; (3) server-side `priorDecisions` preservation before any re-decision; (4) the c4 handler, run locally under the manifest gate, is the vehicle.

## 1 · Preservation: `priorDecisions` on `applicationDecide` (decision 3)

`functions/application-lifecycle.js` — `priorDecisionsPatch(app, actor, decision)` (exported under `_internal`), called by `applicationDecide` immediately before it overwrites `decidedBy` / `decidedAt`:

- If the document already carries a `decidedBy`, the existing decision is appended **verbatim** to `priorDecisions`: `{ status, statusCanonical, decidedBy, decidedAt, decisionAppliedFor, projectionStatus, reviewReason, preservedAt, preservedBy, supersededBy }`. `preservedBy` names the admin who *preserved* it; `decidedBy` inside the entry stays whatever it was — for Kasindi, `"reindex"`. Nothing reinterprets the old state as an admin decision.
- Deduplicated on (`decidedBy`, `decidedAt`): re-deciding twice preserves once. A first decision on an undecided document writes no `priorDecisions` field at all.
- **Server-only.** `firestore.rules`: `priorDecisions` is added to `noApplicationDecision()`'s decision keys (the applicant cannot write it), and the applications `update` rule now refuses **an administrator's raw client write** to it as well — the only writer is `applicationDecide` (same posture R1 gave the capability stamps). `sokoni-merchant-application.js` FORBIDDEN refuses it at intake.

The written record after Kasindi's future re-approval would therefore read: *July 2026 — `priorDecisions[0]`: approved, decidedBy `"reindex"`, one second after intake; September 2026 — `decidedBy: <admin uid>`, `decidedAt` now, `applicationDecisions/PRVMS7IACKG`, `adminAudit application_approve`.* The document itself tells the truth.

## 2 · Re-acknowledgement surface (decision 1)

`agreement-acknowledge.html` + `sokoni-agreement-acknowledge.js` (UMD: `eligible`, `buildAcknowledgement`, `mount`).

- **What it does.** Signed-in user → lists **their own** applications (`where uid == uid`; the rules refuse anything else) → for an eligible one, shows the agreement (fetched from `/seller-terms` exactly as the intake modal does, scripts stripped) → checkbox → **Acknowledge now** → `updateDoc(applications/{id}, { agreementAccepted: true, agreementVersion, agreementAcceptedAt: <now ISO>, agreementAcknowledgedSurface: 'agreement-acknowledge' })`. The three fields are the ones the intake writes and the c4 approve gate reads; the fourth is provenance for the census. Success is rendered only after the write resolved; a failed write says "NOT saved".
- **One version.** The version is read from `sokoni-merchant-application.js` (`AGREEMENT_VERSION`, the same string `hub-register.js` carries). The module has no version literal of its own and refuses to mount without one — it never acknowledges "something".
- **Never backdates.** `agreementAcceptedAt` is the click moment. The suites assert it is neither the application's `createdAt` nor its `decidedAt`.
- **Never writes for the wrong roles.** Healthcare, advocates and event organizers accept versioned instruments through `legalAccept`; for those the page points and does not write. Rejected/withdrawn applications: nothing offered. Current version already acknowledged: shown as acknowledged.
- **Never touches a decision.** The payload cannot carry status/decision/verification keys (asserted), and the rules would refuse them anyway. `setDoc`/`addDoc` do not appear in the page — it cannot create an application.
- Self-updating page (loads `shared-header.js`), `noindex`, phone layout at 390 px without horizontal overflow.

## 3 · Suite results

| Suite | Proves | Result |
|---|---|---|
| `scripts/test-application-decision-preservation.js` | REAL c4 `applicationDecide` via `CallableFunction.run`: gate refuses before any write (document byte-identical); after the business acknowledges (dated now) the named admin's approval preserves the `"reindex"` decision verbatim, writes the server record, one audit, re-projects the provider, grants the role through the role authority; wallet / KES 50 / stray sellers byte-identical; second decision dedupes; first decision on a pending document preserves nothing | **19 / 0** |
| `scripts/run-rules-suite.js scripts/test-agreement-reacknowledge-rules.js` (emulator, built ruleset) | owner may write the re-ack on own approved and pending applications; cannot write `priorDecisions`, `decidedBy`, `agreementVerifiedAt/Version`, a status change, or frozen classification fields, alone or bundled; strangers and anonymous refused; admin raw `priorDecisions` refused; counterproof with rules disabled | **15 / 0** |
| `scripts/test-agreement-acknowledge.js` | pure payload/eligibility + page wiring (one version, no backdating, no decision keys, `updateDoc` only, own-uid query, shared-header, noindex) | **21 / 0** |
| `scripts/test-agreement-acknowledge-browser.js` | the REAL page in Chromium over the page harness with an I/O seam: lists own applications only; eligible / current / versioned-elsewhere rendering; confirm disabled until ticked; one write with the exact payload dated now; success only after the write; failed write shows failure; signed-out note; 390 px | **14 / 0** |
| Pre-existing: `test-application-decision-authority` 21/0 · `test-merchant-application` 54/0 · `test-business-category-rules` 20/0 · `test-business-capability-rules` 24/0 · `test-admin-os-wiring` 327/0 · `test-business-approval-decision` 40/0 | unchanged behaviour | all green |

## 4 · What is still NOT done, by design

- Kasindi's application is untouched: no acknowledgement, no decision, no classification. The surface is not deployed, so the business cannot yet reach it; deploying hosting requires the latest commit line ([[DEPLOYMENT]] guard) and is a separate authorization.
- The production `applicationDecide` still lacks the agreement gate and the preservation; the deployed trigger still uses the claims-only decider check. The manifest's vehicle remains the c4 handler run locally by the named admin, after the read gate proves the acknowledgement.
- DJ Bvmbxno: `bizAdminApprovalDecide` (e1860a0) stays uninvoked.

## 5 · Next, in the owner's sequence

Kasindi re-acknowledges through the surface (needs the page reachable: hosting deploy from the latest commit, or the owner's alternative) → read gate G2 proves `agreementAccepted === true`, current version, `agreementAcceptedAt` ≥ today → named admin decision via the c4 handler under the manifest gates G1–G6 → projection proof → separate `cleaning` classification manifest → resolver verification. Each step has its own authorization.

Related: [[ADJUDICATION_KASINDI]] · [[APPROVAL_DECISION_AUTHORITY]] · [[R1_CAPABILITY_RULES]]
