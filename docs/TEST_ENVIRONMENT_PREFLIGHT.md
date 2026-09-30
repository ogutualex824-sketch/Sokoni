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
