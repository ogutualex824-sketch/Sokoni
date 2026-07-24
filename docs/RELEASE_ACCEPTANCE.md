# SOKONI — Release Acceptance

**Single source of truth for release readiness.** A row is only ✅ when there is
evidence a human or a test *demonstrated* it — not when the code exists.

Last updated: 2026-07-24 · against commit `7a6749c`

## Status legend

| Symbol | Meaning |
|---|---|
| ✅ | **Verified** — demonstrated end-to-end with evidence recorded |
| 🟡 | **Logic verified** — covered by an automated test, not yet run against production data |
| 🟠 | **Static review only** — code + rules + indexes read and reasoned; no execution |
| ⏳ | **Runtime pending** — needs an authenticated session / device to confirm |
| 🚫 | **Blocked** — cannot proceed until a named dependency is resolved |
| ❌ | **Failed** — demonstrated not to work |

> **Rule of this document:** "implemented" never silently becomes "verified".
> Moving a row up a level requires new evidence in the Evidence column.

---

## Acceptance matrix

| Area | Status | Evidence | Last verified | Owner | Blocking issue |
|---|---|---|---|---|---|
| **Search — matching logic** | 🟡 Logic verified | `npm run test:search` 23/23 (exact, typo, Swahili↔EN, suggest, scan-window, cache-poisoning) | `7a6749c` | Search | — |
| **Search — customer-facing (live)** | ✅ **Verified** | Live browser against production: `cool mint` 3 hits, `vape` 20, `kass` 24. Precise statement: *customer-facing search functionality is verified, and Algolia is verified independently — but an individual client may temporarily serve via the Firestore fallback while its persisted breaker is active* (see cross-cutting table) | 2026-07-24 | Search | — |
| **Search — Algolia backend** | ✅ **Verified** | App `F2XND3V1FW`; 8 indexes; 129 records; search-only key issues correctly; `searchHealth` → `status: ok, HEALTHY, 364ms` | 2026-07-24 | Search | — |
| **Search — Typesense backend** | 🚫 Blocked (non-gating) | Cluster hostname does not resolve — `DNS_FAILURE`, confirmed from inside Google's network. Marked `required: false`; does not affect `status` | 2026-07-24 | Infra | Cluster deleted/renamed/never created? |
| **Search — cold start** | 🟠 Static review only | Algolia probe budgeted 1.5s; Firestore runs in parallel | — | Search | Unthrottled measurement |
| **Search — warm cache** | 🟠 Static review only | localStorage catalogue + SWR; in-page match ~1ms (`suggest`) | — | Search | Unthrottled measurement |
| **Product — create** | 🟠 Static review only | Write path proven against rules (see §Write-path P1) | — | QA | Seller session |
| **Product — edit** | 🟠 Static review only | Shared field schema; update rule forbids `sellerUid` change | — | QA | Seller session |
| **Product — delete / soft-delete** | 🟠 Static review only | `isVisible:false` / archived status honoured by search + realtime | — | QA | Seller session |
| **Product — search reflects change** | 🟠 Static review only | `indexProductCreate` deployed; Firestore fallback scans live docs | — | QA | Seller session + phone |
| **Shop — create** | 🟠 Static review only | Server-created (`automation-engine`); owner-update allowlist (see §Write-path P2) | — | QA | Seller approval flow |
| **Shop — edit** | 🟠 Static review only | `/shops` update rule limits to presentation fields | — | QA | Seller session |
| **Shop — discovery / store page** | 🟠 Static review only | `/shops` now readable; product-derived fallback when doc absent | — | QA | Phone |
| **Orders — place** | 🟠 Static review only | Checkout create payload satisfies `claimsOwner`+`clientOrderInit`+`validOrderStatus` (see §Write-path P3) | — | QA | Buyer + seller session |
| **Orders — inventory deduction** | ⏳ Runtime pending | Server-side; not statically traced this pass | — | Payments/QA | Multi-session + payment |
| **Orders — seller notification** | 🟠 Static review only | `index.html` listens `orders where sellerUid` — needs `createdAt` (written ✓) | — | QA | Seller session |
| **Orders — buyer history** | 🟠 Static review only | `SokoniDB.listenUserOrders` filters `uid` (written ✓) | — | QA | Buyer session |
| **Order timeline** | 🟠 Static review only | `orderEvents` rule added this cycle; append-only, participant-scoped | — | QA | Buyer session |
| **Services — list/detail** | 🟡 Logic verified | Guarded query (`status in active/published`); collection empty in prod | — | QA | Seed data + session |
| **Reviews — submit** | 🟡 Logic verified | Rewired to `submitReview` CF; rule requires `uid`+`status` — CF supplies both | `7a6749c` | QA | Buyer session |
| **Reviews — display** | 🟡 Logic verified | `getReviews` CF (`status==approved`); card renderer accepts both shapes | `7a6749c` | QA | Buyer session |
| **Requests — entertainment** | 🟠 Static review only | `entRequests` rule added; write sets `uid`+`status` | — | QA | Session |
| **Requests — package/delivery** | 🟠 Static review only | `packageRequests` rule pre-existing; owner-scoped | — | QA | Session |
| **Appointments (healthcare)** | 🟠 Static review only | **Fixed 2026-07-24:** 15 CFs deployed (HTTP 401 = live + App-Check-gated); `saveAppointment`→`bookAppointment` CF; teleconsult/lab routed to own collections; 4 indexes added. **Provider seeded + verified** (1 active bookable) | 2026-07-24 | QA | Patient session only |
| **Properties — create/discovery** | 🟠 Static review only | **Fixed 2026-07-24:** auto-activate on create (`status:'active'`); listing now visible to buyers immediately | 2026-07-24 | QA | Session |
| **Vehicles / Jobs** | 🟠 Static review only | Rules gate on `status`; write paths set `status` | — | QA | Session |
| **Inventory sync** | ⏳ Runtime pending | Tenant-scoped `tenants/{id}/inventory_products`; `stockLevel`+`updatedAt` written | — | QA | Multi-session |
| **Payments (IntaSend)** | 🚫 Blocked | Not touched this cycle; webhook verification + replay pending | — | Payments | Webhook replay |
| **Account — buyer** | ⏳ Runtime pending | — | — | QA | Buyer session |
| **Account — seller** | ⏳ Runtime pending | — | — | QA | Seller session |
| **Account — admin** | ⏳ Runtime pending | Admin dashboards were denied (no rules); rules added this cycle | — | QA | Admin claim |
| **Premium / trial display** | ⏳ Runtime pending | — | — | QA | Entitlement session |
| **Mobile — iPhone Safari** | ⏳ Runtime pending | — | — | QA | iPhone device |
| **Mobile — Android Chrome** | ⏳ Runtime pending | — | — | QA | Android device |
| **PWA — install / update flow** | ⏳ Runtime pending | SW cache version bumped this cycle | — | QA | Fresh install/update |

> **Read the roll-up correctly.** "1 🚫 remaining" counts *known* blockers — the
> ones already identified. It does **not** mean the platform is one fix from
> green. Every 🟠 and ⏳ row is **unverified**, not presumed-passing: an
> authenticated run is an evidence-gathering exercise whose job is to *discover*
> failures, and some of what it finds will not match any mapped cause. Treat a
> green run as the good outcome, not the expected one. The blocker count only
> becomes a countdown once the runtime rows are actually ✅.

**Roll-up (2026-07-24):** **2 ✅** · 5 🟡 · 17 🟠 · 6 ⏳ · 2 🚫 · 0 ❌
*(The first two ✅ rows are search — the only flows demonstrated end-to-end
against production so far. One 🚫 is Typesense, explicitly **non-gating**; the
gating one remains payments.)*
Nothing is release-verified yet. The bulk is statically sound and awaiting the
runtime evidence only an authenticated session, a real device, or an unthrottled
client can provide. Two blockers cleared this cycle: healthcare appointments
(CF cluster deployed) and the property visibility trap (auto-activate); the one
remaining 🚫 is payments (IntaSend webhook).

---

## Write-path proof obligations (Pass 2)

Each lifecycle is traced: **client action → validation → write → required fields
→ rule allows → indexes support read-back → listeners observe → search sync.**
The critical question at each step is *"is every field a later query filters,
orders, or gates visibility on guaranteed to be written?"*

### P1 · Products — 🟠 sound, with one benign gap

- **Write:** `seller-wiring.js::_writeProduct` / `SokoniDB.saveProduct` →
  `products/{id}`. Populates `id, name, price, sellerUid, category, location,
  description, image, stock, uploadedAt, _syncedAt`.
- **Rule:** create requires `sellerUid == auth.uid` ✅ (written), `validPrice('price')`
  ✅, `noAdminFields()` ✅ (payload carries none), `withinProductLimit()` — cap
  applies; a seller at the limit is denied (expected).
- **Visibility:** payload does **not** write `status`/`isVisible`. Correct under
  the platform contract (absent = visible). Verified no query filters
  `isVisible == true` (which would wrongly exclude absent-status docs).
- **Search sync:** `searchableTerms` + `nameLower` are **not** client-written —
  `indexProductCreate` (deployed, `functions/index.js:7551`) writes them on
  create. Firestore fallback also scans live docs, so a product is findable even
  before the trigger runs.
- **Gap (benign):** no `createdAt` is written (only `uploadedAt`). Product
  display sorts client-side, so nothing breaks — but any future
  `orderBy('createdAt')` on `products` would silently drop every existing
  document. Noted, not fixed.

### P2 · Shops — 🟠 sound

- **Write:** created by `automation-engine.js` on seller approval; owner edits via
  `/shops` update rule (presentation-field allowlist; `status` excluded to
  prevent self-approval).
- **Read-back:** `store.html` reads `/shops` then `/sellers`; when both absent it
  now derives name/logo/location from the seller's own products.
- **State:** `/shops` empty and `/sellers` empty in production — store identity
  currently rides entirely on the product-derived fallback.

### P3 · Orders — 🟠 sound (create path proven)

- **Write:** `checkout.html` → `setDoc(orders/{id})` with `uid, buyerUid,
  sellerUid, items, pricing, status:'pending_payment', statusHistory, createdAt`.
- **Rule:** `claimsOwner()` needs `uid == auth.uid` ✅; `clientOrderInit()` forbids
  `escrow/paymentVerified/inventoryApplied/…` at create — checkout **deliberately
  omits `escrow`** (documented inline) ✅; `validOrderStatus()` allows
  `pending_payment` ✅.
- **Read-back:** buyer history filters `uid` ✅ written; seller listener filters
  `sellerUid` ✅ written and orders by `createdAt` ✅ written (serverTimestamp).
- **Note:** a second creator, `sokoni-orders.js::createOrder`, writes `escrow` at
  create and would be **denied** by `clientOrderInit`. Checkout does not use it
  (it calls `transitionOrder` instead), so it is effectively dead on the client;
  flagged so it is not wired in later by mistake.

### P4 · Reviews — 🟡 logic verified (this cycle)

- Submit and read go through `submitReview`/`getReviews` CFs. CF stamps
  `authorUid` + `status:'approved'`; read rule requires exactly those. Direct
  client writes (old path) could never satisfy the rule — replaced.

### P5 · Healthcare appointments — 🟠 wired end-to-end (2026-07-24)

- **Was:** `functions/healthcare-hub.js` (15 CFs) never exported from
  `index.js`; `/healthAppointments` `write:false`; the UI funnelled doctor
  visits, teleconsults AND lab tests all through `saveAppointment` → a denied
  direct write. No valid create path existed.
- **Now:** all 15 CFs deployed (verified HTTP 401 = live + App-Check-gated).
  `saveAppointment` calls the `bookAppointment` CF (slot-lock + idempotency, the
  appointment id doubling as the idempotency key); status changes route through
  `updateAppointmentStatus` (releases the slot lock on cancel/complete).
  Teleconsult → `saveTelemedicine`, lab → `saveLabBooking` (their own
  owner-writable collections). `getMyAppointments` filters status in memory to
  avoid a 3-field index; the two required 2-field composites
  (`patientUid+dateTime`, `providerId+dateTime`) are deployed.
- **Runtime prerequisite — satisfied.** Booking requires an **active**
  `healthProviders` doc. Seeded and verified 2026-07-24:
  `seed-provider-general-001` (Dr. Amina Wanjiru, general_practice, KES 1500,
  Nairobi), created by `scripts/seed-health-provider.js --apply` and confirmed by
  query (1 active bookable provider). Tagged `isSeed:true` — remove before public
  launch. Two further indexes added for the provider directory
  (`status+rating`, `status+specialization+rating`).
- **Remaining to verify — the appointment acceptance sequence.** Steps 1–5 are
  sequential; step 6 is the one that actually proves the guarantee.

  | # | Action | Expected | A failure here means |
  |---|---|---|---|
  | 1 | Book a slot as an authenticated patient | Appointment created, `status:'pending'` | CF/auth/App Check path broken |
  | 2 | Book the **same 30-min slot** again | Refused — `resource-exhausted`, "already booked" | The slot lock is not being enforced |
  | 3 | Cancel the appointment | `status:'cancelled'`; `healthSlotLocks/{providerId}_{slotKey}` deleted | `updateAppointmentStatus` not releasing the lock |
  | 4 | Re-book the same slot | Succeeds | Lock released but not reusable — stale lock |
  | 5 | Open patient history | Both operations reflected | `getMyAppointments` / index problem |
  | 6 | **Two clients book the same slot within milliseconds** | **Exactly one succeeds**; the other gets `resource-exhausted`; exactly **one** appointment doc, **one** lock doc, `totalAppointments` incremented **once** | Transaction is not serialising — a real double-booking defect |

  **Static analysis of step 6 (reasoned, not executed).** The invariant should
  hold: `bookAppointment` reads `healthSlotLocks/{providerId}_{slotKey}` *inside*
  `runTransaction`, which places it in the transaction's read-set. Under
  Firestore's optimistic concurrency the second committer detects the lock
  document changed since its read, retries, re-reads it as existing, and throws
  `resource-exhausted`. The `HttpsError` is user-thrown rather than a contention
  error, so it aborts cleanly instead of retrying forever, and the outer catch
  re-throws it intact (`err.httpErrorCode` is set). `totalAppointments` uses
  `FieldValue.increment`, applied once per committed transaction.
  Requires **two authenticated clients** — not exercisable from the dev machine
  (no test patient credentials; App Check throttled). Until step 6 runs, the
  concurrency guarantee is *reasoned*, not *verified*.

  **Latent trap (not currently reachable):** the idempotency key is the
  client-generated appointment id. If a caller ever reuses a key after
  cancelling, `bookAppointment` short-circuits on the idempotency record and
  returns the **cancelled** appointment instead of booking a new one. The UI
  resets `_apptId` on modal open/close so every attempt gets a fresh key — the
  safety currently rests on that UI convention, not on the CF. Worth a
  server-side guard if booking is ever driven by another client.

### Write-path risks flagged

- ~~Property/BnB create-visibility trap~~ — **resolved 2026-07-24** (auto-activate).
- **Duplicate `propertyListings` rule blocks** (`firestore.rules` lines ~4101 and
  ~4886). Firestore unions `allow`, so this is permissive-safe but a maintenance
  hazard — the two blocks disagree on accepted statuses. Consolidate. Still open.

### Not traced this pass (honest gaps)

Services, entRequests, packageRequests, vehicles, jobs, appointments, inventory
and users had their **rules** reviewed but their full client→field→listener
chain was not walked end-to-end. They are 🟠/⏳ accordingly, not 🟡.

---

## Diagnostic journeys — failure → likely cause

These tables exist so a red result points at a cause instead of "it's broken".
Every cause below is grounded in a rule, trigger or code path read during the
write-path audit — not speculation. If a failure doesn't match any row here,
that itself is information: it's a defect class we haven't mapped.

### Journey A · Seller (highest leverage — run first)

| # | Action | Expected | A failure here most likely means |
|---|---|---|---|
| 1 | Register / log in as seller | Session established, lands on seller dashboard | Auth guard: `auth.js::_alreadyLoggedInGuard` is gated to login/signup pages — if a content page bounces you home, that gate has regressed |
| 2 | Create shop | Shop saved | **Expect `sellers/{uid}`, not `shops/{uid}`.** `/shops` create is admin/CF-only (written by `automation-engine` on approval). A client "create shop" writes `sellers/{uid}` |
| 3 | Edit shop | Changes persist | `/sellers` update needs owner + `noAdminFields()`; `/shops` update is restricted to a presentation-field allowlist (`status` deliberately excluded — self-approval guard) |
| 4 | View store page | Name/logo/location render | `/shops` + `/sellers` are both empty in prod → the page falls back to product-derived identity. Blank name = seller has no products *and* no shop doc |
| 5 | Create product | Product saved | Create rule needs `sellerUid == auth.uid`, `validPrice('price')`, `noAdminFields()`, `withinProductLimit()` — a silent failure is usually the product cap or an invalid price |
| 6 | Edit product | Changes persist | Update rule forbids changing `sellerUid`; any payload echoing a different seller is rejected wholesale |
| 7 | **Product appears in search** | Findable by name | Was a known false negative — the warm catalogue cache (10 min session / 30 min disk) served a pre-write scan. **Fixed 2026-07-24:** product writes now call `invalidateScanCache('products')`. If it recurs, that invalidation didn't fire |
| 8 | Search by shop name | Shop's products returned | Products carry `sellerName`/`businessName`; a shop with neither on its products is unfindable by shop name |
| 9 | Inventory reflects it | Stock visible | Inventory is **tenant-scoped** (`tenants/{id}/inventory_products`, field `stockLevel`) — a *separate* system from the public `products` catalogue (`stock`). Divergence here is expected, not a bug |
| 10 | Dashboard counts update | Totals correct | Seller order listener filters `sellerUid` + orders by `createdAt` (both written) |

### Journey B · Buyer

| # | Action | Expected | A failure here most likely means |
|---|---|---|---|
| 1 | Search + open product | Product page loads | Search path: Algolia is down (credentials) → Firestore answers. A console line naming the fall-through is normal today |
| 2 | Add to cart → checkout | Order created | Create rule needs `claimsOwner()` (`uid == auth.uid`), `clientOrderInit()` (**must not carry** `escrow`/`paymentVerified`/`inventoryApplied`), `validOrderStatus()`. A rejected create almost always means a server-owned field leaked into the payload |
| 3 | Payment | — | 🚫 Blocked on IntaSend webhook — expect this to fail until replay is confirmed |
| 4 | Order appears in history | Listed | `listenUserOrders` filters `uid`; written by checkout ✅ |
| 5 | Order timeline | Events render | `orderEvents/{orderId}/events` is participant-scoped and append-only (rule added 2026-07-24). Empty timeline = `_writeEvent` denied, i.e. caller isn't a recognised participant |
| 6 | Leave a review | Accepted | Goes through `submitReview` CF, which requires a **completed/delivered** order when `orderId` is supplied, enforces 1-per-target and 3/day. "Already reviewed"/"complete an order first" are correct refusals, not bugs |
| 7 | Review displays | Visible | `getReviews` returns `status == 'approved'` only; the CF auto-approves, so an invisible review means the CF didn't run |

### Testing asynchronous paths — match the observation window to the execution window

Two of the defects "found" during this session were artefacts of testing an
asynchronous process **before its scheduled execution had run**. Observing a
5-minute drain at 75 seconds does not demonstrate failure; it demonstrates that
the observation was early.

Before concluding that an async path is broken, establish its execution window
and wait past it. For SOKONI's search pipeline:

| Stage | Timing |
|---|---|
| Firestore write | immediate |
| `algoliaSync_*` trigger → `algoliaQueue` | seconds |
| `processAlgoliaQueue` drain | **scheduled `every 5 minutes`** |
| Algolia searchable | shortly after the drain |

A certification probe must therefore wait **>5 minutes per transition** (the
corrected probe uses 330s). Any probe that writes to production must also purge
its artefact from **both** Firestore *and* the index on every exit path —
a Firestore-only cleanup leaves an orphan in Algolia when delete-sync is the
very thing under test.

### Cross-cutting causes (check these before filing a defect)

| Symptom | Very likely cause |
|---|---|
| *Everything* Firestore returns permission-denied, including `products` (`read: if true`) | **App Check throttling** on that client (403, ~24h backoff). Not a rules problem. Verify on a different device before investigating |
| A whole collection silently returns nothing | A list query missing the `where()` clause its rule requires → denied wholesale. Run `npm run scan:guards` |
| Search finds nothing platform-wide | Algolia credentials rejected → Firestore path. Check the persisted breaker `localStorage['sokoni_search_engine_down_v1']` |
| A just-written record isn't searchable | Warm catalogue cache not invalidated for that collection |
| **Search works, but results come from Firestore rather than Algolia — despite Algolia being healthy** | A **stale persisted breaker**. Any client that searched while Algolia was mis-configured (before 2026-07-24) tripped `localStorage['sokoni_search_engine_down_v1']`, which skips Algolia for **6 hours**. It self-heals on expiry; clear immediately with `localStorage.removeItem('sokoni_search_engine_down_v1')`. Results stay correct throughout — only the serving path differs, so this is a *performance/attribution* symptom, not a correctness one |
| `searchHealth` shows `redundancy: degraded` | Expected and correct while Typesense is unprovisioned. `status: ok` is the customer-impact signal — do not escalate on `redundancy` alone |
| **A just-saved shop/service/product is not in Algolia results yet** | **Expected — indexing is eventually consistent.** `processAlgoliaQueue` drains on a `every 5 minutes` schedule (`algolia-queue.js:158`), a deliberate cost trade-off. Firestore and the UI update immediately; Algolia catches up within ~5 min. **Do not diagnose before that window has elapsed** — a check at 75s produced two phantom "sync failed" findings that the evidence later contradicted |

## Mandatory question for every row: does it fail *transparently* or *convincingly*?

**Before a row may reach a passing status, answer this:**

> If this subsystem fails in production, does the product fail **transparently**
> (visible error, logged cause, operator signal) or **convincingly** (it still
> looks like it worked)?

If the answer is **convincingly**, the row is not ready — regardless of whether
the happy path passes. Fix the failure mode, then re-assess.

**Why this is mandatory and not advisory.** Two production defects found on
2026-07-24 shared one characteristic, and neither was catchable by uptime checks,
page-load tests, or HTTP status monitoring — every one of those stayed green:

| Defect | What actually happened | What it looked like |
|---|---|---|
| GDPR data export | Job died at signed-URL generation; the cause went only to Cloud Logging | status `failed`, no reason — indistinguishable from a user error |
| Public storefront | App Check rejected, Firestore denied, catalogue listener never ran | a fully-populated shop — of products that do not exist |

Both were **observability failures before they were implementation failures**.
The storefront one is the sharper lesson: the demo fallback converted a total
catalogue outage into a healthy-looking marketplace, which is precisely why it
survived undetected. A failure that renders convincingly will not generate a
support ticket, an alert, or a bug report.

**Apply to every critical path** — payments, search, auth, sync, exports,
notifications, inventory. For each, the acceptable answers are: surface an
explicit degraded state, serve real cached data clearly marked as stale, or fail
loudly with a logged cause. **Never substitute fabricated data for real data**,
and never let a caught exception become an ordinary-looking empty state.

Related: [[KNOWN_LIMITATIONS]] items 0b, 0e.

## How to advance a row

1. Perform the action in a real session/device.
2. Record what proved it in **Evidence** (test id, screenshot, log line, commit).
3. Set **Last verified** to the commit under test.
4. Only then change **Status**.

Runtime passes that would clear the most rows, in order of leverage:
1. One authenticated **seller** session → product + shop + services + inventory
   + search propagation + dashboard counts.
2. One authenticated **buyer** session → order + review + request + history.
3. One authenticated **patient** session (+ a second client for step 6) →
   the appointment sequence above.
4. One **phone** (each OS) → mobile + PWA + real-world search.
5. **Unthrottled client** → search latency numbers.
6. **Live IntaSend webhook replay** → payments, the last 🚫.

A final regression pass belongs after 1–3 and 6 complete, not before: each
journey changes state the others read.
