# Feature Proposal Template — SOKONI v2.0

**Status:** REQUIRED — every feature proposal must complete this form before any code is written.

---

## How to use this template

Copy the template below. Fill every section. Proposals with empty or vague sections will be rejected.

Do not submit a proposal for:
- A feature another platform has (that is not evidence)
- A feature you personally want (that is not evidence)
- A feature that is technically interesting (that is not a business case)

A proposal is accepted only when it answers: "What specific user pain does this solve, and how will we know when we have solved it?"

---

## Proposal Template

```
# Feature Proposal: [Feature Name]

**Proposed by:** [Name]
**Date:** [YYYY-MM-DD]
**Sprint target:** [v1.x / v2.x / backlog]
**Status:** [ ] Draft   [ ] Under review   [ ] Accepted   [ ] Rejected

---

## 1. User Problem

What specific problem does this solve?
Who experiences it?
How do we know they experience it? (quote a feedback submission, show a metric, show a search term)

Evidence source:
[ ] /admin-feedback submission (paste the message or ticket ID)
[ ] getSearchInsights — zero-result term or top query
[ ] getMarketplaceQualityReport finding
[ ] getFunnelMetrics drop-off
[ ] Seller feedback (paste source)
[ ] Other: ___________

**Without real evidence, this proposal cannot proceed.**

---

## 2. Target Users

Primary users affected by this feature:
[ ] Buyers (all)
[ ] Buyers (specific segment: ____________)
[ ] Sellers (all)
[ ] Sellers (specific segment: ____________)
[ ] Admins
[ ] Drivers
[ ] Other: ___________

Estimated affected users: ___________

---

## 3. Proposed Solution

Describe the feature in 2–4 sentences.
Include what the user sees, does, and gets.
Do NOT describe technical implementation here.

---

## 4. Expected Business Impact

| Metric | Current baseline | Expected change | Timeframe |
|--------|-----------------|----------------|-----------|
| [e.g. Cart → Paid rate] | [e.g. 28%] | [e.g. +8pp] | [e.g. 30 days] |

If you cannot fill this table with real current baseline numbers from the platform,
the proposal is not ready.

---

## 5. Estimated Development Effort

Frontend:  _____ hours / days
Backend:   _____ hours / days
Testing:   _____ hours / days
**Total:   _____ days**

Confidence in estimate: [ ] High   [ ] Medium   [ ] Low

---

## 6. Infrastructure Cost

New Firestore reads per day (estimated): ___________
New Cloud Function invocations per day (estimated): ___________
New indexes required: ___________    (current budget: 192/200)
Additional storage: ___________
External service cost (if any): ___________

If this feature would push Firestore indexes above 195/200, it must include a plan to
remove unused indexes first.

---

## 7. Success Metrics

How will we know this feature worked?

| Metric | Measurement method | Target | Timeframe |
|--------|-------------------|--------|-----------|
| [Primary metric] | [CF / collection / report] | [Value] | [Days] |
| [Secondary metric] | … | … | … |

We will review these metrics at: ___________

---

## 8. Rollback Plan

If this feature degrades the platform, how do we remove it safely?

[ ] Feature can be removed by deleting one HTML element (no data migration needed)
[ ] Feature requires a Firestore migration to roll back
[ ] Feature changes a shared service — rollback affects other pages

Rollback steps:
1. ___________
2. ___________
3. ___________

Time to rollback: ___________ minutes

---

## 9. Alternatives Considered

What did you consider instead of this approach?
Why was this solution chosen over the alternatives?

---

## 10. Dependencies

[ ] No external dependencies
[ ] Requires another feature to ship first: ___________
[ ] Requires a third-party integration: ___________
[ ] Requires a new secret / credential: ___________
[ ] Requires legal / compliance review: ___________

---

## Review Checklist (for approver)

[ ] Evidence of user problem is cited and verifiable
[ ] Business impact has a real current baseline
[ ] Infrastructure cost is within budget
[ ] Index budget impact assessed
[ ] Success metrics are measurable and have a review date
[ ] Rollback plan is realistic
[ ] No architectural changes required at current scale
[ ] Does not duplicate an existing feature

**Decision:** [ ] Accepted   [ ] Rejected   [ ] Needs more evidence

**Decision by:** ___________   **Date:** ___________

**Rejection reason (if rejected):**
```

---

## Accepted Proposals Archive

| Feature | Proposed | Accepted | Sprint | Status |
|---------|----------|----------|--------|--------|
| _(none yet — this template is new as of v2.0)_ | | | | |

---

## Rejected Proposals Archive

| Feature | Rejected | Reason |
|---------|----------|--------|
| _(none yet)_ | | |

---

*This governance process was introduced in SOKONI v2.0 to ensure every engineering hour is invested in validated user value.*
