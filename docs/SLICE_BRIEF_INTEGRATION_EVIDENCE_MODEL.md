# Slice Brief — Integration Evidence & Capability Model

**Status:** BRIEF ONLY — not started. No schema change, no code, no deploy.
**Baseline:** `20cd1b9` is the presentation contract and must not be weakened.
**Owner decision:** 2026-09-29.

Related: [[SERVED_RULES_RECONCILIATION_2026-09-23]] · `sokoni-integration-catalogue.js` ·
`sokoni-integrations.js` · `functions/integration-status.js`

---

## Purpose

Extend the existing 47-entry Integration Control Center so every integration **and every
capability** can carry evidence-backed configuration, probeability, verification and
environment state.

**The UI consumes this evidence. It does not invent status.**

## 0 · Measured starting point

Not assumptions — measured 2026-09-29 from the shipped catalogue and the census:

| | |
|---|---|
| catalogue entries | **47** |
| by category | infra 17 · identity 7 · messaging 6 · outbound 6 · **payments 5** · ai 2 · compliance 2 · search 2 |
| probeable lifecycles | 43 |
| with an executor | 12 — of which **9 refuse by design** |
| **runnable now** | **3** — `firestore`, `memorystore-redis`, `cloud-storage` |
| no executor at all | **31** |
| quarantined / frozen | 4 |

Rendered state today: **0 ACTIVE · 3 PARTIAL · 4 QUARANTINED · 40 NOT VERIFIED**, summing to 47.

**Payments is IntaSend.** All three live payment entries are IntaSend
(`intasend-collections`, `intasend-webhook`, `intasend-payouts`); `pos-card-terminal` is
quarantined and `sokoni-wallet` frozen. No Daraja, PayPal, Stripe, Flutterwave or Pesapal entry
exists in the catalogue. The model must not reintroduce one.

## 1 · Governing invariants

1. **ACTIVE requires a current successful probe.**
2. **No probe does not mean INACTIVE.**
3. **REFUSED BY DESIGN stays distinct** from failure and from unverified.
4. No status may fall through to a flattering or default state.
5. Catalogue records and their backend status/evidence records **move together**.
6. Capability state comes from **recorded evidence**, never a typed presentation label.
7. The console is **downstream**: schema → evidence/status resolver → console.
8. All 47 catalogue entries remain represented **exactly once**.
9. `20cd1b9` semantics must not be weakened to make the new model look greener.
10. Existing certification gates remain authoritative. When the implementation changes the
    evidence surface, **repair the tests — never retune them to pass.**

## 2 · Integration-level model

```
integration
├── identity
├── category
├── configuration
│   ├── configured
│   └── configuration evidence
├── environment
├── overall evidence/status
├── probeability
├── verification
│   ├── verified
│   └── lastVerified
└── capabilities[]
```

## 3 · Capability model

```
capability
├── id
├── label
├── configured
├── probeable
├── verified
├── lastVerified
└── notRunReason
```

Persisted field **names** may be decided in implementation. The **semantic fields above are
fixed by this brief.**

## 4 · `notRunReason` — this closes a known gap

A capability that cannot be probed must be able to say **why**, rather than collapsing every
reason into NOT VERIFIED.

**REFUSED BY DESIGN must be representable in the status/evidence model itself.** Today it
cannot fire in production: the console derives it from `notRunReason`, which lives on *probe
results* — and a probe that never runs produces no result to carry it. A state that depends on
the output of the thing that did not happen is unreachable by construction.

## 5 · Environment

Environment becomes **data, not presentation**. The supported vocabulary is established during
schema design.

Do **not** display Production / Staging / Development because the labels are conventional. The
catalogue has no environment field today; inventing one in the UI is the failure this brief
exists to prevent.

## 6 · Status resolution

```
current successful probe            → ACTIVE
evidence exists, no current probe   → PARTIAL
explicit authority refusal          → REFUSED BY DESIGN
no sufficient current evidence      → NOT VERIFIED
explicit quarantine                 → QUARANTINED
```

**Derive this from the existing implementation** (`CHIP_META` / `OPS_FROM_EVIDENCE` in
`sokoni-integrations.js`) rather than inventing a parallel taxonomy. There is already an
explicit, exhaustive map with no default branch; extend it, do not replace it.

## 7 · Migration requirement

The 47 catalogue entries and the backend evidence/status records are **one change surface**.

Before changing the schema:

- census the current 47 entries;
- census every existing status/evidence record;
- identify records with no capability/environment data;
- establish migration and default semantics;
- preserve existing PARTIAL, QUARANTINED and NOT VERIFIED meanings;
- explicitly account for REFUSED BY DESIGN;
- prove no entry disappears, duplicates, or silently changes state.

**Do not migrate by assigning arbitrary capability states.**

## 8 · Implementation order — locked

| | |
|---|---|
| **A** | **Census** — current schema → records → resolver → probes |
| **B** | Schema — minimum capability/environment/evidence structures |
| **C** | Evidence writer — probe/configuration operations record the new evidence |
| **D** | Status resolver — derive integration and capability state from that evidence |
| **E** | Migration — move the 47 entries across without fabricating evidence |
| **F** | Certification — prove every transition and negative case |
| **G** | Console — expose it, only after A–F |

### The guard on step A

**Do not begin the schema until the census establishes where the 47 records actually live and
which existing writer owns each evidence field.**

This prevents the classic failure: the UI gets a beautiful new model while an old probe writer
keeps producing the old one, and the console renders a shape nothing fills.

## 9 · Required negative tests

Certification must catch each of these:

| # | the defect |
|---|---|
| 1 | a successful probe incorrectly remaining NOT VERIFIED |
| 2 | a **stale** successful probe becoming ACTIVE |
| 3 | no probe becoming INACTIVE |
| 4 | refusal becoming ACTIVE |
| 5 | refusal silently classified as ERROR |
| 6 | missing `notRunReason` |
| 7 | an unconfigured capability appearing VERIFIED |
| 8 | a configured capability appearing VERIFIED **without evidence** |
| 9 | capability verification incorrectly promoting the whole integration |
| 10 | an integration disappearing during migration |
| 11 | a duplicate catalogue entry |
| 12 | an unknown evidence state falling through to ACTIVE |
| 13 | environment inferred from deployment context instead of recorded data |

Each needs an **inverting control** — a negative-only suite passes against a model that refuses
everything, which would be just as broken.

## 10 · Scope boundary

This slice does **not**: rebuild integrations · create provider credentials · change payment
rails · change wallet authority · change payout authority · change production configuration ·
deploy anything · invent capability names not represented by the actual catalogue · turn the
47-entry catalogue into a fabricated green dashboard.

## Roadmap position

```
A        production sidebar provenance
A2       admin shell ownership
A3       responsive collision
B        premium sidebar / accessibility        (owned elsewhere)
C        existing-page / navigation integration
20cd1b9  truthful Integration Control Center    ← baseline
   ↓
NEXT     Integration Evidence & Capability Model  ← this brief
```
