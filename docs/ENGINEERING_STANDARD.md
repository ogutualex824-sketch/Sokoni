# SOKONI Engineering Standard — Evidence-Driven Investigation & Change

**Status:** Permanent. Applies to every production investigation and change —
payments, search, inventory, authentication, subscriptions, and future modules.
**Origin:** distilled from the methodology this project converged on in practice
(see `feedback_audit_methodology`, the ADRs, the writer maps, and the payment
webhook and subscription verification reports).

This is a *process*, not a checklist to skip. Its purpose is that any fix is
supported by production evidence and cannot silently introduce a new source of
truth or be declared done before the customer outcome is real.

---

## 1. Mission

State the exact production problem and the success criterion in concrete,
observable terms. Not "fix subscriptions" — "a completed payment must produce a
visible Starter entitlement." Success is a **customer-visible outcome**, never a
code state.

## 2. Established facts

List only evidence-backed facts, each with its source (a production read, a
runtime log, a git object). Treat these as axioms for the investigation **unless
new evidence disproves them** — in which case discard immediately.

## 3. Unknowns

Separate explicitly what is NOT yet known. Constrain the investigation to
resolving these. Do not investigate outside them until they are eliminated.
**"Unknown" is an acceptable, honest outcome.**

### Stop rule

**When every remaining question has exactly one external observation that can
resolve it, stop analyzing and wait for that observation.** More static analysis
past this point produces motion, not evidence, and risks manufacturing a
conclusion the runtime has not yet supplied. A question is *evidence-gated* (waits
for a runtime observation — a replay, a device check, a production read) or
*analysis-gated* (more reading/tracing can still advance it). Keep analyzing only
what is analysis-gated; hand off or wait on everything evidence-gated, each with a
named owner and a single next observation.

## 4. Architecture map

Before proposing any change, enumerate **every writer and every reader** of the
data in question, and name the single authoritative source. One trace is a
hypothesis; the full set is a finding. (The subscription "paid → Free" symptom
was a *reader* question whose cause was a *writer* — the webhook — three stages
upstream. The map is what makes that visible.)

## 5. Investigation protocol

1. **Instrument first, or use existing instrumentation.** Prefer reading logs the
   system already emits over adding new code — especially in code owned by another
   workstream. Never log secrets.
2. **Find the first divergence.** Locate the first place reality differs from
   expected, and stop there. Everything downstream is a symptom until the first
   divergence is fixed. Do not patch symptoms.
3. **One hypothesis at a time, each falsifiable.** Every hypothesis states the
   evidence for it, the evidence against it, and *how to falsify it*. No hypothesis
   without a falsification step.
4. **Change one variable.** Never modify multiple variables simultaneously.
5. **Fact vs inference.** State ownership, root cause, and mechanism as fact only
   when evidence establishes them. A field's *presence* is not proof of its
   *semantics*; a filename is not proof of ownership; a passing gate is not proof
   of a live fix. When it is inference, say so.

## 6. Implementation rules

- **Never introduce a second source of truth.** Prefer shared business rules and
  one authoritative document/module. Removing a competing source beats adding
  another. (This is why the product-field schema, the commission config, and the
  subscription catalogue are each singular and guarded.)
- **Respect ownership.** Another process writes this repo. Before changing a
  canonical path, check `git log`; if the area is actively owned by another
  workstream, validate and hand off evidence rather than patching in parallel.
- **Security routines fail closed.** A rejecting auth check is doing its job. Fix
  it by authenticating *correctly*, never by authenticating *less*.
- **No forbidden shortcuts:** no speculative retries/fallbacks, no error
  suppression, no "probably"/"likely" in a conclusion, no patching a reader to
  hide a writer bug, no closing an issue because a deploy succeeded.

## 7. Verification standard — five stages, all required

An issue is resolved only after ALL five are verified, in order:

```
Committed          the intended change exists           (git)
   ↓
Deployed           it reached production                 FIREBASE_REAL_EXIT=0
   ↓
Parity             production runs the expected artifact verify-artifact-parity → IDENTICAL,
                                                         consistent across requests
   ↓
Runtime            the EXACT production path produces    the real query / endpoint / payment,
                   the intended behaviour                not a proxy
   ↓
Customer outcome   the user-visible result is real       observed on device / in the UI
```

Never collapse a later stage into an earlier one. "Committed ≠ Deployed ≠ Parity
≠ Runtime ≠ Customer outcome." Verifying against a proxy (a simpler query, a
stubbed harness, an exit code read through a pipe) is not verifying the path.

## 8. Completion report

An investigation closes with:

- **Root cause** — one sentence, evidence-cited.
- **Evidence** — timeline + table (step / expected / observed / evidence).
- **Fix** — one sentence.
- **Runtime proof** — the one production observation that demonstrates the fix
  through all five verification stages. Absent this, the issue is NOT closed.
- **Regression risk** — what the change could break, and how it was checked.
- **Follow-up items** — with owners.

---

## Worked references in this repo

- `docs/PAYMENT_WEBHOOK_INVALID_SIGNATURE.md` — first-divergence at webhook auth;
  root cause from the captured request; handed off, not patched.
- `docs/SUBSCRIPTION_ACTIVATION_VERIFICATION.md` — "not observed" vs "does not
  work"; precondition never met.
- `docs/SUBSCRIPTION-WRITERS.md` — writer map; `docs/ADR.md` ADR-0012/0013.
- `feedback_audit_methodology` (memory) — the individual rules, with the failures
  that produced each.
