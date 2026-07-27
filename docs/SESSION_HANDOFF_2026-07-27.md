# SOKONI — Session Handoff (2026-07-27)

Clean starting point for the next session/agent. Live production = **`mysokoni.co.ke`**
(Firebase Hosting, project `sokoni-aeb26`). Live SW at time of writing: **v130**.

> **Deploy discipline (read first):** ~20 concurrent agent worktrees deploy hosting;
> deploying from a stale one ROLLS BACK production. A predeploy guard
> (`scripts/deploy/guard-no-rollback.js`) now aborts any deploy behind live, but the
> durable fix is operational: **one deploy authority, always from latest.** See
> `AGENTS.md` / `CLAUDE.md` "Operational Guardrails".

---

## 0. Current state & deployment blocker (latest — read first)

- ✅ **Production:** RANK-1 owner-isolation fix is **live (SW v131)** — a signed-in
  account renders only its own listings; foreign cached listings cannot render,
  survive, or sync. (Commits `bbf5410` and earlier; fixes the reported "another
  seller's vapes on a service-provider account" leak.)
- ⏸ **Ready but NOT deployed:** commit **`1c0f164`** — OwnerCache foundation
  (`sokoni-owner-cache.js`, uid-namespaced storage) + removal of the fabricated
  `Math.random()` seller stats. Code is complete and syntax-verified; OwnerCache is
  unit-verified against the exact leak scenario.
- 🚧 **Operational blocker (NOT product code):** deployment of `1c0f164` is blocked
  by a **hanging predeploy gate** — `node scripts/gate-inventory.js` (wraps
  `node scripts/test-inventory.js --gate`). The process **hangs without producing any
  output** before deployment begins; it does not reach a check and does not implicate
  the changed files. The application code is verified; deployment could not proceed
  because of the pipeline. **Investigate and stabilize this predeploy gate before
  attempting further hosting deployments.**
- ▶️ **Next work, once the pipeline is fixed (in order):**
  1. Deploy `1c0f164`.
  2. Complete the **atomic OwnerCache migration** — move *every* `seller.js`
     products read/write + the hydrator (`sokoni-seller-products.js`) to OwnerCache
     together (partial migration causes stale-cache divergence), then retire the
     global `sellerProducts` key.
  3. Finish the **RANK-2 reader sweep** — `ministore.html`, `services.html`,
     `seller-analytics.html`, `business-analytics.html`, `car-hub.html`.
  3b. **Add a regression guard** (AFTER the migration, so it doesn't flag in-progress
     code): a CI/repo scan that FAILS on any direct `localStorage` read/write of a
     global owner key (`sellerProducts`, `sellerOrders`, `sellerDrafts`) outside
     `sokoni-owner-cache.js` — making `OwnerCache` the ONLY supported API for
     owner-scoped local data so this class of leak cannot quietly return. Start
     warning-only if legitimate stragglers remain.
  4. Verify the **seven owner-isolation release gates**: (1) seller A never sees
     seller B's cached listings; (2) a zero-product provider gets an empty state,
     not prior-seller data; (3) the owner's own unsynced drafts survive; (4) another
     owner's drafts are discarded; (5) account-switching cannot repopulate another
     user's cache; (6) every RANK-2 page shows only owner-scoped data; (7) no
     fabricated metrics remain on seller dashboards.
  5. Resume **Booking Phase 1c/2** (the money spine).

**Owner-isolation reference:** root cause = `sellerProducts` was a single global
localStorage key, never uid-stamped; the fix is `sokoni-owner-cache.js` (uid-namespaced
`sellerProducts:{uid}` behind one `OwnerCache` API). RANK-1 (render + hydrator filter,
seller.js / sokoni-seller-products.js) is live; RANK-2 readers + the atomic migration
remain. See the `project_startup_perf` sibling and the audit in this session.

The current bottleneck is the deployment pipeline — not the implementation or
uncertainty about what to do next.

---

## 1. Production changes shipped (with commit IDs)

| Commit | Change |
|---|---|
| `f77a601` | **Commerce integrity** — stop overselling (pre-charge qty guard + zero-floor deduction on both payment paths + `oversoldAlerts`), cart qty revalidation (`adjustedItems`), shop-name fan-out (`shop-name-sync.js` → Algolia+Typesense self-correct), Buy Now on category cards |
| `b09efdc` | Atomic `inventoryVersion` + `updatedAt` on every stock deduction; added to Algolia record |
| `08fcd70` | Admin gate fix — `security-center.html` gated only on numeric `claims.role`; now accepts boolean `admin`/`superAdmin` + force-refresh (granted `alexochieng3030@gmail.com` full super-admin: `{admin,superAdmin,role:5}`) |
| `13af614` | PWA — `earnings.html`/`plans.html` served stale (omitted `sw-register.js`); added it |
| `71fa0a6` | PWA systemic — `shared-header.js` now injects `sw-register.js` (self-update coverage 118→~313 pages) + **rollback guard** predeploy hook |
| `4f0992b` | **Guardrails** — `CLAUDE.md` "Operational Guardrails" + new `AGENTS.md` (merged to `main` via PR #13, so new sessions inherit them) |
| perf set | inline dark bg on index/category/product/search/checkout (no white flash); checkout IntaSend SDK `defer`; `sokoni-image.js` defer; Firebase `modulepreload`; **inline skeletons** (`cc87e3f`) |

All deployed and verified live. PR #13 (`fix/algolia-batch-poisoning` → `main`) **merged** — `main` now reflects production.

---

## 2. Performance work (kept / reverted / deferred)

Measured with a Playwright harness (cold, mobile, 4G + 4× CPU, median of 3). Harness +
CLS probe in session scratchpad. Baseline: FCP 3136 / LCP 7744 / TTFP 9495 / CLS 0.132 /
**TBT 14290ms** / 859KB-88 JS files. **Dominant bottleneck = startup JS**, not network.

- **KEPT:** inline skeletons → **LCP −55% (7.7s→3.5s), FCP −31%, TTFP −40%.** Also dark-instant paint, deferred checkout SDK, Firebase modulepreload.
- **REVERTED:** hero `min-height:68px` — CLS probe proved 0 effect (wrong node); removed (`615eb78`).
- **NOT SHIPPED:** P2A idle-loading (rescheduling ≠ removing → TBT flat); P2B `.limit()` on home listener (would drop paid boosted ads — needs boosted-aware design).
- **DEFERRED:** Hero CLS (~0.096, pre-existing) — source is `glass-hero`/`glass-hero-bg`/`#storiesSection` at ~8.6s, NOT the stat row. Next step: instrument the actual mutation before fixing. See `project_startup_perf` memory.

---

## 3. Authentication / profile state

- New-account **profile↔login loop FIXED** (`f8821cb`) — never gate a session on profile metadata (`isLoggedIn` required `u.name`).
- Centralized idempotent **`ensureUserBaseline`** bootstrap (`b5823ea`, on profile.html).
- `118af4b` — stop bouncing signed-in users to home; delete/deactivate reliable.
- Email + phone **verification in the Security panel** (`e784f34`) — first slice only.
- **OPEN:** single auth-state source (the `sokoni-permissions` App-Check loop, intermittent), server migration, broader `ensureUserBaseline` include, and a **Firestore rules ownership audit**.

---

## 4. Booking engine state

- 45 onCall handlers → **`bookingDispatch`** (deploy that name). Atomic slot lock + 8-modifier pricing.
- **Phase 2 waitlist DEPLOYED 07-27** — availability-as-inventory, offer=HOLD, `waitlistEnabled` gate. slotLock-release latent bug FIXED; per-customer cap now txn-counter burst-safe; emulator harness 24/24 (cached JAR on JDK17).
- `capacity.concurrent` still optimistic (deferred).
- **Pricing convergence STAGED but flagged/unshipped** — `pricing-schema.js` (one canonical `compute()`/`normalize()`), `bookingCreate` prices via it; proven byte-identical to live `_calcPrice` (90/90). Needs the client flip + end-to-end validation.

---

## 5. Open issues

- **Owner-isolation audit** (Phase 1, next milestone) — verify every profile/shop/listing/wallet/booking/dashboard is loaded & writable by the authenticated UID only; remove remaining demo/KASS fallbacks from authenticated flows; audit `firestore.rules` for server-side ownership enforcement.
- **Merchant verification** (Phase 2) — only email/phone shipped; document upload → pending review → admin approve/reject + reasons → resubmission → verified badge → status surfaced marketplace-wide is greenfield.
- **Booking client convergence** (Phase 3) — flip the client to the unified pricing engine + validate lifecycle/settlement.
- **Hero CLS (~0.096)** — deferred perf item (see §2).
- **Concurrent-deploy churn** — pollutes measurements; needs single deploy authority.

---

## 6. Release gates / infra notes

- Rollback guard live (predeploy). SW freshness = network-first + bump-sw-version + shared-header injection. `version.json` carries live commit.
- Transient firebase-tools "Body is unusable" upload error recurs — clears on plain retry.
- Legal enforcement OFF (engine canonical, pending device validation). ODPC registration paid, cert not issued — don't overstate.

---

## 7. Recommended next milestone: **Owner Isolation & Merchant Verification**

Then DJ BAMBINO booking workflow (a real logged-in provider) as the production-critical
booking milestone: reliable Book button (correct provider id, live rate cards, no demo
fallback), provider rate-card CRUD, provider booking controls (confirm/reject/no-show/
complete/cancel), availability management, and server-side booking→wallet settlement —
all owner-scoped by authenticated UID, wallet credit computed server-side.

_Audit for this milestone was kicked off at handoff (Book-button/rate-cards, booking→wallet/
dashboard/availability, and provider/booking/wallet ownership rules) — see the next session's
findings before implementing._
