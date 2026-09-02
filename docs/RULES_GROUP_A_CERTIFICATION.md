# Rules consolidation — Group A certification

**Date:** 2026-09-02
**Transformation:** served `59af870d` → `firestore.rules.candidate-a`
**Status:** **ACCEPTED against the eight-condition gate. NOT released.**

Related: [[ADR-014-server-backed-stories]] · `docs/RULES_CONSOLIDATION_CANDIDATES.md` ·
`docs/RULES_RECONCILIATION_59af870d.md`

---

## What changed

21 `match` blocks in which **every** rule was the literal `false` and which contained no
nested `match`. Such a block grants nothing, and an absent `allow` already denies, so
removing it cannot change any request's outcome.

| | source | compiled | free |
|---|---|---|---|
| served `59af870d` | 252,640 ch | 255,551 B | 449 |
| **candidate-a** | 250,242 ch (−2,398) | **253,623 B** (−1,928) | **2,377** |

Blocks removed: `_counters`, `receipts`, `sasosPaymentRefs`, `productViewDedup`,
`walletPinAttempts`, `qrTokens`, `securityStepUp`, `challenges`, `_health`,
`eventOrderIdempotency`, `healthApptIdempotency`, `digitalPurchaseIdempotency`,
`legalConsultIdempotency`, `versions`, `legalAcceptances`, `legalCertificates`,
`legalAuditLog`, `legalConfig`, `legalRegistry`, `entertainmentPurchaseIdempotency`,
`_chaosCanary`.

## The gate

| # | condition | result |
|---|---|---|
| 1 | 20,940-case served ↔ candidate | **0 divergences**, 4,581 ALLOW both sides |
| 2 | served ↔ served control, same scale | **0 divergences**, 4,581 ALLOW both sides |
| 3 | sabotage control detects widening | **8 divergences**, all DENY→ALLOW |
| 4 | shopEmployees anchor | **byte-identical**; `shopOwnerId` count unchanged |
| 5 | granting-rule count | **1,319 → 1,319** |
| 6 | excluded scopes | **10/10 identical occurrence counts** |
| 7 | candidate releases | **yes** — 253,623 B under the 256,000 ceiling |
| 8 | production `cloud.firestore` | `59af870d`, `updateTime` 2026-08-28T14:49:34.255213Z, **unchanged** |

## Why each piece of evidence is worth something

**The corpus can allow.** 4,581 of 20,940 cases (21.9%) genuinely resolve to ALLOW.
A corpus that denied everything would compare identically across any two rulesets —
including one with a granting rule deleted — so an all-DENY corpus proves nothing. The
harness refuses to certify when zero cases allow.

**The comparison can fail.** Weakening one `allow read: if isAdmin();` to `if true`
produced 8 DENY→ALLOW divergences. A comparison that cannot fail is not evidence.

**The harness is deterministic at scale.** Four full 20,940-case evaluations were run
(served twice, candidate once, served-as-candidate once) and every one returned exactly
4,581 ALLOW. A transient API error is recorded as DENY, so instability would have shown
as spurious divergence; none appeared.

**Conditions 4–6 and 8 were re-derived independently.** `build-rules-candidate.js` asserts
its own postconditions, but a script that both transforms and certifies can share a wrong
assumption with itself. `verify-candidate-gate.js` re-derives them from the two files with
no knowledge of how the candidate was produced, and reads the production release from the
API rather than from earlier output. 9/0.

**The candidate is a strict subset of served lines, in order.** Nothing was added,
rewritten or reordered — only whole blocks removed. This closes the failure mode where a
transformation "preserves" behaviour by quietly rewriting a condition into an
equivalent-looking form that the corpus happens not to distinguish.

## What this does NOT establish

- **Not released.** Publication is a separate decision and remains blocked pending
  `docs/RULES_RECONCILIATION_59af870d.md`.
- **Equivalence is over the corpus, not over all inputs.** 20,940 cases across 698 scopes
  with six personas and five methods is broad, but it is sampling, not proof. It cannot
  see conditions that depend on document data the corpus does not construct — `get()`
  lookups into other collections, in particular, resolve against no data here.
- **Group A only.** The 307 constant-false rules that sit *inside* blocks which also grant
  are untouched. Removing those is the same `A OR false === A` claim, but each needs its
  own run.

## The pricing lesson

| lever | source removed | compiled freed | B per char |
|---|---|---|---|
| every comment + indent in the file | 99,277 ch | 128 B | 0.0013 |
| **21 dead blocks** | **2,398 ch** | **1,928 B** | **0.80** |

**Structural removal is ~615× more efficient per character.** Deleting 21 dead blocks freed
**15×** what stripping every comment in the ruleset would. There is no budget argument for
destroying the documentation.
