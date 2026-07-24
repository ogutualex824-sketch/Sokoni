# Release sequence — callable surface & runtime certification

Companion to `CALLABLE_INVOKER_GAPS.md` (what is unreachable) and
`CALLABLE_INVOKER_REVIEW.md` (who is supposed to call it).

## Why there is a pre-flight AND a post-flight

The callable surface can change from outside the release process. During the
2026-07-24 hardening pass, two `run.invoker` bindings were granted between one sweep
and the next; the sweep total moved 348 → 346 and a written status line was stale
within a few turns. Only re-running caught it.

A point-in-time verdict cannot show that. A **baseline plus a diff** can — so the
audit snapshots itself before the release and compares afterwards.

```bash
npm run release:preflight     # baseline -> .release-preflight.json
#   … deploys, IAM changes, runtime certification …
npm run release:postflight    # diff vs baseline; exits 1 on any PASS -> FAIL
```

`release:postflight` fails **only on a regression** (a function that was reachable
and no longer is). Functions that were fixed during the window are reported, not
failed — that is the expected direction of travel.

## Sequence

### Pre-flight
1. `npm run release:preflight` — establishes the operational baseline **before**
   anything else runs, so later failures can be attributed.
2. Environment verification.
3. Secret verification.

### Runtime certification
4. RC-01 Merchant onboarding.
5. RC-04 Inventory.
6. RC-07 GDPR export — see below.
7. Payment callback / webhook replay.

### Post-flight
8. `npm run release:postflight` — diff against the baseline.
9. Regression summary.
10. Cleanup verification.

## RC-07 — GDPR export, end to end

Infrastructure is done and evidenced: the source binding was corrected and
deployed, and the two `run.invoker` bindings are applied (both probe 401, audit
PASS). What remains is **runtime behaviour**, which requires a real authenticated
session and cannot be produced headlessly.

Confirm each step, not just the endpoints:

1. An authenticated user submits an export request.
2. A `dataExportQueue/{requestId}` document is created.
3. `processDataExport` executes (it triggers on `document.created` for that path).
4. The artifact is generated and written to Storage —
   `data-exports/{uid}/{requestId}.json`.
5. Status transitions through its lifecycle (queued → processing → ready).
6. The user can retrieve, or is notified about, the completed export.

Step 2 is the one that was previously broken and is the highest-value assertion: the
deployed `requestDataExport` used to write only `dataExportRequests`, never the queue
document, so the worker never fired.

## What a green audit does and does not mean

`audit-callable-invokers.js` detects exactly one failure mode — a Cloud Run service
missing `roles/run.invoker`. A clean run means:

> No endpoint in the audited set exhibits this specific IAM misconfiguration.

It does **not** mean the callable surface is correctly configured. It says nothing
about in-function authorization, App Check, Firestore Rules, or business logic.
Those need their own evidence; this gate must not stand in for them.
