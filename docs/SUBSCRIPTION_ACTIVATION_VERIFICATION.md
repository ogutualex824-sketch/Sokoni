# Subscription Activation Verification — July 2026

**Type:** Verification report (not an audit, not a bug report)
**Date:** 2026-07-23
**Method:** Read-only production trace over the Firestore REST API. No code changed.
**Result:** **Activation subsystem not found at fault.** Current production data
contains no completed subscription payment eligible for activation. The existing
entitlement state is consistent with the recorded payment state.

---

## Why this was run

The reported symptom was "a merchant paid for Starter but the subscription page
shows Free." Rather than change the activation code — which is under active
development by the payments workstream (`5fdcc51` entitlement backstop, `fc17548`
webhook auto-activation, `fdd8af3` real-time entitlement engine, all deployed
2026-07-21) — this verifies whether the symptom is reproducible against the
current production deployment, and if so, where the observed behaviour diverges.

Ownership note: activation is **not** this verifier's workstream. The report is
objective validation for the subsystem owner, produced without touching their
implementation.

## The five questions

| Question | Result | Evidence |
|---|---|---|
| Was payment confirmed? | **No** | `payments`: 2 documents, both `PENDING`. Zero `COMPLETE`. |
| Did webhook activation run? | **N/A** | `intasendWebhook` activates only on a `COMPLETE` payment; none exists to trigger it. |
| Was entitlement updated? | **No paid entitlement** | `subscriptions`: 1 document — `SOK-GL58F7`, `plan=trial`, `status=trialing` (auto-activated, never purchased). |
| Did the UI reflect entitlement? | **Correctly shows trial/Free** | No paid subscription exists to render; Free is the correct output for this data. |
| Is "paid → Free" reproducible? | **No** | No `COMPLETE` payment exists, so nothing was ever eligible for activation. |

## Evidence detail

```
payments                        2 docs   — all PENDING
paymentIntents                  1 doc    — purpose: subscription, not COMPLETE
subscriptions                   1 doc    — SOK-GL58F7 trial/trialing (auto-activated)
entitlements                    0 docs
billingReconciliation          ≥20 docs  — reconciler is running
subscriptionReconciliationRuns ≥20 docs  — reconciler is running
```

The entitlement backstop / reconciler is operating (reconciliation runs are
recorded). It has nothing to activate because no payment completed — correct,
safe behaviour, not a failure.

## Conclusion

**The "paid → Free" activation bug is not reproducible under the current
implementation.** Its precondition — a completed subscription payment — does not
exist in production. The activation subsystem was verified against production and
the investigation ended because its preconditions were never met.

## The question this reframes (different owner, not pursued here)

The real gap is upstream of activation: **why does a subscription payment never
reach `COMPLETE`?** — STK push initiated but not confirmed, or the confirmation
webhook not landing. That belongs to the payment-confirmation pipeline
(`dbb09af` M-Pesa C2B confirmation, `9d72055` collection route), actively owned
by the payments workstream. It is recorded here as a handoff, not acted on.

The lifecycle to trace, should someone pursue it:

```
initiate subscription payment → STK push → customer authorizes →
gateway confirms → webhook received → payment status COMPLETE → activation
```

Based on this verification the break is **before** the activation stage: the
activation stage never receives a completed payment to process.

## Related

- `docs/SUBSCRIPTION-WRITERS.md` — writer map (point-in-time; superseded in part
  by the 2026-07-21 payments work; confirm against code before trusting).
- `docs/ADR.md` ADR-0013 — canonical activation writer (same staleness caveat).
- Methodology: verify against the exact production path, not a proxy
  (`feedback_audit_methodology`).

---

# Addendum — Trial Lifecycle Observation (Read-only)

**Date:** 2026-07-23
**Type:** Read-only observation appended to the verification above. Recorded
separately to preserve the original conclusions; no implementation changes
recommended.

## Observation

The production subscription record currently reflects the legacy trial model:

- Trial duration: **14 days**
- Activation: **automation** (`activatedBy: automation`, `autoActivated: true`)
- Current status: **still within the trial period** (started 2026-07-20,
  `trialEndsAt` 2026-08-03; today is inside the window, so expiry logic has not
  yet had cause to fire)

The current implementation, however, defines new trial durations of:

- Seller Basic: **3 days**
- Seller Pro: **3 days**
- Enterprise: **30 days**

(`functions/sub-billing.js`, `trial:{days:…}`)

## Result

No production evidence was found during this verification that the new 3-day
trial creation path has yet created a subscription. The sole trial on record is
14 days and automation-created, matching none of the new values (3 / 3 / 30).

Therefore the following lifecycle has not yet been exercised in production:

```
Trial Creation → 3-Day Trial → Trial Expiry → Feature Restriction → Upgrade Prompt
```

## Relationship to the earlier verification

This mirrors the earlier payment finding.

| Lifecycle | Deployment status | Production evidence |
|---|---|---|
| Payment → Activation | Deployed | No completed payment observed |
| 3-Day Trial → Expiry | Deployed | No production trial created under the new model observed |

## Conclusion

No defect is identified by this observation. The finding is simply that these
production lifecycles have not yet been exercised. "Not observed yet" is distinct
from "does not work."

Confirmation requires an end-to-end acceptance test using:

- a newly created 3-day trial,
- natural or simulated expiry,
- a real completed subscription payment.

No implementation changes are recommended based on this observation. The
subscription/trial and payment-confirmation code is actively owned by the
payments workstream.
