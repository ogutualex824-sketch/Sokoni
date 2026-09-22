# Realtime Multi-Device — Evidence Report, Run 2

**Subject commits:** `798a85b` (implementation) · `27daf5f` (P17 repair)
**Prior evidence:** `5daf32c` — **not modified by this run; verified byte-unchanged**
**Date:** 2026-09-22

Related: [[REALTIME_PROOF_2026-09-22]] · [[REALTIME_MULTIDEVICE]]

> This report **adds** evidence. It does not rewrite Run 1. Where Run 1 recorded UNPROVEN and
> this run resolved it, both states are shown.

---

## 1 · What changed since Run 1

Run 1 left cross-device convergence UNPROVEN for an **environment** reason: the isolated
emulator kept dying because the background shell that started it went away, and I had
mistaken a "background task completed" notification for readiness.

Run 2 replaces that with a **foreground-supervised** emulator: one Node process owns the child
for the whole run, and Chromium does not start until four independent conditions hold.

| Gate | Result | Evidence |
|---|---|---|
| E1 child spawned, PID captured | **PASS** | `pid=5568` |
| E2 readiness banner observed | **PASS** | banner seen on child stdout |
| E3 port 8188 **independently** observed listening | **PASS** | TCP connect succeeded |
| E4 real Firestore **read + write** health probe | **PASS** | `write+read ok, exists=true` |

Only then did the browser start. That is an observed service state, not a task notification.

---

## 2 · NEWLY PROVEN by this run

### 2.1 Cross-device state convergence — **PASS**

Two independent Chromium contexts, a **scoped** listener (`where('owner','==',uid)`), against
the supervised emulator.

| ID | Result | Observed |
|---|---|---|
| CV1 | **PASS** | product CREATE on A reached B without a refresh — `type=added`, latency **3910 ms** (includes listener warm-up) |
| CV2 | **PASS** | EDIT (name + price) converged — `price=250 name="Widget PRO"`, latency **346 ms** |
| CV3 | **PASS** | availability/stock converged — `stock=0 available=false` |
| CV4 | **PASS** | **scope held** — a doc owned by another identity did **not** reach B (`events=[]`) |

### 2.2 Offline / reconnect reconciliation — **PASS**

| ID | Result | Observed |
|---|---|---|
| CV5 | INFO | events seen by B **while offline**: `0` — correct; nothing was delivered mid-disconnect |
| CV6 | **PASS** | on reconnect B received the doc created while it was offline (`BornWhileBOffline`) |
| CV7 | **PASS** | B reconciled to the **current** value `v=4, price=999` — not a replay of the v2/v3 it missed |
| CV8 | **PASS** | converged state **matches an authoritative re-read** — no stale local overwrite |
| CV9 | **PASS** | the same creation was **not** delivered twice (`added` events = 1) |

CV7 is the one that matters: reconciliation came from authoritative state, not from replaying
missed events — which is exactly what the requirement asked to be proven rather than assumed.

### 2.3 P17 fixed positioning — **PASS** (7/7, real Chromium, 390×844 phone viewport)

| ID | Result | Observed |
|---|---|---|
| P17 | **PASS** | `position:fixed`, `top:10`, `right:10`, `z-index:2147483000` |
| P17a | **PASS** | still exactly one bell |
| P17b | **PASS** | correct top-right safe-area offset |
| P17c | **PASS** | **stays in the viewport after scrolling 1800 px** — the actual defect, gone |
| P17d | **PASS** | **CONTROL** — bare class computes `relative`; ID-qualified computes `fixed` |
| P17e | **PASS** | a hand-written bell is unchanged (`relative`, unfloated) — repair is scoped |
| P17f | **PASS** | excluded surface (`pos-kiosk`) still mounts **zero** bells |

Static guards rose from 64 to **69/69**, including `B9` (the original ID rule survives — the
fix was not achieved by deleting the rule it conflicted with) and `B10c`, a control proving
the `!important` check is meaningful rather than matching its own comment.

---

## 3 · STILL UNPROVEN

| Item | Status | Why |
|---|---|---|
| A · FCM actual message delivery | **UNPROVEN** | no VAPID key, no push service, no physical device. **No Functions deploy performed.** Registry and sender-addressing are proven (Run 1 §3, R1–R7); delivery is not |
| B · authenticated SOKONI session | **NOT RUN** | no controlled test account credentials available in this environment |
| C · Merchant V2 notification UI | **NOT RUN** | requires B; `merchant-v2.html` is also foreign-dirty and was not loaded |
| D · POS notification UI | **NOT RUN** | requires B; `pos.html` foreign-dirty |
| E · POS Checkout notification UI | **NOT RUN** | requires B; `pos-checkout.html` foreign-dirty |
| F · checkout notification UI | **NOT RUN** | requires B |
| G · AdminOS notification UI | **NOT RUN** | requires B |
| H · multi-identity security matrix | **NOT RUN** | requires B. P23/CV4 prove **query scoping** and a **client-side refusal** — neither is backend authorization |
| I · SOKONI's own product/order/sale listeners | **NOT RUN** | CV1–CV4 prove the convergence **primitive**, not the application's 105 listener files |
| J · the 287 pre-existing `onSnapshot` sites | **NOT AUDITED, NOT MODIFIED** | unchanged boundary |

**Nothing above is marked FAIL.** A missing prerequisite is not a failing system.

---

## 4 · Environment blockers

| Blocker | Effect | Resolved? |
|---|---|---|
| Emulator dying with its background shell (Run 1) | convergence UNPROVEN | **RESOLVED** — foreground supervision |
| `firebase` not on PATH in background shells (exit 127) | restart failed | **RESOLVED** — `firebase.cmd` spawned with `shell:true` from the supervisor |
| Ports 8080/9099 occupied by another agent's emulator | cannot use default ports | **WORKED AROUND** — isolated ports 8188/9188, their emulator never touched |
| No auth credentials / no FCM devices | items A–H | **NOT RESOLVED** |

**Cleanup:** the supervisor's own `taskkill` did not release port 8188 (E5 **FAIL** — a java
grandchild outlived the CLI wrapper). It was then terminated explicitly by PID (`2244`), and
8188 verified released. Ports 8080/9099 were re-checked afterwards and **remain listening** —
the other agent's emulator was not disturbed.

---

## 5 · Registry terminology — preserved from `5daf32c`

Two distinct registries exist. Neither statement below may be collapsed into the other.

```
DEVICE SECURITY REGISTRY   securityDevices/{uid}/devices/{hash}
                           hashed login fingerprints, for device revocation
                           functions/security-identity.js:1128
                           holds NO FCM tokens

FCM TOKEN REGISTRY         users/{uid}.fcmTokens
                           written by the owner, read by notify.js,
                           pruned by FCM's own verdict
```

The architectural assertion is **`users/{uid}.fcmTokens` is the sole FCM-token registry** —
*not* "no devices collection exists", which would be false.

---

## 6 · Final table

| Capability | Existing evidence | New runtime evidence | Status |
|---|---|---|---|
| static realtime wiring | 64/64 (`5daf32c`) | 69/69 | **PASS** |
| FCM registry accumulation | 8/8 (`5daf32c`) | — | **PASS** |
| device identity | browser (`5daf32c`) | — | **PASS** |
| two-context browser seam | 24/25 (`5daf32c`) | 25/25 with P17 repaired | **PASS** |
| P17 fixed positioning | defect recorded | 7/7 incl. scroll + inverting control | **PASS** |
| cross-device realtime sync | UNPROVEN | **CV1–CV4** | **PASS** (primitive) |
| offline reconciliation | UNPROVEN | **CV5–CV9** | **PASS** |
| listener teardown / lifecycle | P20–P24 | — | **PASS** |
| no second registry | proven | — | **PASS** |
| deregister-before-signOut ordering | static only | — | **INCONCLUSIVE** |
| FCM actual delivery | none | none | **UNPROVEN** |
| authenticated SOKONI session | none | none | **NOT RUN** |
| notification UI on real surfaces | none | none | **NOT RUN** |
| multi-identity security matrix | none | none | **NOT RUN** |
| SOKONI's own 105 listener files | none | none | **NOT RUN** |
| 287 pre-existing listeners | none | none | **NOT AUDITED** |

---

## 7 · Deployment

**None performed, none authorized.** The P17 repair is committed (`27daf5f`) and would require
a hosting deploy for users to see it. That remains a separate release-control step.

## 8 · Reproduction

```
node scripts/test-realtime-multidevice.js                    # 69/69 static
cd <scratchpad>/proof
node supervised-convergence.js <repo-root>                   # spawns + supervises its own emulator
node p17-proof.js              <repo-root>                   # 7/7, no emulator needed
node browser-proof.js          <repo-root>                   # device identity / dedupe / lifecycle
node registry-proof.js         <repo-root>                   # 8/8, needs an emulator on 8188
```
