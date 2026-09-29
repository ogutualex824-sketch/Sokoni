# Step E — the source-of-truth decision, before migration

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` · **Decision memo. No code, no
migration, no deploy.** Ratified 2026-09-29 — see §7; **D3 remains OPEN**. Adapter proof **held** by instruction.

Follows [[INTEGRATION_EVIDENCE_CENSUS_A]] (`b9172ba`) and
[[INTEGRATION_EVIDENCE_MODEL_B]] (`5e8ec59`).

> **The question:** should production refusal state be derived from the executor definition, from
> persisted evidence, or from both?
>
> **The short answer: both — layered, never merged, and never blended into one field.** But the
> reason is not "both is safer". It is that the nine refusals are not one kind of fact. Two of them
> are design decisions and seven of them are deployment claims, and those want opposite authorities.

---

## 1 · The nine are two different kinds of fact

Measured from `REFUSES_BY_DESIGN` and the registry:

| code | n | what it asserts | can it change without a code edit? |
|---|---|---|---|
| `no_safe_probe` | **2** | probing would **move money** | **no** — a design decision |
| `requires_secret_binding` | **7** | the probe function **does not hold** that provider's secret | **yes** — bind the secret and it is false |

```
no_safe_probe            intasend-collections · intasend-payouts
requires_secret_binding  sendgrid · africastalking · algolia · typesense
                         anthropic · etims · smtp-fallback
```

**`no_safe_probe` is a property of the platform.** IntaSend exposes no read-only health endpoint, so
probing a collection or a payout would create a charge. That is true in every environment, at every
moment, regardless of what any database holds. Persisted evidence can never be more current than
this, and a stored record saying a probe *did* run against it would be alarming rather than
informative.

→ **The declaration is authoritative. Nothing should be able to override it.**

**`requires_secret_binding` is a property of a deployment.** It is a claim about which secrets are
bound to the probe function — and that is environment-specific and mutable. It could be true in
production and false in staging. It stops being true the moment someone binds the secret.

→ **The declaration is a *prediction*. Only evidence can confirm it.**

### The defect this exposes, today

`needsBinding()` at [functions/integration-probe-executors.js:49](functions/integration-probe-executors.js#L49)
raises that code **unconditionally**:

```js
function needsBinding (secrets) {
  const e = new Error('This probe requires ' + secrets.join(', ') +
                      ' to be bound to the probe function; deployment is frozen.');
  e.code = 'requires_secret_binding';
  return e;
}
```

It does not check whether the secret is bound. It is a **hardcoded assertion about deployment
state**, and it can only ever be wrong in one direction: it will keep claiming the secret is
unbound after someone binds it, and **nothing in the platform would detect that**. The message even
names the reason — *"deployment is frozen"* — which is a statement about a moment in time, frozen
into a constant.

This is the same class of defect as the legacy `{ merge: true }`, one level up: a fact captured once
and thereafter asserted forever. Recognising it is what makes the decision below necessary rather
than merely tidy.

## 2 · The "38 without a reason" is really five groups

Treating them as one bucket is what would make a migration go wrong. Measured:

| group | n | what it is | can evidence ever exist? |
|---|---|---|---|
| **runnable** | **3** | `firestore` · `memorystore-redis` · `cloud-storage` — service-account rails, probes actually run | **yes, now** |
| **inbound / declared, no executor** | **4** | `intasend-webhook` · `fcm` · `pos-webhooks` · `inventory-webhooks` — declare stages in `SUPPORT`, have no outbound probe | **only from a correlated callback** |
| **measurable, nothing written** | **15** | genuine gaps — a probe could exist and none has been written | not until one is written |
| **not-applicable** | **5** | health is not a meaningful concept | **no, and that is correct** |
| **observed-elsewhere** | **11** | a real signal exists, authoritatively outside this console | **not here** |

Total 38, plus the 9 refusals = 47. ✓

The **4 inbound** are the group the current model handles worst. `intasend-webhook` has no executor
because there is nothing to call — its evidence is a correlated inbound POST arriving through
`recordProbeEvent()`. For these, **a declaration can never produce evidence and persistence is the
only possible source.** They are the mirror image of `no_safe_probe`.

So across the 47 there are three distinct authority regimes, not one:

```
declaration ONLY      2   no_safe_probe — persisted evidence must not override
persistence ONLY      4   inbound rails — a declaration cannot observe a callback
BOTH, and they can    7   requires_secret_binding — declaration predicts,
   disagree               evidence confirms or refutes
```

## 3 · The recommendation

**Keep two fields. Never collapse them.**

| field | tense | source | meaning |
|---|---|---|---|
| `notRunReason` | **present** | the executor declaration | *why a probe will not run if you press the button now* |
| `lastNotRunReason` + `probedAt` | **past** | persisted evidence | *what happened the last time one was attempted* |

`5e8ec59` already implements the first correctly: it derives `notRunReason` from the declaration
when no probe exists, and lets a probe's own reason win when one does. **The change Step E should
make is to stop letting the probe's reason win, and give it its own field instead.**

Rationale: a persisted reason is a *historical* fact carrying a timestamp. A declared reason is a
*present-tense* fact carrying none. Rendering them through one field means the console sometimes
shows you what is true now and sometimes what was true in March, with nothing on screen to say
which. That is the failure mode the evidence vocabulary exists to prevent — `stale` is one of the
six words precisely because it must never be collapsed into the others.

### The prize: disagreement is itself a signal

With both fields kept apart, a comparison becomes possible that **neither source can produce
alone**:

| declaration | last evidence | what it means |
|---|---|---|
| `requires_secret_binding` | a probe **ran and succeeded** | **the declaration is stale** — the secret got bound and `REFUSES_BY_DESIGN` was never updated |
| `runnable` | `requires_secret_binding` | **a binding regressed** — the code expects to run and the deployment refuses |
| `no_safe_probe` | any probe result at all | **a probe ran against a money rail** — investigate immediately |

The third row is worth the whole exercise. It is a tripwire on the rails where a mistake costs
money, and it exists only because the two sources are kept separate and compared.

## 4 · What this means for migration — it shrinks

**The nine refusals need no migration at all.** Their reason is derived live from the declaration,
which `5e8ec59` already does correctly, and which is by construction never stale. Writing them into
persisted evidence would create a second copy of a fact that is already authoritative in source —
and a copy that goes stale the moment the declaration changes.

> **Migration should carry observations only.** A refusal is not an observation.

That leaves migration with a much smaller and better-defined job:

- **3 runnable** — the only rails where a fresh probe produces real evidence today.
- **4 inbound** — nothing to migrate; their evidence arrives by callback, and the correlation path
  through `recordProbeEvent()` is a separate lane with its own proof owed.
- **15 measurable, unwritten** — nothing to migrate. They stay `unknown`, honestly.
- **5 not-applicable + 11 observed-elsewhere** — must **not** be given evidence records. Writing one
  would imply health is measurable here when the catalogue says it is not.

So the migration is: **3 entries, not 47.** Anything larger is populating a model rather than
recording what was observed.

## 5 · `integrationProbeLatest` — history that must not be rewritten

Its current contents are **UNREADABLE from here**: reading production Firestore was not attempted
and is not authorized in this lane. Nothing in this memo assumes what it holds.

What is known from source alone:

- it is written by `admin-os.js:2284` with `{ merge: true }`, so any `notRunReason` ever written to
  a document **is still there**, regardless of what later probes found;
- it has **zero readers**, so nothing has ever depended on its contents;
- it carries no `schemaVersion`, so a legacy document cannot be mistaken for an evidence record —
  `validate()` refuses it on that field alone.

**Recommendation: leave it entirely alone. Do not migrate it, do not delete it, do not read it into
the new model.** It is a write-only log of probe attempts whose refusal fields are unreliable by
construction. If its history turns out to be wanted later, it can be read *as history* — timestamped
attempts — which is a different and safe use.

## 6 · The decision, stated for you to accept or change

1. **`no_safe_probe` — declaration only.** Persisted evidence must never override it.
2. **`requires_secret_binding` — declaration for the present-tense field, evidence for the
   past-tense field, and surface the disagreement.**
3. **The 4 inbound rails — persistence only.** A declaration cannot observe a callback.
4. **Split `notRunReason` into present-tense (declared) and past-tense (observed).** Do not let a
   probe's reason overwrite the declaration, as it does today in `5e8ec59`.
5. **Migrate observations only — 3 entries, not 47.** Refusals are derived, never stored.
6. **`integrationProbeLatest` is not migrated, not read, not deleted.**
7. **Fix or re-specify `needsBinding()`** — it asserts a deployment fact as a constant and can only
   be wrong in one direction. Either it checks, or the field it feeds is labelled as a declaration
   rather than an observation. This is a **separate defect**, found here, and it should not be
   quietly bundled into the migration.

## 7 · Owner ratification — 2026-09-29

Recorded after the fact, not folded back into §6: §6 is what was proposed, this is what was decided.

| # | status | note |
|---|---|---|
| D1 | **accepted** | a probe executed against such a rail is *"a tripwire/violation"*, not a health signal |
| D2 | **accepted** | |
| D3 | **OPEN** | the only decision not addressed; the 4 inbound rails remain proposed, not ratified |
| D4 | **accepted** | it stops the resolver answering *"is it refusing now, or did it refuse last time?"* with one field |
| D5 | **accepted, conditional** | the exact three confirmed below |
| D6 | **accepted** | *"untouched until its role is deliberately adjudicated"* |
| D7 | **accepted** | keep as its own lane — fixing it inside migration would mix the evidence model, executor semantics and secret-binding behaviour |

**The three, named.** `firestore` · `memorystore-redis` · `cloud-storage` — the only entries where
`probeAvailability()` returns `runnable`; all three service-account rails, all `healthKind:
measurable`.

### The ratified disagreement matrix

Supersedes the three-row table in §3. **Total, not exception-only** — the expected and verified rows
are the positive controls that stop the matrix passing against a resolver which flags everything.

| declaration | observation | meaning |
|---|---|---|
| `no_safe_probe` | none | **expected refusal** |
| `no_safe_probe` | a probe occurred | **TRIPWIRE** — a probe ran against a money rail |
| `requires_secret_binding` | no successful binding | **expected / unverified** |
| `requires_secret_binding` | a successful probe | **stale declaration** |
| `runnable` | `requires_secret_binding` observed | **binding regression** |
| `runnable` | a successful probe | **verified evidence** |

> **The Step E invariant:** the resolver must be able to **expose disagreement**, not merely choose a
> side. Collapsing these six into one ACTIVE / PARTIAL / NOT VERIFIED chip destroys the only
> information the two-source model exists to produce.

**Migration remains HELD.** The order is unchanged and the adapter proof is still required first:

```
5e8ec59  evidence model
   ↓
65f3725  this memo
   ↓
REAL FIRESTORE ADAPTER PROOF        ← still required, currently held
   ↓
migration of the 3 runnable entries
   ↓
resolver adoption
   ↓
console update
```

## 8 · Not done

- **No code, no migration, no deployment.** `5e8ec59` is unchanged.
- **The Firestore adapter proof is held** at your instruction; production persistence remains
  **UNPROVEN**, and nothing above depends on it being proven.
- **Production `integrationProbeLatest` contents: unreadable** — not attempted, not authorized.
- **`serviceCapabilities` is untouched by this memo.** It remains unmodelled, and item 5 does not
  populate it.
- Whether the *deployed* `integration-probe-executors.js` matches this source was not established;
  production functions are a union of lineages.
