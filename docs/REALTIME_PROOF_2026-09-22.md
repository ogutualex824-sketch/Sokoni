# Realtime Multi-Device — Evidence Report

**Subject commit:** `798a85b`
**Date:** 2026-09-22
**Scope:** turn NOT PROVEN into observed evidence where possible; state precisely where it was not.

Related: [[REALTIME_MULTIDEVICE]] · [[PROVENANCE_GAP_MERCHANT_IDENTITY]]

> **No result in this report was produced by source inspection alone.** Every PASS below is
> either a static assertion (labelled as such) or an observed runtime behaviour captured by a
> harness. Where a runtime condition prevented a meaningful test, the row says UNPROVEN and
> gives the reason.

---

## 1 · Starting state

| | |
|---|---|
| HEAD | `798a85b59672ed6e940bd19ae557a4bf857ca900` |
| Contains `798a85b` | yes (HEAD *is* `798a85b`) |
| Index | **empty** — nothing staged |
| Owned files touched by this work | none (evidence artifact only) |

**Foreign dirty files at start — none were modified.** The other agent was actively working
during this session; the dirty set grew from 29 to 39 entries while the proof ran. Explicitly
untouched: `pos.html`, `service-worker.js`, `merchant-v2.html`, and every other file in the
dirty/untracked set. No `git reset/stash/clean/checkout/restore` was used at any point.

---

## 2 · Static regression — **64/64 PASS**

```
node scripts/test-realtime-multidevice.js      → exit 0, "64 passed, 0 failed"
```

Syntax checks on every file changed in `798a85b`:

| File | Result |
|---|---|
| `firebase.js` | `node --check` OK |
| `sokoni-device-bus.js` | `node --check` OK |
| `scripts/test-realtime-multidevice.js` | `node --check` OK |
| `realtime-harness.html` | script tags balanced |

The suite prints its own limit: *"these are WIRING claims read from source"*. It is reported
here as **static**, never as runtime proof.

---

## 3 · FCM registry — **RUNTIME PROVEN, 8/8**

Executed against an **isolated** Firestore emulator (`127.0.0.1:8188`, project
`demo-sokoni-proof`, scratchpad config). Ports 8080/9099 were already in use by another
agent's emulator and were **not** touched.

| ID | Result | Claim | Observed |
|---|---|---|---|
| R0 | **PASS** | **CONTROL** — the OLD single-field write *does* lose device A | `fcmToken = tokenB…` after A then B |
| R1 | PASS | device A registered | `fcmTokens=["tokenA…"]` |
| R2 | PASS | **B did NOT overwrite A** | `fcmTokens=["tokenA…","tokenB…"]` |
| R3 | PASS | re-registering is idempotent | no duplicate entry |
| R4 | PASS | sign-out removed A, **left B** | `fcmTokens=["tokenB…"]` |
| R5 | PASS | A's sign-out did not clear B's scalar | `fcmToken=tokenB…` |
| R6 | PASS | `notify.js collectTokens()` **executed** | returned `["S1","S2","S3","S4"]` |
| R7 | PASS | it de-duplicates across shapes | returned `["D1","D2"]` |

**R0 matters most**: it reproduces the original defect, so the fix is demonstrated against a
failing baseline rather than asserted. R6/R7 execute the real function body extracted from
`functions/notify.js` — that file was **not modified** by `798a85b`.

Evidence: `scratchpad/proof/registry-proof.js`, `registry-result.json`.

---

## 4 · Two-context browser proof — **24/25 PASS, 1 FAIL**

Real Chromium via Playwright. Device A and Device B are **separate browser contexts**, i.e.
separate storage partitions — not two tabs. Tab behaviour is tested separately (P5).

### Device identity — PASS

| ID | Result | Observed |
|---|---|---|
| P1 | PASS | well-formed id in a real browser: `dev_muccmkhz_jtqcevu7` |
| P2 | PASS | two contexts → **different** ids (`…jtqcevu7` vs `…zjcmdkg2`) |
| P3 | PASS | three consecutive calls identical |
| P4 | PASS | survives a real navigation |
| P5 | PASS | second **tab**, same context → **same** device |
| P6 | PASS | survives the **real** sign-out wipe (the shipped `_SOKONI_LS_KEEP` regex was extracted from `firebase.js` and applied in-browser) |
| P7 | PASS | **CONTROL** — `sk_notif_seen` *is* wiped by that same regex |
| P8 | PASS | after logout + reload the same identity is reused |
| P9 | PASS | all six corrupt values (`""`, `undefined`, `[object Object]`, `{"a":1}`, `dev_`, `xx`) rejected and replaced |

### Dedupe — PASS

| ID | Result | Observed |
|---|---|---|
| P10 | PASS | four channels, one event → **1** notification |
| P11 | PASS | a different transition on the same order → still notifies |
| P12 | PASS | after reload, an already-seen event does **not** re-notify |
| P13 | PASS | device B **does** notify — dedupe is per-device, not global |

### Tab bus — PASS

| ID | Result | Observed |
|---|---|---|
| P14 | PASS | message delivered between two tabs (observed callback) |
| P15 | PASS | did **not** cross to device B — it is not a sync channel |

### Notification UI — 3 PASS, 1 FAIL

| ID | Result | Observed |
|---|---|---|
| P16 | PASS | exactly **one** bell mounted where the page provided none |
| P17 | **FAIL** | computed `position: relative`, expected `fixed` — **see §9** |
| P18 | PASS | a page with its own bell keeps one; no second added |
| P19 | PASS | excluded surface (`pos-kiosk`) mounted **zero** bells |

### Listener lifecycle — PASS

| ID | Result | Observed |
|---|---|---|
| P20 | PASS | duplicate key → `attach` called **once**, `refs=2` |
| P21 | PASS | detaches only when the **last** holder releases |
| P22 | PASS | `release(scope)` tore down the remainder |
| P23 | PASS | unscoped tenant subscription **refused at runtime** |
| P24 | PASS | after remount, **0** leftover listeners |
| P25 | PASS | second module load is a no-op — same object, same id (no boot cycle) |

Evidence: `scratchpad/proof/browser-proof.js`, `browser-result.json`.

---

## 5 · Cross-device state convergence — **UNPROVEN**

**Reason, precisely:** the isolated Firestore emulator would not stay alive across this
session's background shells. It started successfully (the registry proof in §3 ran against it
and returned real data), then exited; a later background restart failed with **exit 127**
(`firebase` not on PATH in that shell), and `127.0.0.1:8188` is not listening at time of
writing. Two convergence runs therefore timed out (`exit 124`) with **no emulator behind
them**, and a minimal bounded run observed `B events: []`, `B errors: []` — consistent with a
dead backend, not with a convergence failure.

**This is an environment limitation, not a negative result.** No convergence row may be marked
FAIL on this evidence, and none is.

| Row | Status |
|---|---|
| product create / edit / price / availability / archive | **UNPROVEN** |
| sale create / status / inventory consequence | **UNPROVEN** |
| order create / status / assignment | **UNPROVEN** |
| message + notification delivery | **UNPROVEN** |
| shop/profile setting change | **UNPROVEN** |

A harness exists and is ready: `scratchpad/proof/convergence-proof.js` (two contexts, a
**scoped** `where('owner','==',uid)` listener, create/edit/scope-isolation/offline/reconnect).
It needs only a stable emulator. `realtime-harness.html` covers the same matrix manually on
two real signed-in devices.

**Also note:** even when run, that harness proves the *convergence primitive*. It does **not**
exercise SOKONI's own product/order/sale listeners, which live behind real auth across 105
files. Those remain NOT RUN regardless.

---

## 6 · Offline / reconnect — **UNPROVEN**

Same cause as §5. The scenario is implemented (`ctxB.setOffline(true)` → mutate on A →
`setOffline(false)` → assert B receives the missed doc, reconciles to the **current** value
rather than a replayed one, matches an authoritative re-read, and does not double-deliver),
but it never ran against a live backend.

---

## 7 · Push fan-out — layered, not collapsed

| Layer | Status | Basis |
|---|---|---|
| Registry accumulation (A + B coexist) | **PASS** | §3 R1–R3, emulator-observed |
| Sign-out deregistration removes only this device | **PASS** | §3 R4–R5, emulator-observed |
| Backend fan-out **source** consumes the registry | **PASS** | §3 R6–R7, real `collectTokens` body executed |
| Ordering: deregister **before** `signOut()` | **INCONCLUSIVE** | asserted statically (index-order check, suite `I6`); not observed at runtime — no instrumented sign-out was executed |
| Actual FCM delivery to a device | **UNPROVEN** | needs VAPID keys, a real push service and physical devices; **no Functions deploy was performed** |

---

## 8 · No-new-registry — **PROVEN**

| Check | Result |
|---|---|
| `users/{uid}/devices` subcollection introduced by `798a85b` | **none** — the only `devices/` strings in the diff are documentation saying it was deliberately *not* created |
| `functions/notify.js` modified by `798a85b` | **no** — absent from the changed-file list |
| Token-shape union still intact | `functions/notify.js:249–251` reads `fcmToken`, `fcmTokens`, `pushToken` |
| Registry writes added | `firebase.js` — `fcmTokens: arrayUnion(token)`, `arrayRemove(_tok)`, conditional `deleteField()` |

**Nuance that must not be lost:** a device registry *does* already exist —
`securityDevices/{uid}/devices/{fingerprintHash}` in `functions/security-identity.js:1128`. It
stores hashed **login fingerprints** for device revocation and holds **no FCM tokens**. So
`users/{uid}.fcmTokens` remains the sole *token* registry, but the claim "no devices
collection exists anywhere" would be false.

---

## 9 · DEFECT FOUND — reported, **not fixed** (awaiting authorization)

**Defect.** The fallback notification bell is not fixed-positioned. It computes to
`position: relative`, so on any page taller than the viewport it scrolls away instead of
remaining the persistent header affordance the requirement calls for — on a phone, that is the
whole notification surface.

**Evidence.** Browser proof **P17**: `{"count":1,"floating":"sk-notif-float",
"position":"relative","top":"10px"}` — observed in real Chromium, not inferred.

**Owning file.** `sokoni-notif-center.js` (mine, landed in `37204e7`).

**Root cause.** Line 37–38 of that file already declares `#sk-notif-btn{position:relative;}`.
An **ID** selector (specificity 1-0-0) outranks my `.sk-notif-float` **class** rule (0-1-0),
so the older rule wins regardless of injection order. My class-based CSS could never have
applied.

**Proposed minimal repair.** Raise the fallback rule's specificity to match the element it
targets — e.g. `#sk-notif-btn.sk-notif-float{position:fixed;…}` — leaving the existing
`#sk-notif-btn` rule untouched so hand-written bells are unaffected. One CSS selector; no
JavaScript change.

**Necessity.** Without it, the platform-wide bell added in `37204e7` is present but not
persistently reachable, which is the requirement it was added to satisfy.

**Surface impact:** Hosting only. **Functions:** none. **Rules:** none.
**Deployment required:** a hosting deploy for users to see it; nothing else.

**Not applied.** Per the proof instruction, repair is separated from evidence and awaits
authorization.

---

## 10 · Acceptance table

| Capability | Static / Wired | Runtime Proven | Live Two-Device | Status |
|---|---|---|---|---|
| Device identity | yes | yes (P1–P9) | yes — two contexts (P2) | **PASS** |
| FCM accumulation | yes | yes (R1–R3) | n/a — emulator | **PASS** |
| Logout deregistration | yes | yes (R4–R5) | n/a | **PASS** |
| Deregister-before-signOut ordering | yes (I6) | no | no | **INCONCLUSIVE** |
| Notification dedupe | yes | yes (P10–P13) | per-device shown (P13) | **PASS** |
| Notification UI mounting | yes | yes (P16, P18) | n/a | **PASS** |
| Notification UI positioning | yes | **contradicted** (P17) | n/a | **FAIL** |
| Excluded surfaces stay excluded | yes | yes (P19) | n/a | **PASS** |
| Listener teardown / lifecycle | yes | yes (P20–P24) | n/a | **PASS** |
| Security scoping (new listeners) | yes | yes (P23, refusal executed) | n/a | **PASS** |
| Security scoping (287 pre-existing) | no | no | no | **NOT RUN** (out of scope) |
| No boot cycle / idempotent init | yes | yes (P25) | n/a | **PASS** |
| No second registry | yes | yes (§8) | n/a | **PASS** |
| Realtime product sync | — | no | no | **UNPROVEN** |
| Realtime sale sync | — | no | no | **UNPROVEN** |
| Realtime order sync | — | no | no | **UNPROVEN** |
| Realtime message sync | — | no | no | **UNPROVEN** |
| Offline reconciliation | — | no | no | **UNPROVEN** |
| Push fan-out (device delivery) | — | no | no | **UNPROVEN** |
| Two-device matrix | — | — | — | **NOT RUN** |

---

## 11 · Explicit unproven boundaries

1. **No live Firestore backend was sustained**, so nothing about cross-device state
   convergence or offline reconciliation is established.
2. **No FCM message was ever sent.** No VAPID key, no push service, no physical device. The
   registry is proven; delivery is not.
3. **No authenticated SOKONI session was exercised.** Every browser proof ran against the
   isolated module, not the authenticated application, so the notification UI matrix across
   POS / Merchant V2 / checkout / inventory / catalogue / orders / delivery / AdminOS is
   **NOT RUN** — most of those pages are also foreign-dirty and were not loaded.
4. **The security scope matrix (§12 of the instruction) is NOT RUN.** Multi-identity
   authorization was never exercised; only the client-side refusal of an unscoped tenant
   subscription was (P23). That is a guard, not an authorization proof.
5. **The 287 pre-existing listeners were not audited and not modified.**

## 12 · Reproduction

```
node scripts/test-realtime-multidevice.js                      # 64/64, static
cd <scratchpad>/proof && firebase emulators:start \
    --only firestore,auth --project demo-sokoni-proof          # isolated, ports 8188/9188
node registry-proof.js      <repo-root>                        # 8/8   requires emulator
node browser-proof.js       <repo-root>                        # 24/25 no emulator needed
node convergence-proof.js   <repo-root>                        # requires a STABLE emulator
```
