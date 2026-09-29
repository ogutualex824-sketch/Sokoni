# The Firestore adapter proof, and the absence partition guard

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` · **Emulator only. No
production access, no migration, no deployment.**

The gate lifted after [[INTEGRATION_EVIDENCE_STEP_E_DECISION]] (`a062326`), for the **emulator
only**. Environment selected by the owner.

> **Result: 17 passed · 0 failed · 1 UNPROVEN** (adapter proof)
> **60 passed · 0 failed** (in-memory suite, now including the partition guard)
>
> The complete real-adapter chain is **PROVEN**. One condition could not be brought to a
> conclusion in this environment and is recorded as UNPROVEN rather than inferred.

---

## 1 · The absence partition guard

The typed meaning of absence lived only in prose. A console change that collapsed the six kinds
back into one grey `unknown` would have gone undetected — no suite would have turned red.

`classifyEvidenceSource(id)` now lives in the **model**, not in the test. A suite that reimplements
the rule it is checking asserts only that it agrees with itself, so the assertion drives the
producer.

| class | n | why a record is absent |
|---|---|---|
| `runnable-with-evidence` | **3** | a probe runs; evidence can exist now |
| `inbound-awaiting-callback` | **4** | no executor to call — evidence arrives only by correlated event |
| `declared-refusal` | **9** | a probe exists and deliberately will not run |
| `measurable-unwritten` | **15** | a probe could exist; none has been written |
| `not-applicable` | **5** | health is not a meaningful concept here |
| `observed-elsewhere` | **11** | a real signal exists, authoritatively elsewhere |
| | **47** | |

It is a **partition** assertion, not six count assertions — counts alone pass against a classifier
that puts one entry in two classes while another falls through. Asserted directly:

- **collectively exhaustive** — no entry unclassified, none in a class the model does not declare
- **mutually exclusive** — all **15** pairs of six classes compared, every intersection empty
- **exact set coverage** — the union *equals* the registry id set, with no duplicate
- **pinned counts**, summing to 47
- **the migration boundary by name** — `runnable-with-evidence` is exactly `cloud-storage`,
  `firestore`, `memorystore-redis`
- **the inbound four by name**, each confirmed to have no executor
- **an inverting control** — a non-catalogue id (`daraja`) is given **no** class rather than
  absorbed into one, and a deliberately wrong expected count is shown not to match

The 47 are held equal to the browser catalogue by `test-integration-registry-parity.js` (26/0, both
directions, with its own positive control). Re-parsing the browser file here would duplicate that
contract and give it a second place to drift.

## 2 · The three required controls

### Control 1 — the real adapter chain · **PROVEN**

```
adapter.set → validated write → adapter.get → resolver observes the evidence
```

Exercised against `firestoreStore()`, asserted to be `kind: 'firestore'` — the actual
implementation, not a substitute. Then, critically, through
**`resolveIntegrationStatus({ listSecretNames })` with nothing injected**: no `evidenceStore`, no
`latestProbes`. That is how `admin-os.js` calls it, and **no test in the in-memory suite exercises
it**, because every one of them injects a store. A real `runProbe(..., { persistEvidence: true })`
completes the same chain from the producer end.

### Control 2 — the negative path · **PROVEN**

Empty store → resolver → `unknown` for all 47, `probedAt: null`, and `evidenceReadable: true` — an
**empty** collection is readable, not an error. `get()` on an absent document returns `null`, not a
throw and not `{}`.

### Control 3 — the known-positive `{merge:true}` control · **PROVEN**

Written against **raw Firestore**, deliberately not through the adapter: its job is to establish
what merge *does*, not to say anything about our implementation.

```
set({notRunReason: X}, {merge:true})  →  set({health: Y}, {merge:true})  →  notRunReason is STILL X
```

Only then is the adapter measured against it: `set()` replaces, so a stale refusal is **cleared** by
the next write. This is the defect that makes `integrationProbeLatest` unadoptable — a rail that
refused once would read as refusing after it started working — and it is now measured rather than
asserted in a vacuum.

**These remain separate claims.** Control 3 proves Firestore's merge semantics; it does not prove
the adapter is correct. Control 1 passes on its own.

## 3 · Also proven, and only provable against a database

- **Tri-state `null` survives serialisation as `null`**, not as absent — `'delivered' in stages` is
  true after the round trip. A missing key reads as `undefined`, which is a different fact from
  unknown. The record still validates after coming back out of Firestore.
- **A refused record leaves nothing behind** — the collection is empty after a rejected write.
- **An invalid document already in Firestore is dropped and reported**, never rendered; the entry
  reads `unknown` and the drop appears in `evidenceDropped`.
- **A legacy-shaped document is refused**, caught on `schemaVersion` — so pointing the reader at
  `integrationProbeLatest` could not silently work. Adoption has to be a deliberate migration.
- **`list()` over twelve records** round-trips all twelve; the resolver then reports exactly those
  twelve with a `probedAt` and the other 35 `unknown`.

## 4 · UNPROVEN — the adapter against an unreachable endpoint

Two attempts, both recorded rather than quietly dropped.

**First attempt, and the defect it exposed.** A second app pointed at a dead port with
`settings({ host: '127.0.0.1:1' })` reported the store as **readable** — because
`FIRESTORE_EMULATOR_HOST` takes precedence over `settings.host`, so the "dead" client was in fact
reading the live emulator. The assertion failed, which is the harness working: it refused to certify
a control whose premise was false. Written the other way round it would have gone green on a test
that measured nothing.

**Second attempt.** Clearing the variable around client construction does point the client at the
dead port — and the read then never returns. **gRPC retries `UNAVAILABLE` indefinitely and the Admin
SDK exposes no per-call deadline.** Measured: still pending after 25s.

**What is and is not established.** The **resolver's** fail-closed logic is proven —
`test-integration-evidence.js` drives it with a throwing store and asserts unknown-for-all plus a
reported error. What is **not** established is the **adapter's** behaviour against an unreachable
endpoint: whether it eventually errors, and how long an operator waits first. A slow hang is a
different and arguably worse failure than a clean error, and this gate does not rule it out.

## 5 · How it is run, and why through a runner

`node scripts/run-evidence-firestore-cert.js`

A command in a README is not a mechanism. Three things must be true at once:

- **not the default port.** Several agents work this repository in parallel; binding 8080 would
  collide with another emulator or, worse, quietly attach to it and run the proof against a database
  somebody else is mutating. The runner picks a free port from 8091–8099 and **refuses to fall back
  to 8080**.
- **the dedicated cert project**, so a misconfiguration cannot address production.
- **teardown of only the emulator this run started.** `emulators:exec` owns that lifecycle; killing
  emulator processes by name would take out another agent's run.

Its own config is generated in a temp directory — the repository's `firebase.json` is neither read
nor modified.

**The suite's guard fails closed and runs before `firebase-admin` is required.** Verified by running
the suite directly: it aborts with exit 2. With `FIRESTORE_EMULATOR_HOST` absent, `firebase-admin`
would talk to real Firestore, so "no emulator" must abort rather than fall through.

```
ABORTED — FIRESTORE_EMULATOR_HOST is not set.
```

The guard's predicates are themselves asserted, so it can be shown capable of refusing:
`firestore.googleapis.com:443` is not loopback, `sokoni-aeb26` is not the cert project.

## 6 · Two defects in my own harness, found and fixed

- **`git show <sha>^` on Windows.** `execSync` runs through `cmd.exe`, where `^` is the **escape
  character** and is silently eaten — `5e8ec59^` became `5e8ec59`, so the check read Step B itself
  and reported that the premise of the slice was wrong. Now `~1`.
- **`HEAD` as a historical reference.** The same assertion originally used `HEAD` and went red the
  moment another agent committed. It was measuring *"has anything landed since?"* while claiming to
  measure the resolver. A historical claim needs a historical reference, so the commit is named.

## 7 · Boundaries held

- **No production access or writes.** Production Firestore was not contacted; the guard makes it
  unable to happen by accident. Production IAM, indexes and latency are therefore **UNPROVEN**.
- **No deployment. No migration.** The twelve records in §3 are test fixtures in a throwaway
  emulator destroyed when the runner exits — not a migration.
- **No `integrationProbeLatest` change**, no synthetic observation for any inbound rail, and the
  four inbound rails stay in their own persistence/correlation lane.
- **No unrelated refactoring.** The changes are the classifier, the partition assertion, the adapter
  suite and its runner.

## 8 · Next

Migration of exactly three — `firestore`, `memorystore-redis`, `cloud-storage` — remains **not
authorized by this gate**, and after it the resolver disagreement states, then console adoption.
