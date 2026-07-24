# RC1 — Release-Candidate Regression Harness

Certifies **business correctness** of the critical user journeys, not page loads.
Each step ends `PASS`, `FAIL`, or `BLOCKED`. `BLOCKED` means *this backend cannot
test this here* (missing credential, secret, or capability) — it is **never**
counted as a pass, so a partial run states exactly what was and was not certified.

## Journeys

| Suite | Certifies |
|-------|-----------|
| RC-01 Seller | login → shop → product upload/edit/delete → search reflects → dashboard counts |
| RC-02 Buyer | browse → product → cart → quantity → **checkout math** → order history |
| RC-03 Payment | initiated → webhook → COMPLETE → subscription → entitlement → UI |
| RC-04 Inventory | stock 10 → buy 2 → **stock 8** → search / seller / POS / realtime agree |
| RC-05 Search | cold/warm cache · typo · bilingual · deleted disappears · edited updates |
| RC-06 PWA | manifest · service worker · offline · versioned cache |

## How to write a suite — assert in four layers

An end-state check alone is the weakest useful assertion. A page can return 200,
render, and serve fabricated data; an export can complete its request lifecycle
and still fail at the final authorization step. Both happened here. So assert in
layers, outermost first:

1. **Sequence** — the expected order of significant events.
   RC-07 asserts `pending → processing → ready` rather than "did it reach
   ready?". A final-state check reports a *timeout* when a job stalls at
   `pending`; the sequence view reports **where** it stopped.
2. **Cause** — why a transition happened, where practical.
   RC-07 asserts a failure carries a `failureCode`, so "it broke" becomes
   "it broke *here, for this reason*". RC-09's negative control does the same for
   authorization: it proves a `deny` came from the rules and not from a client
   that was blocked before the rules ran.
3. **Outcome** — the final observable state, with its artefacts.
   Status `ready` **and** a `downloadUrl` **and** an `expiresAt` — not just the
   status field.
4. **Failure shape** — would a failure here be transparent or convincing?
   If the subsystem can fail while still *looking* healthy, that is a defect to
   file, not a gap to note. This is the mandatory gate in
   [RELEASE_ACCEPTANCE](../../docs/RELEASE_ACCEPTANCE.md).

These reinforce each other: if layer 1 or 2 regresses while layer 3 still looks
acceptable, the suite still catches it. That is the case end-state checks miss
and users find first.

**Corollary — never let the harness manufacture a pass.** If a step cannot
exercise the real path, it must report `BLOCKED` with the reason. RC-04 refuses
to fake the inventory decrement with an admin write, because a PASS obtained by
bypassing the production path certifies nothing.

## Backends (pluggable — a suite is written once, runs on any)

- **`static`** — no auth. Serves the repo over HTTP and runs the UNAUTHENTICATED
  steps today (PWA, search UI + 16px, buyer cart/checkout math). Everything
  needing a signed-in user or Firestore write reports `BLOCKED`. **Runs now.**
- **`production`** — `firebase-admin` against the live project via ADC.
  Requires `gcloud auth application-default login` first (current ADC returns
  `invalid_client`). Creates the dedicated `*.beta@sokoni.test` identities and
  seeds `_rcSeed`-tagged data; `cleanup()` removes ONLY tagged docs.
- **`emulator`** — same admin adapter with `FIRESTORE_EMULATOR_HOST` +
  `FIREBASE_AUTH_EMULATOR_HOST` set. Needs **JDK 21+** (this machine has 17;
  firebase-tools 15.x refuses < 21). Fully isolated, zero production risk.

## Run

> **Windows:** in PowerShell these commands work as-is. In **Git Bash**, `gcloud` first
> fails with *"Python was not found"* — it is not broken, set `CLOUDSDK_PYTHON`. See
> [Local Development → Windows environment gotchas](../../docs/LOCAL_DEVELOPMENT.md#windows-environment-gotchas).
> (`export` is bash-only; PowerShell uses `$env:VAR = "..."`.)
> Note also that `gcloud auth login` and `gcloud auth application-default login` are
> **separate** credential stores; this harness needs the latter.

```bash
# Partial run available immediately (no credentials):
node tests/rc/rc-runner.js --backend=static

# Full authenticated run against production beta identities:
gcloud auth application-default login          # once — fixes invalid_client
node tests/rc/rc-runner.js --backend=production --allow-privileged

# Isolated run against the emulator (needs JDK 21):
firebase emulators:start --only auth,firestore --config firebase.emulator.json &
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  node tests/rc/rc-runner.js --backend=emulator --allow-privileged

# Scope to specific suites:
node tests/rc/rc-runner.js --backend=static --suite=rc-02,rc-06
```

`--allow-privileged` is **required** before any backend will mint the `manager`
or `admin` custom claims — a guard so an admin-capable account is never created
by accident, least of all in production.

## Evidence

Every run writes `docs/rc-runs/<label>/`:
- `report.md` — human-readable, screenshots inline
- `report.json` — machine-readable, every step + evidence + timestamps
- `<suite>/*.png` — screenshots captured at assertion points

## What blocks full certification today

1. **JDK 21** for the emulator path (env has 17), **or**
2. **fresh ADC** (`gcloud auth application-default login`) for the production path.
3. **Live IntaSend secrets** for RC-03 (payment webhook HMAC) — this journey
   cannot be certified locally on either path; it needs staging with secrets.

The dataset and journey definitions are complete and backend-agnostic, so the
authenticated suites execute unchanged the moment (1) or (2) is resolved.
