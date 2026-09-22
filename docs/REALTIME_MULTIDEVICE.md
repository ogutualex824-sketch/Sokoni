# Real-Time Multi-Device Synchronization

**Status:** CORE ECOSYSTEM REQUIREMENT · audit complete, Hosting-safe layer implemented
**Raised:** 2026-09-22
**Gate:** Functions- and rules-dependent work is ISOLATED below, not faked

Related: [[PROVENANCE_GAP_MERCHANT_IDENTITY]] · [[GCP_COST_ARCHITECTURE_IMPLEMENTATION]]

---

## The requirement

SOKONI behaves as one live system across every active, signed-in, authorized device.
An authoritative event on one device reaches the others **where it is relevant to them**.

**Real-time means state convergence, not a toast on another phone.** If a product is
uploaded on the laptop, the tablet must hold the new authoritative product state without a
refresh. The notification is only the user's signal that something changed.

### Three layers, never collapsed

| Layer | Owner | Rule |
|---|---|---|
| 1 · Authoritative state | Firestore | the single source of truth |
| 2 · Synchronization | scoped `onSnapshot` | clients converge with no manual refresh |
| 3 · Notification | `notify.js` → engine → centre | a signal, **never** a substitute for layer 2 |

---

## Audit — what already existed (read-only, 2026-09-22)

The estate was **not** missing realtime. It was missing the seam between the parts.

| Component | Role | Verdict |
|---|---|---|
| 287 `onSnapshot` sites / 105 files | live state, per page | **already realtime** |
| `realtime.js` v1.0 | upgrades fetches → snapshots (products, hubs, order status, bookings) | **already realtime** |
| `functions/notify.js` (802 ln) | ONE backend sender for push/in-app/SMS/email | **canonical, already unified** |
| `sokoni-notif-engine.js` (922 ln) | prefs, offline queue, dedupe, grouping, fatigue | **canonical** |
| `sokoni-notif-center.js` (1244 ln) | bell + drawer UI | **canonical** |
| `shared-header.js` | injects engine + centre on idle | 320/335 pages |
| `security.js` | injects sync/wiring modules | 293/335 pages |
| `pos-session-manager.js` | `posSessions/{id}`, `deviceId`, heartbeat | POS only |
| `sokoni-sync.js` | localStorage ↔ Firestore, debounced 3 s | cross-device KV |
| `sokoni-notifications.js` (295 ln) | **ORPHAN** — loaded by nothing, still precached | see below |

### Findings

**F1 — Bell coverage was a per-page accident.** `shared-header.js` excludes 13 pages from nav
injection. Only `seller.html` and `profile.html` hand-wrote their own `#sk-notif-btn`. So
**POS, Merchant V2, merchant and every enterprise dashboard had no notification surface at
all, on any device** — and on a phone that is the entire affordance.

**F2 — An orphan with a divergent query.** `sokoni-notifications.js` queries
`targetUid in [uid,'broadcast']`; `sokoni-notif-engine.js` queries `targetUid == uid`. Two
different answers to "do broadcasts exist". The orphan is loaded by nothing, so this is
latent, not live — but it is still precached by the service worker.

**F3 — A near-miss that would have taken the product grid down.** `security.js` guards
`realtime.js` with `document.querySelector('script[src*="realtime"]')` — a **substring**
test. A new module named `sokoni-realtime.js` would have satisfied that guard and silently
suppressed `realtime.js`, killing the live product grid, hub and order-status listeners with
no error anywhere. The new module is therefore named **`sokoni-device-bus.js`**, and
`test-realtime-multidevice.js` asserts no injected name ever contains `realtime` again.

**F4 — No device identity outside POS.** `posSessions` gives POS a `deviceId`; nothing else
had one, so "same user" and "same screen" were indistinguishable.

---

## Event-family classification

| Event family | Authoritative state | Realtime channel | Classification |
|---|---|---|---|
| Product created / edited | `products` | `realtime.js`, `sokoni-db.js` | **already realtime** |
| Inventory changed | `inventory`, `posProducts` | `sokoni-inventory.js` | **already realtime** |
| Order created / status | `orders` | `sokoni-orders.js`, `track.html`, `realtime.js` | **already realtime** |
| Messages | `conversations`, `messages` | `sokoni-chat-engine.js`, `sokoni-inbox.js` | **already realtime** |
| Notifications | `notifications` | `sokoni-notif-engine.js` | **already realtime** |
| POS sale | `posSales`, `posPayments` | `pos-sales.js`, `pos-modules.js` | **partially realtime** — till converges; Merchant V2 revenue/report convergence unverified |
| Delivery / rider | `deliveries`, `packageRequests` | `delivery-hub.js`, `dispatch.html` | **partially realtime** |
| Payment state | `payments` | webhook → Firestore | **Functions-dependent** |
| Cross-device push fan-out | — | `notify.js` | **Functions-dependent** (deploy BLOCKED) |
| Any new collection | — | — | **rules-dependent** (deploys gated) |

---

## Implemented — Hosting-safe only

### `sokoni-device-bus.js` (new)

The seam, and deliberately **not** a sixth system. Where a capability exists it is delegated
to, never reimplemented.

- **Device + session identity.** `deviceId()` is memoised in memory, so a browser with
  storage blocked (private mode, embedded webview) still reports a *stable* id for the load
  instead of a new one per call.
- **Scoped subscription registry.** `subscribe()` refcounts duplicate keys onto one listener,
  releases on `pagehide`, and **refuses** an unscoped subscription to a tenant-scoped
  collection rather than quietly widening it. A client-side filter still transfers the data.
- **Cross-channel dedupe.** `claim(id)` is true once and false thereafter, delegating to the
  engine's existing `sk_notif_seen` store — plus an in-memory mirror so dedupe still works
  when storage is blocked, which is exactly when a sale arriving as snapshot + SW message +
  push would otherwise deliver three copies.
- **Same-device tab bus** via `BroadcastChannel`, and an `onReconnect` hook.

### Bell coverage is now a platform property

`sokoni-notif-center.js` self-mounts a safe-area-anchored floating bell when a page provides
no `#sk-notif-btn`, after waiting for `shared-header` so no page grows two. A hand-written
bell always wins. Customer-facing and unattended surfaces — kiosk, customer display, KDS,
print station, print tests, `pay-q`, auth pages — are **denied** a merchant bell by name:
a merchant's unread count must never appear on a screen the customer is looking at.

`security.js` now also injects the engine + centre on idle, reusing the **same element ids**
as `shared-header.js`, so whichever runs first wins and neither can double-load. Coverage is
now every page except named diagnostics.

---

## CORRECTION — cross-device push was never Functions-blocked

The first pass classified push fan-out as Functions-dependent. **That was wrong**, and the
dependency trace (step 8) found the real cause one layer up.

```
device registers → users/{uid}.fcmToken  ← A SINGLE FIELD
                   ↓
            every new device OVERWRITES the previous one
                   ↓
            notify.js collectTokens() finds exactly ONE token
                   ↓
            only the most recently signed-in device is reachable
```

The **backend was always correct**. `functions/notify.js` already unions
`fcmToken` + `fcmTokens` + `pushToken`, already sends via `sendEachForMulticast`, and already
prunes dead tokens with `arrayRemove`. It was waiting for a writer that accumulates.

**The fix is client-side.** `firebase.js` now writes `fcmTokens: arrayUnion(token)` alongside
the legacy scalar. Same document, same owner, one extra field — **no Functions deploy, no
rules change.** Push fan-out moves from *blocked* to *implemented, awaiting live proof*.

A second defect fell out of the same trace: with an accumulating array, a signed-out device's
token would persist and keep delivering that user's order, payment and message notifications
to a handset with no session. Sign-out now `arrayRemove`s this device's token **before**
`signOut()`, while the write is still authorized.

### Device registration already exists

Step 9 asked whether a registry was needed. It is not. `users/{uid}.fcmTokens` **is** the
authoritative device registry: written by the owner, read by `notify.js`, pruned by FCM's own
verdict on each send. Inventing `users/{uid}/devices/{deviceId}` would have been a second
registry and a rules change for no gain.

## NOT done — isolated, not faked

| Item | Blocked by |
|---|---|
| Retiring the `sokoni-notifications.js` orphan | needs a service-worker precache edit; `service-worker.js` is another agent's dirty file — **a separate owned change**, per step 12 |
| Merchant V2 revenue convergence after a POS sale | needs the live matrix; `merchant-v2.html` is also currently foreign-dirty |
| Auditing the **287 pre-existing** listeners for scope | the new registry refuses unscoped tenant subscriptions, but the existing listeners predate it and were **not** rewritten — untouched by design |

---

## Acceptance status — WIRED vs LIVE-PROVEN

| Criterion | Status |
|---|---|
| Client realtime wiring | **PASS** (64 assertions) |
| Device identity | **PASS** — stable across calls, tabs, navigation, logout; survives corrupt and unavailable storage |
| Notification dedupe | **PASS** — 4 channels → 1; 2 transitions → 2 |
| Notification UI | **PASS** — platform-wide, safe-area, exclusions enforced |
| Security scoping | **PASS** for new listeners; pre-existing 287 **NOT AUDITED** |
| Listener lifecycle | **PASS** — refcounted, ledgered, released on `pagehide` |
| State synchronization | **NOT PROVEN** — needs two devices |
| Push fan-out | **NOT PROVEN** — implemented client-side, no live send observed |
| Offline reconciliation | **NOT PROVEN** — hook exists, untested |
| Two-device matrix | **NOT RUN** |

No row is promoted because the code looks right.

## Live test matrix — **NOT YET RUN**

Harness: **`realtime-harness.html`** — open on two signed-in devices. Every row starts
`NOT RUN`; only an observed callback moves it. The page has no code path that marks a row
PASS from wiring alone.

Static certification (`scripts/test-realtime-multidevice.js`, **64 assertions**) proves the
**wiring**. It does not prove two devices converge. That needs two signed-in devices:

| Event | Device A | Device B | Device C |
|---|---|---|---|
| Product created | create | receives | receives |
| Product edited | edit | updates | updates |
| Inventory changed | sale | reflects | reflects |
| Order created | create | receives | receives |
| Order status changed | update | receives | receives |
| New message | send | receives | receives |
| Rider offer | seller sends | rider receives | seller sees state |
| Rider accepts | rider accepts | seller updates | others update |
| Payment state | authoritative event | merchant updates | POS updates |
| Notification read | A reads | others reconcile | unread count reconciles |
| **Offline reconnect** | A changes | B offline → reconnects | B reconciles from source, no replay |
| **Dedupe** | one sale | exactly ONE notification | not four |

Until this is run, convergence is **wired, not proven**.

---

## Rules that must hold

- Realtime is **not** broadcast. Every subscription carries its authorization scope —
  user, merchant, business, shop, role, order participation, rider relationship, admin scope.
- Never subscribe a client to a global collection to solve synchronization.
- Never use a notification as a substitute for convergence.
- One event → one notification, deduped by authoritative event id.
- Bounded, scoped listeners; unsubscribe when the context is gone.
- A merchant's unread count never renders on a customer-facing screen.
