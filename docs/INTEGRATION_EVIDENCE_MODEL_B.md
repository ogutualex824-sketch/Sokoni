# Step B — Integration Evidence persistence and wiring

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` · **Not deployed.**
Step B of [[SLICE_BRIEF_INTEGRATION_EVIDENCE_MODEL]], following [[INTEGRATION_EVIDENCE_CENSUS_A]].
**Stops before migration (Step E) by instruction.**

---

## 1 · A correction to the Step A census

Step A recorded *"Nothing is persisted. There is no Firestore collection of integration status."*
**That is half right, and the half that is wrong matters.**

`functions/admin-os.js:2284` writes `integrationProbeLatest/{integrationId}` after every probe —
the whole result, spread, with `{ merge: true }`. Repository-wide that collection has **one writer
and zero readers**; the only other mention is a CHANGELOG line. Step A missed it because it
searched for `latestProbes`, the *parameter* name, and the write uses the *collection* name.

So the break was never "no persistence." It was: **the write happens, nothing reads it back, and
nothing validates it.** That is a narrower and more actionable defect.

The legacy collection is **named and left alone**. It cannot be adopted as-is:

- `{ merge: true }` means a field set by one probe survives a later probe that should have cleared
  it. `notRunReason` in particular would stick forever once written — a rail that refused once
  would read as refusing after it started working.
- Nothing validates it, so whatever a future writer puts there would reach an operator unchecked.

Migrating it is Step E's decision, with Step E's evidence.

## 2 · What was built

| file | state | what it is |
|---|---|---|
| `functions/integration-evidence.js` | **new**, 357 lines | schema, validation, the store interface, read/write |
| `functions/integration-probes.js` | +41 | the producer half of the wiring |
| `functions/integration-status.js` | +95 −4 | the consumer half, `notRunReason`, `environment`, `serviceCapabilities` |
| `scripts/test-integration-evidence.js` | **new** | certification — **52 passed, 0 failed** |

### The record

`integrationEvidence/{integrationId}` — a **new** collection, so that adopting it is a deliberate
act and not an accident of an existing unvalidated write. The record *is* the probe result, with
the producer's field names preserved verbatim (`detail`, `support`, `checkedAt`), plus
`schemaVersion`, `environment`, `serviceCapabilities`, `recordedAt`, `recordedBy`. Nothing is
renamed in transit — a rename between producer and consumer is how a field silently becomes
`undefined`.

It is written with `set()`, **not** `set({merge:true})`: the record is written whole or not at all.

### Validation refuses; it never repairs

Shape rules reject a stage given as the string `'unknown'` (truthy — a consumer writing
`if (stages.delivered)` would read it as delivered), a missing stage, an unknown health state, an
`integrationId` not in the registry, a non-ISO timestamp, an undeclared environment.

The **integrity** rules are the ones that make the record mean something. Each describes a record
that is well-formed and false:

| rule | the record it refuses |
|---|---|
| a runtime stage `true` with `evidence: 'none'` | a claim with no source |
| a stage `true` the integration cannot evidence | Algolia reporting a delivery receipt |
| `health: 'connected'` with no runtime stage true | health asserted over nothing |
| `notRunReason` set **and** a runtime stage true | a refusal laundered into an observation |
| a capability `observed` with no evidence | the same defect one level down |

A silently-coerced record is worse than a refused one: the console cannot tell a repaired claim
from an observed one.

## 3 · The three joints, closed

```
integration-probes.js  runProbe()
        │  deps.evidenceStore  ─── OPT-IN. No store, no write, and no claim there was one.
        ▼
integration-evidence.js  writeEvidence() → validate() → REFUSE or persist whole
        ▼
integrationEvidence/{id}
        ▼
integration-status.js  readLatestEvidence()   ← the default that used to be `{}`
        ▼
resolveIntegrationStatus({})  from admin-os.js — UNCHANGED, and now gets real evidence
```

**Persistence is opt-in.** `runProbe` is also called from suites and from the relationship census;
a module that reached Firestore merely because it was required would make those tests depend on a
database and would publish evidence nobody asked to publish.

**The resolver default changed, the resolver contract did not.** An explicitly injected
`latestProbes` still wins — including an explicit `{}`, which means the caller is saying "none".

## 4 · `notRunReason`, and why REFUSED BY DESIGN was unreachable

`sokoni-integrations.js:398` renders REFUSED BY DESIGN from `r.notRunReason`. The resolver copied
`health`, `healthNote`, `stages`, `stageSupport`, `evidence` and `probedAt` from the probe — and
not that field. The state was **dead in production no matter how many probes ran**. Verified
against `HEAD`: the string `notRunReason` does not occur in the previous `integration-status.js`.

It now resolves two ways, and the second is the one that matters:

- **with a probe** — the probe's own reason wins. It is what actually happened.
- **with no probe** — the reason still exists. *"IntaSend refuses because probing would move
  money"* and *"SendGrid's key is not bound to the probe function"* are static properties of
  `REFUSES_BY_DESIGN`, true before anything runs.

A state derived only from the output of the thing that did not happen can never be reached.
Derived from the **declaration**, it is reachable for the nine rails that genuinely refuse — with
`probedAt` still `null`, and `health` still `unknown`, because a refusal is not a health claim.

An integration with **no executor written yet** resolves to `null` — unmeasured, not refused.
Calling that a refusal would claim a deliberate decision the platform has not made.

## 5 · Environment is declared, never inferred

Read from `SOKONI_ENVIRONMENT`, an explicit declaration; `null` when nothing declares it. It is
**not** derived from the project id, from emulator host variables, or from anything else that
merely correlates with an environment. Asserted directly: `declaredEnvironment({ GCLOUD_PROJECT:
'sokoni-aeb26' })` returns `null`.

## 6 · `serviceCapabilities` — a separate field, on purpose

`capabilities` already exists and means **UI affordances** (`view`, `test`,
`view-credential-names`); the console consumes it today. Business capabilities live under
`serviceCapabilities`. Reusing the name would silently redefine a field already in use.

`null` means **NOT MODELLED**. `[]` would mean "modelled, and there are none" — a different fact.
They are not collapsed. **Nothing populates them in Step B**; every record reads `null`.

## 7 · What changed for an operator, today

Nothing, until evidence is written — reading a store nothing has written yet leaves all 47
`unknown`, exactly as before. That property is what makes this safe to land before any migration.

The one visible change is the nine refusals, which the console was already built to render and
which were previously invisible:

```
health:  { unknown: 47 }
reason:  { no_safe_probe: 2, requires_secret_binding: 7, (none): 38 }
```

Nothing claims `connected`, `degraded` or `failed` without a probe behind it.

## 8 · Certification

`scripts/test-integration-evidence.js` — **52 passed, 0 failed**. Every integrity rule is asserted
**twice**: the valid record accepted, and the one differing only in the thing under test refused.
A negative-only suite passes against a store that refuses everything, which is as broken as one
that accepts everything.

Regression, all green and unchanged: probes **85/0** · registry parity **26/0** (47/47) · status
**45/0** · console **86/0**.

Named failure modes proven: an invalid record leaves **nothing** behind; a stored record that
stops validating is **dropped and reported**, never rendered; an unreadable store yields `unknown`
for all 47 plus an error, never a fabricated health, and does not take the credential surface down
with it.

## 9 · Security

No new credential surface. `integrationEvidence` is written by the Admin SDK — which bypasses
security rules entirely — and is never read by a client, so it needs **no** `firestore.rules`
entry: Firestore has no global catch-all, so an unlisted path is default-deny for every client.
Adding a rule would widen access, not protect it. No secret name, value, length or hash enters a
record; `detail` is the provider's own message, truncated, exactly as before.

## 10 · Not done — stops here by instruction

- **No migration.** The 47 are not populated; `serviceCapabilities` is populated by nothing.
- **`functions/admin-os.js` not modified.** It still writes the legacy collection, and its
  `resolveIntegrationStatus({})` call is what now benefits — no change was needed there.
- **AdminOS and Super Admin sidebar files not touched.**
- **No deployment.** Database changes: one new collection, written by nothing yet. API changes:
  three additive response fields (`notRunReason`, `environment`, `serviceCapabilities`) and three
  envelope fields (`evidenceReadable`, `evidenceError`, `evidenceDropped`). Breaking changes: none.
- **UNPROVEN:** the Firestore adapter against a real database. No Firestore was contacted; the
  store is in-memory throughout. What is certified is the schema, the validation and the wiring.
