# Test / Deployment Environment Preflight

**Date:** 2026-09-30 · **Runner:** `node scripts/environment-preflight.js [--for syntax|browser|hosting|functions] [--reap] [--json]` · **Verdicts:** `READY` / `NOT_READY` + one reason code — fail closed, UNPROVEN is NOT_READY.
**Related:** [[RELEASE_GATE_LIVE_CATALOGUE]] · [[HOME_PICKED_FOR_YOU_INVENTORY_SYNC]] · `scripts/predeploy-syntax-gate.js` · `scripts/predeploy-browser-suites.js`

This is test and deployment **infrastructure only**. It changes no application code, no App Check, no payment path and no deployment configuration (`firebase.json` is untouched; the existing predeploy hooks call it).

---

## 1 · Why

On 2026-09-30 two owner-authorized hosting deploys were blocked by gates that reported code failures which were machine failures:

| Attempt | Gate said | What was true |
|---|---|---|
| 1 | required browser suite `test-home-picked-for-you.js` **38/1** | another session's WebKit suites ran on the same machine; Playwright clicks and navigations timed out under contention. The suite passed 39/0 alone, before and after. |
| 2 | syntax gate: **"1 file(s) do not parse: functions/algolia-analytics.js"** | the `node --check` child had died of `Fatal process out of memory`. ~35 parent-dead `WebKitNetworkProcess.exe` (~258 MB each) had taken system commit to the ceiling. The file parses. |

Both were then "fixed" by waiting and re-running, which is the wrong workflow: a gate that can misname a machine state as a code state teaches people to distrust the gate. Widening test timeouts was tried and **reverted** — timeouts mask contention rather than naming it.

## 2 · What the preflight checks

| Check | Fact measured | Reason code when it fails |
|---|---|---|
| RAM available | free physical ≥ 1,500 MB and free virtual (commit headroom) ≥ 3,000 MB | `OOM_RISK` |
| Orphan WebKit | parent-dead `WebKit*`, `Playwright.exe`, headless Chromium processes — count, pids | `ORPHAN_BROWSER_PROCESSES` |
| Peer browser lock | the lock file `%LOCALAPPDATA%\Temp\sokoni-preflight\browser-suite.lock` held by a live holder, **or** live `node scripts/test-*.js` runners / browser processes owned by another run | `PEER_BROWSER_SESSION_ACTIVE` |
| Node capacity | `node.exe` count ≤ 40 | `NODE_SATURATION` |
| Functions deploy | a `firebase … deploy` process on this machine whose `--only` scope includes functions (or has no scope) | `DEPLOYMENT_IN_PROGRESS` |
| Hosting deploy | same, scope includes hosting | `DEPLOYMENT_IN_PROGRESS` |
| Cloud Build | `gcloud builds list --ongoing` on `sokoni-aeb26`; gcloud unavailable = UNPROVEN | `CLOUD_BUILD_ACTIVE` / `CLOUD_BUILD_UNKNOWN` |

Scope per window (`--for`): **syntax** → RAM, orphans, node capacity · **browser** → + peer lock, deploys · **hosting / functions** → + Cloud Build.

Every run writes a JSON record (thresholds, memory, process counts and ownership, lock state, cleanup result, checks, start/end time) to `%LOCALAPPDATA%\Temp\sokoni-preflight\preflight-<timestamp>.json` and prints its path. That record is the answer to "why was that release blocked".

### Cleanup

`--reap` terminates **parent-dead** browser orphans only. A process whose parent is alive is another run's and is never touched (repo rule). Without `--reap` the preflight reports and refuses.

### Exclusivity

`--acquire NAME` takes the browser lock for a run (refused when a peer holds it or a peer suite is live); `--release NAME` releases it. `scripts/predeploy-browser-suites.js` acquires it before its first suite and releases it on exit, so two sessions cannot run required suites at once, and a session that starts its own suite while the gate runs is named in the gate's record.

## 3 · Where it runs

- `scripts/predeploy-syntax-gate.js` runs `--for syntax` **before** the 1,700-file sweep. If NOT_READY, the gate prints `SYNTAX_UNPROVEN` and stops without checking a file.
- `scripts/predeploy-browser-suites.js` runs `--for browser --acquire predeploy-browser-suites` before its first suite. If NOT_READY, it prints `RELEASE BLOCKED — ENVIRONMENT NOT READY` and runs nothing.
- Before a deploy, run `--for hosting` or `--for functions` by hand; the reason code tells you what to wait for.

## 4 · The syntax gate now classifies

```
node --check exits 0                               → SYNTAX_PASS
node --check exits 1, SyntaxError on stderr        → SYNTAX_FAIL      (code)      DEPLOY BLOCKED
node --check crashes / OOM / signal / spawn error  → SYNTAX_UNPROVEN  (machine)   STOP — no retry
```

UNPROVEN stops the sweep at the first crash and names the file it stopped at and how many had passed; it never retries into green. Proven by `scripts/test-syntax-gate-classification.js` (14/0): fabricated `spawnSync` shapes (exit 0, SyntaxError, OOM banner, SIGKILL, spawn EAGAIN, VirtualAlloc, SyntaxError **plus** OOM banner, exit 1 without SyntaxError) and real children (a parseable file, a real syntax error, a missing file).

## 5 · First real run (2026-09-30 10:59Z)

The preflight's first run on the live machine reported, truthfully: free physical 380 MB (`OOM_RISK`), 16 parent-dead browser processes, a peer WebKit suite running (`test-merchant-disputes-ui.js`, not this session's), and a functions deploy in progress (sokoni-70's owner-authorized F1-R). `NOT_READY` on all three windows. That is the state the two false blocks were produced in, now named before a gate starts instead of after one dies.

## 6 · Limits

- Process facts come from Windows CIM; on another OS the process checks are UNPROVEN and the result is NOT_READY.
- The lock is advisory: a session that does not use the runner is only detected through its live processes.
- Thresholds are conservative and hand-set; change them in one place (`T` in the script) with a reason.

## 7 · Governance dependency recorded 2026-09-30 — the inventory gate is a release prerequisite for any `/inventory/i` path

`scripts/gate-inventory.js` runs `test-inventory.js --gate` (every `scripts/test-*.js`) inside the hosting predeploy whenever a changed file matches `/inventory/i` (or `functions/shared/**`, `functions/index.js`, `firestore.rules`, `firestore.indexes.json`, `firebase.js`) — even when the change is unrelated to inventory behaviour. Candidate `82d8ce0` (readers + writers for the `uploadedAt` ordering key) touches `sokoni-inventory.js` and therefore inherits the gate, which is currently **BLOCKED by pre-existing findings that reproduce identically on the pre-slice tree `07088bb`** (`docs/release-gates/82d8ce0.json`): cart-universal (mixed line endings in `agreement-acknowledge.html` / `complete-application.html`; `track.html` tags), map-engine ratchet (`business-apply.html`, 16 vs 15), merchant-capability (13 routes vs 12; 3 withheld vs 2), merchant-products-2c-media (BLOCKED: no `storage.rules.deployed` snapshot); seller-wiring change-detection hangs after its 13th case on both trees (TIMEOUT, non-blocking).

This is a governance dependency, **not** evidence that `82d8ce0` broke inventory. The rule that follows: those findings are repaired in their own slices; the gate is never weakened, and a candidate is never altered merely to evade the path filter.

### 7a · Repairs to the pre-existing inventory-gate blockers (2026-09-30, each its own commit, test infrastructure only)

| Blocker | Cause found | Repair | Proof |
|---|---|---|---|
| map-engine ratchet: "business-apply.html implements its own map" | the detector regex `L\.map\s*\(` matched `L.map((x) => …)`, an `Array.prototype.map` on a local named `L`; the page loads no Leaflet | the Leaflet branch now also requires the page to reference Leaflet (`leaflet.js/.css` or `L.tileLayer` / `L.marker`); Google Maps and geolocation branches unchanged | 8 / 0; 15 baselined pages unchanged |
| merchant-products-2c-media: 3 × BLOCKED | the gitignored `storage.rules.deployed` snapshot is absent on every clean checkout | the suite runs the existing read-only fetch first; a failed fetch still leaves BLOCKED, never a false PASS | snapshot removed → 56 / 0 and re-fetched; deployed ruleset identical to committed `storage.rules` |
| cart-universal: "no inserted block mixes line endings" for `agreement-acknowledge.html`, `complete-application.html` | both pages were born after the rollout with the tag from their first commit, are LF-only, and lack the rollout marker; the detector treated "no marker" as "mixed" | pages absent at the rollout base are skipped; pages the rollout edited keep the full check | 46 / 1 |
| merchant-capability: 13 negotiated vs 12; 3 withheld vs 2 | the suite froze counts; `offers` became withheld in v1 at `be7c676` (the live lineage). An existing fix (`55b000c` / `35e129d`, three other branches) derives the surface but expects a `supply` route this lineage lacks | reused `55b000c`'s derived structure with this lineage's set `inventory,offers,sell` | 46 / 0 |
| seller-wiring change-detection: TIMEOUT | passes all 13 cases and never exits, on both trees | not repaired here (TIMEOUT is non-blocking in the gate); own item | — |

**Remaining blocker — an owner decision, not a detector bug:** cart-universal "every page kept all its tags" still names **`track.html`**. Commit `e5ea3e4` (Rider Navigation & Intelligent Dispatch v1.0, live) removed six tags — the four `firebasejs/9.22.2/*-compat.js` scripts, `sokoni-appcheck.js` and `sokoni-config.js` — and replaced them with a dynamic `import('./firebase.js')` (which owns App Check and config). The suite's perimeter rule is "nothing may be LOST" with one named 1:1 exemption (the Font Awesome cdnjs → local pair). This loss is the same shape: a 1:1 SDK migration, compat → modular, already in production. Options: (a) add a second named exemption pair (lost = exactly that compat/config set AND the page imports `./firebase.js`); (b) restore the six tags on `track.html` (a hosting content change that would double-load Firebase). (a) is the honest reading of the rule; it is a decision about the cart perimeter contract and is left to the owner.

### 2a · Added 2026-09-30 — Emulator ports (`--for gate`, and in hosting / functions)

`gate-inventory` runs `firebase emulators:exec`; it died twice with "Could not start Authentication Emulator, port taken" because another session was running the same emulator-backed gate. The preflight now reports listeners on 4400 / 4500 / 8080 / 9099 with the owning pid (marked when it is a firebase emulator) → `EMULATOR_IN_USE`. The gate is exclusive on a machine, like the browser suites. Run `node scripts/environment-preflight.js --for gate` before `node scripts/gate-inventory.js`.

### 7b · Outcome (2026-09-30 15:0xZ) — the inventory gate is GREEN on the repaired tree

Full `gate-inventory` run on `ddf317b` (detached from tool timeouts, emulator ports free, tree clean): **APPROVED** — 342 PASS rows, 341 blocking suites passed, 0 FAIL, 0 BLOCKED. The only non-PASS row is the pre-existing `test-seller-wiring-change-detection` TIMEOUT (passes all 13 cases, never exits; non-blocking by the gate's own rule, own item). The four repaired suites inside the gate: map-engine ratchet PASS · merchant-products-2c-media PASS (deployed rules fetched) · cart-universal PASS (54 assertions incl. the track.html exemption controls) · merchant-capability PASS. Artefact: `docs/release-gates/ddf317b.json`. Hosting content is byte-identical to `82d8ce0`; rules, indexes, Functions and `firebase.json` untouched.
