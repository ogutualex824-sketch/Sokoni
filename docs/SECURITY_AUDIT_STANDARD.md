# SOKONI — Security Audit Standard

**Status:** PERMANENT · ratified 2026-07-17
**Applies to:** every security review, static analysis sweep, and architectural audit.

> **Never report a speculative vulnerability. Evidence takes precedence over assumptions.**

A wrong finding is worse than no finding: it burns reviewer time and erodes trust in every future
report. This standard exists because three audits run in a single session produced **9 false
positives**, all caught and removed before reporting.

---

## The audit sequence

1. **Detect candidates** — static scan, deliberately over-inclusive.
2. **Eliminate scanner limitations** — fix the detector's own blind spots and **re-run**.
3. **Manually verify execution paths** — read the actual code for every surviving candidate.
4. **Confirm authorization boundaries.**
5. **Confirm tenant isolation.**
6. **Confirm privilege enforcement.**
7. **Report only confirmed issues** — always state raw → verified → confirmed counts, and list
   what was excluded and why.

## Review order for security work

authentication → authorization → tenant isolation → transaction integrity → audit logging →
rate limiting → idempotency → data validation → error handling → manual verification

## Known false-positive classes

Check for each of these before reporting. Every one has produced a real false positive here.

| Class | Example | Rule |
|---|---|---|
| **Mutually exclusive branches** | `b2b-wholesale.js` — a read in `else if (credit_note)` after writes in `if (wallet)` | A position-based scan cannot see control flow. Verify the execution path |
| **Unrecognised guards** | `commission.js` — 14 handlers gated by `_assertAdmin`, absent from the keyword list | Authorization has many shapes: role ladders, admin asserts, membership queries, ownership comparisons, dispatcher wrappers |
| **Self-service scope** | `walletV2Send` — spender derived from `_requireAuth` | When the subject comes from `auth.uid`, the uid **is** the authorization |
| **Documentation & fixtures** | `partner-portal.html` `<pre>` sample; `unknownFunction_xyz` negative test | Documentation, examples, test fixtures and negative tests are never production defects |
| **Deployment vs implementation** | `wfInviteEmployee` — in source and exported, absent from the live project | A missing *deployment* (quota) is not a missing *implementation* |

## Async guard validation

Mandatory in every security review. A **non-awaited async guard passes silently**, which has
previously shipped as a real authentication bypass in this codebase.

For each authorization helper, determine:
- Is it **synchronous** and does it `throw` directly? → calling it without `await` is correct.
- Is it **async**? → every call site must `await` it, or the guard is a no-op.

Also check: silent promise rejection, and `catch` blocks that swallow an authorization failure.

## Reporting format

State the funnel explicitly — it is evidence of rigour:

```
19 raw candidates -> 5 after correcting the scanner -> 0 confirmed
```

For each confirmed finding: location, root cause, business impact, proposed fix, regression risk,
and a test plan that **reproduces the failure before the fix**. For each excluded candidate: why.

## Worked examples

- `docs/AUTHORIZATION_REVIEW.md` — 19 → 5 → **0**; two scanner corrections
- `docs/TRANSACTION_INTEGRITY_AUDIT.md` — 3 → **2 confirmed**, 1 false positive
- `docs/PHANTOM_CF_AUDIT.md` — 3 categories; 3 false positives removed; separates deployment
  blockage from code defects

Related standards: `FINANCIAL_TRANSACTION_STANDARD.md` (invariant 10 / F7),
`RELEASE_VALIDATION_STANDARD.md`, `PLATFORM_CONSTITUTION.md`.
