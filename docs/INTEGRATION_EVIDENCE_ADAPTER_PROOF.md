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

---

## 9 · The UNPROVEN control, investigated — it is a product finding, not a harness gap

The next gate was to resolve the one UNPROVEN result. It does not resolve, and **why** it does not is
the finding.

Three configurations were tried against a dead endpoint (`127.0.0.1:1`), read-only, no repository
file changed:

| | configuration | outcome |
|---|---|---|
| A | `settings({ host, ssl:false })` | **HUNG** > 15000ms |
| B | `settings({ clientConfig })` with gax `total_timeout_millis: 5000` and `RunQuery.timeout_millis` | **HUNG** > 15000ms |
| C | `settings({ host, maxIdleChannels: 0 })` | **HUNG** > 15000ms |

**The Admin SDK cannot be configured to fail fast here.** gax's per-method timeout does not bound a
read that cannot establish a connection, so there is no test-only route to the control.

### What that actually means

The control was never really about the harness. **The adapter has no bounded failure mode**, and
that has a production consequence the in-memory suite could not expose:

```
Firestore unreachable
      ↓
firestoreStore().list() never returns
      ↓
resolveIntegrationStatus never returns
      ↓
adminGetIntegrationStatus burns its whole invocation budget and dies
      ↓
the operator sees a spinner, then a generic failure
```

So `evidenceReadable: false` — the fail-closed state the model was designed around, carrying
`evidenceError` and leaving all 52 `unknown` — **is unreachable through the real adapter**. It is
reachable only through a store that throws, which is exactly what the in-memory suite injects. The
logic is correct and the path to it does not exist.

That is a defect in the Step B design, and only the adapter proof could have found it: every
in-memory test injects a store, so none of them ever waits on a socket.

### Proposed repair — not applied, not authorized

Bound the read **inside the adapter**, so an unreachable database produces a clean, fast
`evidenceReadable: false` instead of consuming the function's budget:

```js
async list () {
  return await withDeadline(col().get(), EVIDENCE_READ_DEADLINE_MS);
}
```

Two things must be got right, and both are reasons this should be reviewed rather than slipped in:

- **The deadline must not turn a slow success into a false negative.** Firestore that is healthy but
  briefly slow must not be reported as unreadable. The budget should be generous relative to a
  normal read and small relative to the callable's own timeout — those two constraints leave a wide
  window, but the number is a judgement, not a derivation.
- **The reported state must stay `unreadable`, never `missing`.** The model already draws that
  distinction correctly; a deadline must not quietly collapse it. An expired deadline is *"we could
  not find out"*, not *"there is nothing there"*.

With the deadline in place the control becomes provable in the same emulator run, so the repair and
its proof land together.

**Status: the UNPROVEN stands.** It is now understood rather than merely recorded, and it is a
product gap rather than an environment limitation. Step E migration remains held behind it.

---

## 10 · The bounded-read repair — applied and proven

Authorized as a narrow slice after §9. Adapter change + tests + timeout semantics only. No migration,
no deployment, no change to the other three lanes.

### It cancels; it does not conceal

A bare `Promise.race([read, timer])` would stop the *caller* waiting while the request kept running,
and repeated invocations would accumulate abandoned work. So `list()` — the call on the resolver's
path, and the one that hung — is built on `Query.stream()`, and the deadline calls
`stream.destroy()`, which tears the gRPC call down.

**Measured: the stream settles 7 ms after `destroy()` against a dead endpoint.** In the suite, an
unreachable Firestore returns in **1506 ms against a 1500 ms deadline**, and three further
invocations each return bounded — which is what rules out accumulation.

`get()` and `set()` are bounded by a deadline that **does not cancel**, because the SDK offers no
cancellation for them. That helper is named `_deadlineNoCancel` and says so in its own comment. The
adapter claims a bounded *return*; it does not claim the work stopped.

### The deadline is derived, and the derivation is asserted

```
healthy read (52 docs, emulator)   median 90 ms · max 206 ms
evidence read deadline             10 000 ms      ~50× the measured max
callable budget                    60 000 ms      adminGetIntegrationStatus declares
                                                  no timeoutSeconds → v2 default
```

The suite **measures** the healthy envelope on each run and asserts the two *relationships* —
`deadline > 20 × measured max` and `deadline ≤ callable / 4` — rather than asserting `10000 === 10000`,
which would prove nothing and would stay green if the callable budget changed underneath it.

**The measurement is a local floor, not a production envelope.** It was taken against an emulator;
production crosses a network. The headroom is sized for that, but the production healthy-read
envelope is **unmeasured** and the module says so.

### The four states

| # | condition | result |
|---|---|---|
| 1 | unreachable Firestore | bounded return · `evidenceReadable: false` · `evidenceError` populated · **unknown for all 52**, no `probedAt` |
| 2 | healthy | normal read · `evidenceReadable: true` · resolver sees all 52 |
| 3 | slow but successful | **still succeeds** — a deadline set to 4× the measured envelope does not turn a healthy read into a fault |
| 4 | expired deadline | **UNREADABLE, never MISSING** |

Proof 4 carries the control that gives it meaning: a **1 ms** deadline times out *with 52 documents
present*, and an **empty** collection reads `evidenceReadable: true`. Both yield `unknown` for every
entry — so health alone cannot tell them apart, and `evidenceReadable` is the field that does. It
also asserts `evidenceDropped` stays empty: a timeout is not a drop, because nothing was read to
drop.

### Result

**23 passed · 0 failed · 1 UNPROVEN** (was 17/0/1). Regression unchanged: evidence 69/0 · parity
26/0 · probes 85/0 · status 45/0 · console 86/0.

### What is still UNPROVEN, and why it is not the same gap

Whether every gRPC channel and retry timer is reclaimed **inside** the SDK after cancellation is not
observable from this process, and no assertion here establishes it. That is a narrower claim than
§9's: the fail-closed state is now reachable through the real adapter, which it was not before. The
adapter claims a bounded return and real stream cancellation — **not** zero residual resource — and
the suite reports that as UNPROVEN rather than rounding it up.

---

## 11 · Step E — the migration of exactly three, certified on the emulator

### There was nothing to migrate *from*

`integrationProbeLatest` is untouched by decision and no evidence record existed, so this does not
move data. It **creates** observations by running the declared probes and persisting what they
establish. A migration that copied a declaration into an observation would manufacture precisely the
fact this model exists to refuse.

### Selection cannot drift

The three are **derived** from `classifyEvidenceSource() === 'runnable-with-evidence'`, then
**asserted** against the three authorised by name. A catalogue change therefore *stops* the
migration rather than widening it.

### Two guards, and one of them was found by running it

**Target guard.** `--apply` requires `--target`. `--target=production` is **refused by the script
itself** — a separate act needing its own approval, guarded so it cannot happen by momentum.

**Blanket-failure guard — found by the first dry run.** With no Firestore, GCS or Redis reachable,
all three probes returned `failed` and the content check passed, *because it counted ids and ids were
all it counted*. Three `failed` records would have been persisted as facts about three providers.

Three **independent** rails failing at the same instant is overwhelmingly a statement about the
runner, not about GCS, Firestore and Redis being down together. A total failure is therefore refused
— same principle as `unknown` never collapsing into `missing`: **an environment that cannot observe
must not be recorded as an observation of failure.** `--allow-total-failure` exists for the genuine
case. The guard immediately paid for itself: the underlying cause was that the script never called
`initializeApp()`, which it now does.

The migration also observes **all three first and persists second** — persisting inside the loop
would have written the first record before the guard could see the third.

### Content-level result

| condition | result |
|---|---|
| 3 intended observations persisted | ✅ exactly `cloud-storage`, `firestore`, `memorystore-redis` |
| 0 unintended records | ✅ |
| resolver reads those 3 | ✅ and only those 3 carry a `probedAt` |
| remaining 49 retain derived state | ✅ `probedAt` null, `health` unknown, `stages` null — **nothing synthesised** |
| 52 technical reconcile exactly | ✅ id set equals the registry |
| re-running is not additive | ✅ a second run leaves 3, not 6 |

Every record is labelled `environment: 'emulator'` and names the migration in `recordedBy`.

### The distinctions all survived, re-asserted with data present

`declared ≠ observed` — the nine refusals still carry a *declared* reason with `probedAt: null`, and
the three observed rails carry no refusal. `inbound ≠ observed` — the four inbound rails gained
nothing; their evidence can only arrive by correlated callback. `operational ≠ technical` — neither
dependency has a record or a document. `unreadable ≠ missing` — re-asserted **with the three
migrated records in place**, because a populated store is where that distinction is most likely to
blur: a 1 ms deadline still reports unreadable rather than surfacing a partial view.

Partition unchanged at 3 · 4 · 9 · 18 · 5 · 13 = 52 — migration adds evidence, not classes. Parity
re-run with the store populated: 26/0.

**19 passed, 0 failed.**

### A finding about RC-1, not about the migration

Only `firestore` is observable from an emulator. It **was** reached — `stages.connected` and
`stages.accepted` are both `true`, with `evidence: service_account` — but its **health reads
`unknown`**, because `resolveIntegrationStatus` sets `credentialState: 'unknown'` whenever the Secret
Manager inventory cannot be read, and `deriveHealth()` returns `unknown` on that before it looks at
any stage.

That is the model behaving correctly — an *observation* and a *derived health* are different things,
and the observation survived when the health could not be computed. The suite asserts the **stages**
rather than the health, with a control showing the identical stages grade `connected` given a
readable inventory.

But it exposes something worth its own look: **an integration that declares no secrets has its
credential state forced to `unknown` by an unreadable inventory**, even though `not-applicable` is
knowable without reading anything — the `inventoryError` branch is tested before the
`!required.length` branch. Pre-existing RC-1 behaviour, outside this slice, **not changed here**.

### Also fixed — a harness defect of my own

`test-integration-evidence-firestore.js` asserted `environment === null` and went red the moment the
runner declared `SOKONI_ENVIRONMENT`. It was testing the harness's configuration rather than the
round trip. It now derives the expectation from `declaredEnvironment()`: what matters is that
whatever was *declared* survives serialisation.

### Not done

**No production migration.** The script refuses `--target=production` by design, so what is certified
is the migration *mechanism* and its content guarantees — on an emulator, where two of the three
observations are environment artefacts and are labelled as such. A production run is a separate act
requiring its own authorisation. No deployment. `integrationProbeLatest` untouched.
