# Realtime Multi-Device — Evidence Report, Run 3 (final boundaries)

**Baseline commits:** `27daf5f` (P17 repair) · `4b7e3af` (convergence) · `5daf32c` (Run 1)
**Date:** 2026-09-22
**Architecture unchanged. 287 pre-existing listeners untouched. No deploy.**

> Adds evidence only. Runs 1 and 2 are not rewritten and were verified unchanged.

---

## 1 · The eight remaining boundaries

| # | Item | Status |
|---|---|---|
| 1 | actual FCM message delivery | **UNPROVEN** |
| 2 | authenticated SOKONI session | **NOT RUN** |
| 3 | Merchant V2 notification surface | **PASS** (mount) |
| 4 | POS notification surface | **PASS** (mount) |
| 5 | POS Checkout notification surface | **PASS** (mount, via redirect) |
| 6 | checkout notification surface | **NOT RUN** |
| 7 | AdminOS notification surface | **NOT RUN** |
| 8 | multi-identity authorization matrix | **PASS** (19/19, real ruleset) |

---

## 2 · Item 8 — authorization matrix, **19/19 against the REAL ruleset**

The production `firestore.rules` (**274,869 bytes**) was loaded **verbatim** into an isolated
emulator via `@firebase/rules-unit-testing`. **No rule was edited.** This is the rules engine
deciding — categorically different from the client-side refusal proven earlier (P23), which a
caller could simply decline to use.

| ID | Result | Claim |
|---|---|---|
| Z0 | PASS | real ruleset loaded verbatim, not a fixture |
| Z1 | PASS | **ALLOW CONTROL** — A can read its own notification |
| Z2 / Z3 | PASS | A cannot read B's notification, **and symmetrically** |
| Z4 | PASS | **ALLOW CONTROL** — broadcast notifications are readable |
| Z5 | PASS | unauthenticated caller denied |
| Z6 | PASS | A cannot mark B's notification read |
| Z7 | PASS | **ALLOW CONTROL** — A can read its own order |
| Z8 / Z9 | PASS | cross-business order reads denied, **symmetrically** |
| Z10 | PASS | **ALLOW CONTROL** — B reads the order where B is *seller* (role, not ownership) |
| Z11 | PASS | **ALLOW CONTROL** — A reads the same order as *buyer* |
| Z12 | PASS | an unrelated rider identity is denied |
| Z13 | PASS | unauthenticated order read denied |
| Z14 | PASS | B cannot mutate A's order |
| Z15 / Z16 | PASS | non-admin and anonymous denied on `adminAudit` |
| Z17 | PASS | an **unscoped sweep** of `notifications` is refused |
| Z18 | PASS | **ALLOW CONTROL** — the correctly scoped query succeeds |

Every deny is paired with an allow control. A ruleset that refused everyone would pass a
deny-only suite while being catastrophically broken; Z1/Z4/Z7/Z10/Z11/Z18 rule that out.

---

## 3 · Items 3–7 — notification surface on the REAL pages

Pages served **read-only** from the repo; none modified. They target **production** Firebase,
so no session exists: this proves **mounting**, not unread counts.

| Surface | Bells | Position | Landed on | Status |
|---|---|---|---|---|
| **Merchant V2** | 1 | `fixed` | `/merchant-v2.html` | **PASS** |
| **POS** | 1 | `fixed` | `/pos.html` | **PASS** |
| **POS Checkout** | 1 | `fixed` | `/pos.html` (redirects) | **PASS** |
| inventory | 1 | `fixed` | `/pos-inventory.html` | **PASS** |
| catalogue | 1 | `fixed` | `/catalogue.html` | **PASS** |
| checkout | 0 | — | **`/login.html`** | **NOT RUN** — never reached; auth-guard redirect |
| AdminOS | 0 | — | **`/login.html`** | **NOT RUN** — never reached; auth-guard redirect |
| orders | — | — | — | **NOT RUN** — `orders.html` does not exist |

Excluded surfaces:

| Surface | Bells | Status |
|---|---|---|
| kiosk · customer display · KDS · print station | 0 | **PASS** — all four clean |
| **pay-q** | **1** (`relative`) | **FINDING — see §5** |

### A harness defect I had to correct twice

The first two runs of this matrix reported **`bells=0` on POS and Merchant V2**. Both were
**false zeros**: `notif-center` is injected on idle and then waits 1500 ms, so a 3,516-line
page mounts later than a synthetic one. A fixed 3.2 s wait, then 8 s, were each too short.

Had I reported the first reading, I would have filed a fabricated defect against the flagship
surface. The harness now **waits for the condition** (`waitForFunction`, 20 s budget) and only
records 0 after the budget genuinely elapses.

---

## 4 · Items 1–2 — why they could not be attempted

**Item 1 · actual FCM delivery — UNPROVEN.**
`firebase.js:1177` takes `vapidKey` as a **caller-supplied parameter** and short-circuits on
the placeholder `"YOUR_VAPID_KEY_HERE"`. No VAPID key and **no service-account JSON** exist in
the repository. Without a key there is no push subscription, and without a service account no
sender can be exercised. No Functions deploy was performed.

Layered, not collapsed:

| Layer | Status | Basis |
|---|---|---|
| token registration | **PASS** | Run 1 R1 |
| token accumulation (A + B coexist) | **PASS** | Run 1 R2–R3 |
| sender addressing | **PASS** | Run 1 R6–R7 — real `collectTokens` body executed |
| provider acceptance | **UNPROVEN** | no credentials |
| actual device receipt | **UNPROVEN** | no device, no push service |
| dead-token pruning | **INCONCLUSIVE** | the `arrayRemove` path is proven (R4); FCM-reported death is not, as no send occurred |

**Item 2 · authenticated SOKONI session — NOT RUN.**
`IS_LOCALHOST` in `firebase.js:115` gates **App Check debug only** — it does not redirect the
SDK to an emulator. Every page therefore talks to production Firebase, and authenticating
would require a real production credential, which the instruction forbids. Items 6 and 7
follow directly: both redirect to `/login.html`.

---

## 5 · FINDING — the bell-exclusion policy is enforced in only one of two places

**Observed:** `pay-q.html` ("SOKONI Till Payment") is on `notif-center`'s `_NO_BELL` list, yet
a bell is present — `position: relative`, i.e. **not** the floating fallback.

**Cause:** the bell is injected by `shared-header.js:1358` as part of the **nav**, and `pay-q`
is absent from *that* file's `EXCLUDED` list. `pay-q.html` hand-writes no bell of its own
(`grep` count = 0). So my `_NO_BELL` list suppresses the **fallback** and nothing else.

**Why it matters:** `pay-q` is a till-payment surface a **customer** may be looking at. A
merchant unread count there is the same class of disclosure the exclusion list exists to
prevent.

**Not a regression** — `shared-header` has always injected a nav bell on non-excluded pages.
But adding `_NO_BELL` created the appearance of one coherent exclusion policy when there are
two, and only one honours the list.

**Not fixed.** The instruction is to stop after the evidence report. A repair would mean
aligning `shared-header.js`'s `EXCLUDED` with `notif-center`'s `_NO_BELL` — Hosting-only, no
Functions, no rules — and is **not** applied here.

---

## 6 · Final matrix — A · B · C · D · E

### A — Proven realtime **primitive**
| | |
|---|---|
| cross-context create / edit / stock convergence | **PASS** (`4b7e3af` CV1–CV3) |
| query scope isolation | **PASS** (CV4) |
| offline missed-state + authoritative reconciliation | **PASS** (CV5–CV9) |
| device identity, dedupe, listener lifecycle | **PASS** (`5daf32c`) |

### B — Proven SOKONI **integration**
| | |
|---|---|
| notification surface mounts on Merchant V2, POS, POS Checkout, inventory, catalogue | **PASS** |
| fixed positioning on real pages | **PASS** (`27daf5f`) |
| four of five excluded surfaces clean | **PASS** |
| pay-q exclusion | **FINDING** (§5) |
| unread counts, drawer behaviour, SOKONI's own 105 listener files | **NOT RUN** |

### C — Proven **push delivery**
| | |
|---|---|
| registry + addressing | **PASS** |
| provider acceptance, device receipt | **UNPROVEN** |

### D — Proven **authenticated security**
| | |
|---|---|
| backend authorization matrix, real ruleset | **PASS** (19/19) |
| authenticated end-to-end session | **NOT RUN** |

### E — **Unaudited** pre-existing listeners
| | |
|---|---|
| 287 `onSnapshot` sites | **NOT AUDITED, NOT MODIFIED** |

---

## 7 · Honest summary

The realtime **mechanism** is proven: convergence, scope isolation, authoritative
reconciliation, device identity, dedupe, lifecycle, and now **backend authorization against the
real ruleset**. The notification surface is proven to **mount** on the real merchant pages.

What is **not** proven is the authenticated end-to-end product: no real session, no delivered
push, no unread-count behaviour, and no audit of the 105 application listener files or the 287
pre-existing subscription sites.

**SOKONI's realtime ecosystem should not be described as live-proven.** The mechanism is
proven; its integration under authentication is not.

## 8 · Deployment

**None performed. None authorized.** `27daf5f` is an independent Hosting change and remains
available for the clean live-lineage release process when explicitly authorized.
