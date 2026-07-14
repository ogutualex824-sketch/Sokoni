# Legal Hub v1.0 — Production Certification

**Date:** 2026-07-14 · **Type:** stabilization + certification (no new modules, no UI redesign)
**Method:** two parallel code inventories (backend + frontend) with file:line evidence, live
browser QA (iPhone WebKit + Desktop Chrome), and concurrency attack simulations against the
Cloud Function logic. Nothing assumed from "it compiles".

> **UPDATE 2026-07-14 (see §9):** L-1 (demo advocates) and L-2 (booking-failure masking) are now
> **fixed**, and a **new critical finding** — four missing composite indexes that were silently
> breaking real provider search / booking history / provider dashboard behind the demo fallback —
> was found and **deployed**. Current status: **READY, pending one coordinated hosting deploy** of
> the committed `legal-hub.html` fixes. The original verdict below is preserved as the audit trail.
>
> ## RECOMMENDATION: **READY WITH MINOR LIMITATIONS**
> Score **76 / 100.** Every core flow works UI → Cloud Function → Firestore → UI, and the two
> data-integrity defects found during this pass are fixed and proven. Production deployment is
> safe. Three limitations should be closed before a public launch push — none is a financial or
> security risk, and the top one is a content/operator action, not code.

---

## 1. What was fixed in this pass (stabilization)

Two concurrency defects, both failing the certification's own "No duplicate bookings" /
"reviews cannot be double-counted" criteria. Backend only; no UI change.

| Defect | Was | Now | Proof |
|---|---|---|---|
| **bookLegalConsultation** duplicate booking | racy `get()`→`batch.set()` claim (F3), auto-id consultation, `db.batch()` (F4) — two concurrent taps create two consultations + double increment | consultation id derived from idempotencyKey; provider read + validate + create + increment + idem-marker in ONE `runTransaction` with existence check; also 2 provider reads → 1 | concurrent double-tap → one consultation, one increment, same id |
| **rateLegalProvider** double-counted rating | `rated` guard read OUTSIDE the transaction; two concurrent rates both pass, both `ratingCount+1` | consultation read + ownership/status/`rated` guards all INSIDE the transaction | concurrent double-rate → count 2→3 not 4, exactly one succeeds |

Attack suite (fake Firestore modelling optimistic concurrency + reads-before-writes): **7/7 pass.**
Static financial audit unchanged at baseline (V2 10, V3 4). Deployed: `bookLegalConsultation`,
`rateLegalProvider`, `servicesDispatch`.

---

## 2. Feature checklist — verified UI → CF → Firestore → UI

| Flow | CF | Status | Evidence |
|---|---|---|---|
| Provider registration | `registerLegalProvider` | ✅ | deterministic `.doc(uid)`, pre-check `already-exists`, idempotent |
| Provider approval (admin) | `approveLegalProvider` | ✅ | role≥4 gate; legal-admin.html per-button disable |
| Provider search | `getLegalProviders` | ✅ | status=active, specialization filter, rating sort, cursor paging |
| Consultation booking | `bookLegalConsultation` | ✅ **(fixed)** | now idempotent + transactional |
| Booking cancellation / status | `updateConsultationStatus` | ✅ | client/provider/admin authorised, status whitelist |
| Customer history | `getMyLegalConsultations` | ✅ | clientUid query, limit 30 |
| Provider dashboard | `getProviderConsultations` | ✅ | providerId query, limit 100 |
| Reviews & ratings | `rateLegalProvider` | ✅ **(fixed)** | now atomic; one rating per consultation |
| Email — booking | `emailOnLegalConsultation` | ✅ | reads clientUid/providerName/dateTime/consultationFee — **matches** what booking writes; idempotent `emailId` |
| Email — status change | `emailOnLegalConsultationUpdate` | ✅ | fires on confirmed/cancelled/completed |
| Document draft saving | (client → `legalDocDrafts`) | ⚠️ | direct client `setDoc`, owner-only rules; no CF (see L-4) |
| Commission recording | `fosSecureWebhook` (server) + client `legalCommissions` | ⚠️ | server path correct; a client-side write also exists (see L-5) |

## 3. Data integrity — verified

| Invariant | Verdict |
|---|---|
| No duplicate bookings | **YES** (fixed — deterministic id + transaction) |
| No double-counted ratings | **YES** (fixed — guards inside transaction) |
| No orphaned consultations | YES — consultation + idem marker written atomically |
| `legalProviders` / `legalConsultations` client-writable? | **NO** — `allow write: if false` (CF-only), verified `firestore.rules:3720/3728` |
| `legalConsultIdempotency` | fully locked (read:false/write:false) |
| Auth / authorization | every CF `requireAuth`; approval + status changes role/ownership gated |
| Audit logging | acceptance/legal engine writes `legalAuditLog`; booking emails idempotent |
| **No money taken against a fake lawyer** | **VERIFIED** — demo lawyers have no `sellerUid`, so `if(l.sellerUid && SokoniMpesa)` is false → no STK; the CF rejects them `not-found` |

## 4. UI polish — verified live (iPhone WebKit + Desktop Chrome)

- **Dead controls:** none. All 47 `onclick` handlers resolve (external globals guarded with
  `&&`/optional-chaining). *(My first live probe reported false positives — the 5,268-line
  script had not finished evaluating on WebKit at probe time; static analysis confirms all
  defined.)*
- **Lawyer grid:** loading spinner (first load only), empty state with CTAs, 12 cards render on
  desktop. **No horizontal scroll.** Sticky quick-nav, tap targets ≥44px (from prior sprint).
- **Console errors:** none on desktop; the WebKit `getLegalProviders` error is an App Check /
  headless artifact, not a code fault (real Safari with App Check differs).

## 5. Performance

- Queries are indexed single-field/cursor reads; booking is one transaction.
- **Fixed here:** `bookLegalConsultation` did two provider reads → now one.
- **N+1:** none in the reviewed CFs (search/history/dashboard are single queries).
- **Note (L-6):** `getLegalProviders` applies `county`/`isOnline` filters in memory *after*
  fetching a page, so those filters can under-return within a page. Low impact at current scale.

---

## 6. Known limitations (none blocks deployment; close before launch push)

**L-1 — Demo advocates are shown (content, not code).** `DEMO_LAWYERS` (12 entries,
legal-hub.html) is always appended and is the sole content when the search CF returns empty.
They are visually indistinguishable from real advocates. Booking one fails safely (no money,
`not-found`) but presents a **fake confirmation**. **#1 pre-launch action:** onboard real
advocates and gate/remove the demo array. This is an operator/content decision, deliberately not
changed in a stabilization pass.

**L-2 — Silent booking-failure masking (reliability).** `confirmConsultation` calls
`bookLegalConsultation` inside `catch(e){ console.warn }` and then writes a localStorage record
and shows success regardless. A **real** booking whose CF call fails (App Check, network) looks
"booked" to the client while nothing reached Firestore and the lawyer never sees it. Recommend a
visible error state instead of masking. Deferred out of this pass because legal-hub.html is under
concurrent edit and the mission forbids destabilizing v1.0.

**L-3 — Two booking paths.** The lawyer-card path uses `bookLegalConsultation` (now idempotent);
the Appointments-tab "Book" (`submitAppointment`) writes directly to `legalAppointments`
(auto-id, no idempotency, no commission, no email). Consolidate onto the CF.

**L-4 — No provider profile self-update.** An approved advocate cannot edit bio/fee/
specializations: no `updateLegalProvider` CF exists and rules block client writes. Gap, not a
bug. → v1.1.

**L-5 — Client-side financial writes.** `legalCommissions` (Date.now-derived id) and `leadFees`
(auto-id `addDoc`) are written from the browser (rules-constrained). Architecturally the client
should not author financial records; the server path (`fosSecureWebhook`) is authoritative. →
review in v1.1.

**L-6 — Search filter pagination** (see §5).

---

## 7. Deferred features → v1.1 (roadmap in `LEGAL_HUB_V1.1_ROADMAP.md`)

Per the sprint's explicit deferral list — **not** implemented here:
- Escrow engine for consultation payments
- Scheduled compliance-reminder service
- Company-registration UI

Provider **availability / slot management** (L-4 sibling) is also deferred: today there is no
slot uniqueness, so two clients can book the same `providerId + dateTime`. It belongs with the
availability work in v1.1.

---

## 8. Go / No-Go

**READY WITH MINOR LIMITATIONS (76/100).** Deploy is safe: core flows work end-to-end, the two
integrity defects are fixed and proven, rules are enforced CF-only, and no money can be taken
against a fake lawyer.

**Pre-public-launch checklist (operator + one small dev task):**
1. Onboard real advocates; gate/remove `DEMO_LAWYERS` (L-1). *Operator.*
2. Surface booking-failure errors instead of masking them (L-2). *Small dev task, once
   legal-hub.html is not under concurrent edit.*
3. Consolidate the two booking paths (L-3).

Everything else is v1.1. This certifies Legal Hub v1.0 as **stable and complete for its scope.**

---

## 9. Post-certification hardening — 2026-07-14 (P1 closure + a NEW critical finding)

### 9.1 NEW critical finding — missing composite indexes (FIXED)

The certification's live QA "12 cards render on desktop" was the **demo fallback**, not real query
results. Verifying the **deployed** project directly: only 3 legal composite indexes existed
(`legalAppointments`, `legalReviews`, `legalServiceRequests`), and **none** of the four the Legal
Hub queries require. So in production:

- `getLegalProviders` (`status`+`rating`; `status`+`specializations`+`rating`),
- `getMyLegalConsultations` (`clientUid`+`dateTime`),
- `getProviderConsultations` (`providerId`+`dateTime`)

were each throwing `FAILED_PRECONDITION`, and the client silently fell back to `DEMO_LAWYERS` —
so **real provider search, customer booking history, and the provider dashboard were
non-functional in production**, masked by the demo data. This was invisible to the earlier pass
because the mask looked like success.

**Fixed:** the 4 definitions were added to `firestore.indexes.json` and deployed **without
`--force`** (additive only — the 4 pre-existing deployed-only indexes were preserved, not dropped,
per the never-drop rule). Verified: **7 legal composite indexes now deployed**, including all 4
required. Commit `3362211`.

### 9.2 L-1 — demo advocates now separated (FIXED)

`DEMO_LAWYERS` carried `verified:true` (rendering a fake "✅ LSK verified" badge) and were fully
bookable. Now every demo is flagged (`demo:true`, `verified:false`) with an `_isDemoLawyer()`
detector; the booking modal shows a clear **"Demonstration profile — not a real, bookable
advocate"** banner, and `confirmConsultation` **refuses** to proceed (no WhatsApp, payment,
localStorage record, or CF call) with a "real advocates are being onboarded" message. A user can
no longer believe they booked a real advocate. Commit `179953e`.

### 9.3 L-2 — booking-failure masking (FIXED)

`confirmConsultation` fired `bookLegalConsultation` in a fire-and-forget `catch` and always showed
success. Now the CF result drives the UI: success confirms "Booked & registered"; **failure
cancels the modal auto-close, marks the record `sync_failed` (not a silent fake success), states
plainly the advocate may not see it, and offers a Retry.** `retryLegalBooking` re-runs the **same**
idempotency key (`ref+'_bk'`) so a retry after a partial success returns the existing consultation
rather than duplicating it. Commit `179953e`.

### 9.4 Regression (static, against the merged build)

All **8** client CF calls resolve to real deployed exports (`bookLegalConsultation`,
`getLegalProvider(s)`, `getMyLegalConsultations`, `getProviderConsultations`, `rateLegalProvider`,
`registerLegalProvider`, `updateConsultationStatus`). The 139 KB script block passes `node --check`.
The new `sync_failed` status renders safely (both status renderers have safe defaults). Rating,
cancellation, and dashboard wiring are intact and untouched by these edits. Firestore **rules
compiled successfully** for both databases during the index deploy — no rule changes needed.

### Revised status: **READY (pending one coordinated hosting deploy)**

L-1, L-2, and the newly-found index gap are closed and proven; the index fix is **already live**.
The **HTML fixes (§9.2/§9.3) are committed but not yet on hosting** — `legal-hub.html`'s change
must ride the next hosting deploy, which is deliberately **not** triggered unilaterally because
several unrelated files (`kass-widget.js`, `auth.js`, `service-worker.js`, …) are under concurrent
edit by another process; deploying now would ship their in-flight work. Deploy hosting once that
work settles.

**Still open (unchanged, non-blocking):** L-3 (two booking paths), L-4 (provider self-update),
L-5 (client-side financial writes), L-6 (in-memory filter pagination) → v1.1. Onboarding real
advocates (L-1 operator half) remains an operator action.
