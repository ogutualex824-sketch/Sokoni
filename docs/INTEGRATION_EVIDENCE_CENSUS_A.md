# Step A — Integration Evidence Census (read-only)

**Date:** 2026-09-29 · **Read-only. No schema change, no code, no migration, no deploy.**
Step A of [[SLICE_BRIEF_INTEGRATION_EVIDENCE_MODEL]] (`91fe2b5`). **Stops here by instruction.**

> The question this had to answer: *what is the existing source of truth for each integration
> field, and what code currently writes it?*
>
> **The headline answer is that for every health field, nothing writes it.** The consumer
> exists, the producer exists, and the connection between them does not.

---

## 1 · Where the 47 records live

The inventory exists **twice, deliberately**, because `firebase deploy --only functions` uploads
only `functions/`, so a `require('../sokoni-integration-catalogue.js')` resolves locally and
throws `MODULE_NOT_FOUND` in production.

| | file | entries |
|---|---|---|
| client catalogue | `sokoni-integration-catalogue.js` | **47** |
| server registry | `functions/integration-registry.js` | **47** |

The duplication is held by a contract, not by hope:
`scripts/test-integration-registry-parity.js` — **26 passed, 0 failed**, asserting all 47 agree
on id, category, lifecycle status, required secrets and health kind, in both directions.

The registry header still says "35 entries" in prose. **That figure is stale**; the parity suite
measures 47.

**Payments is IntaSend, at the registry level too.** The registry states it explicitly: *"M-Pesa
/ Daraja … is not a SOKONI payment integration: IntaSend is the sole active payment provider and
the merchant of record. Daraja must not appear here, must not be reported as a missing payment
credential, and must not be health-checked."* Catalogue payments: 3 live, all IntaSend;
`pos-card-terminal` quarantined; `sokoni-wallet` frozen.

## 2 · Field ownership — the reconciliation table

| field | source of truth | what writes it | reaches the console? |
|---|---|---|---|
| `id`, `name`, `vendor`, `category`, `lifecycle`, `direction` | catalogue **and** registry | committed source, parity-enforced | yes |
| `requiredSecrets` | registry | committed source | yes — **names only** |
| `credentials[].present` | Secret Manager `secrets.list` | computed live, never stored | yes |
| `credentialState` | derived from the above | `integration-status.js` | yes |
| health **kind** (`measurable` / `elsewhere` / `not-applicable`) | catalogue + registry | committed source | yes |
| probeability (`runnable` / `no_safe_probe` / `requires_secret_binding` / `none`) | `integration-probe-executors.js` | committed source | indirectly — gates the `test` control |
| `capabilities` | `_capabilities()` | computed live | yes — **but see §4** |
| `health`, `stages`, `stageSupport`, `evidence`, `probedAt` | probe result, via `latestProbes` | **NOTHING** | **no — permanently `unknown`** |
| `notRunReason` | `integration-probes.js:293` | set on the probe **result** | **no — dropped by the resolver** |
| **environment** | — | **does not exist** | — |
| **per-capability state** | — | **does not exist** | — |

**Nothing is persisted.** There is no Firestore collection of integration status. The whole
record is recomputed per request from Secret Manager plus committed source.

## 3 · The break, precisely

```
functions/integration-probes.js
   produces a probe result, INCLUDING notRunReason (:293)
        │
        ▼
   ── NOTHING ──   no default persistence: :343 writes only to an INJECTED
                   `store`, and no caller injects one
        │
        ▼
functions/integration-status.js:158
   const probes = o.latestProbes || {};        ← always {}
        │
        ▼
functions/admin-os.js:2135 and :2259
   resolveIntegrationStatus({})                ← called with an EMPTY object
        │
        ▼
console → health 'unknown' for all 47 → 40 NOT VERIFIED
```

`latestProbes` appears in exactly two places in the repository: as a **consumer** in
`integration-status.js`, and in the CHANGELOG. **No code anywhere supplies it.**

**So the 40 NOT VERIFIED is not a probe failure. It is an unwired seam.** Two joints are
missing, and they are separate work:

| # | missing joint |
|---|---|
| 1 | probe results have no default persistence — the `store` is injectable and nobody injects |
| 2 | no caller passes `latestProbes` — `admin-os.js` passes `{}` |

Fixing either alone changes nothing. Fixing both is what would let a probe reach the console —
and would make ACTIVE reachable for the 3 runnable rails.

### Why REFUSED BY DESIGN cannot fire

The resolver copies `health`, `healthNote`, `stages`, `stageSupport`, `evidence` and `probedAt`
from the probe — **and not `notRunReason`**. So even if joints 1 and 2 were connected, the field
the console keys REFUSED BY DESIGN on would still be dropped in transit. That is a **third**
distinct defect, and the brief's requirement to make refusal representable in the model is what
closes it.

## 4 · A name collision the new model must not walk into

`capabilities` **already exists** on the status record — and it does not mean what the brief
means by capability.

```js
function _capabilities (entry, credentialState) {
  const caps = ['view'];
  ...
  if (credOk && _probeRunnable(entry.id)) caps.push('test');
  if (entry.requiredSecrets.length) caps.push('view-credential-names');
  return caps;
}
```

These are **UI affordances** — which controls to render — not business capabilities like
"M-Pesa" or "Card checkout". The field is consumed by the console today.

**The new model must either choose a different field name or migrate this one deliberately.**
Reusing `capabilities` for business capabilities would silently change the meaning of a field
the console already reads, which is exactly the migration failure the brief's negative test #10
is guarding against.

## 5 · What already exists that the model should build on, not replace

| existing | why it matters |
|---|---|
| health **kind**, 3 values, all 47 classified, parity-enforced | proto-evidence taxonomy: `measurable` 31 · `elsewhere` 11 · `not-applicable` 5 |
| `probeAvailability(id)`, 4 values | the probeability field the brief asks for, already computed |
| `credentialState`, 6 values with `unknown` kept distinct from `missing` | the configured/evidence distinction, already correct |
| `CHIP_META` / `OPS_FROM_EVIDENCE`, explicit and exhaustive, no default branch | the resolver to extend |
| parity suite, 26/0 | the mechanism that stops catalogue and registry drifting |

The brief says derive rather than invent. On this evidence, **most of the semantic fields already
exist**; what is missing is persistence, the wiring, `notRunReason` passthrough, environment, and
per-capability granularity.

## 6 · Answer to the census question

> *What is the existing source of truth for each integration field, and what code currently
> writes it?*

- **Identity, category, lifecycle, secrets, health-kind, probeability** — committed source, in
  two files held equal by a parity suite. Reliable.
- **Credential presence** — Secret Manager, read live, never stored. Reliable.
- **Everything health-related** — *no writer exists.* The field is read from a parameter nobody
  passes, sourced from a result nobody persists.
- **Environment and per-capability state** — do not exist in any form.

## 7 · Not done — stops here by instruction

- No schema designed. No field added. No migration. No code changed. No deploy.
- Probe **execution** behaviour was not exercised; this is a static census.
- `functions/admin-os.js` was **read only** — it is the dispatcher host and is not this slice's
  to modify.
- Whether any *deployed* function differs from this source was not established; production
  functions are a union of lineages.
