# Legal Hub v1.1 — Deferred Features Roadmap

Companion to `LEGAL_HUB_V1_CERTIFICATION.md`. These four capabilities were **deliberately not
built** in v1.0 so they can ship as standalone features without destabilizing the certified core.
Each is specified so it can be picked up cold: architecture, dependencies, data model, and a
phased plan. None requires touching the v1.0 booking/rating/search flows.

Governing rules (from the Platform Constitution): reuse canonical engines, prefer configuration
over duplication, no second payment engine, no second commission engine.

---

## A. Escrow engine for consultation payments

**Problem it solves.** Today a consultation deposit (M-Pesa STK) is collected but the platform
holds no funds against delivery — the buyer has no protection if the advocate no-shows, and the
advocate has no guarantee of payment on completion.

**Do NOT build a new escrow.** The canonical escrow already exists: `finos-router.js routePayment`
creates `escrows/{id}` (status `HELD`, holding `sellerNetCents`), and `releaseEscrow` (index.js)
pays it out — commission is charged **once at payment**, and release charges nothing (fixed
2026-07-14, see `FINANCIAL_FORENSIC_AUDIT.md`). Legal consultations must **route through it**, not
reimplement it.

**Architecture.**
```
bookLegalConsultation (status: pending_payment)
   ↓  client pays deposit via the ONE payment rail (fosInitiatePayment, hubType:'legal')
fosSecureWebhook  → calculateCommission(category:'legal', 5%)  → escrows/{id} HELD (sellerNet)
   ↓  consultation.paymentStatus = 'paid', status = 'confirmed'  (already wired via metadata.consultationId)
updateConsultationStatus('completed')  → releaseEscrow  → advocate wallet credited
dispute / no-show  → existing dispute window + refund path (reverses commission + VAT)
```

**Dependencies.** `finos-router` (escrow create), `releaseEscrow` (payout), `calculateCommission`
(already at legal 5%), the dispute/refund path. **Zero new payment or commission logic.**

**Data model.** No new collections — reuse `escrows`, `legalConsultations` (add
`escrowId`, `paymentStatus`). Settlement rule for `legal` already falls to the default
(holdDays 2, disputeWindowDays 7).

**Plan.** (1) Add a `pending_payment` state + `fosInitiatePayment` call to the booking flow.
(2) Extend the existing `_processFOSTransaction` consultation-linking to set `escrowId`.
(3) Wire `updateConsultationStatus('completed')` → `releaseEscrow`. (4) Wire the no-show/dispute
branch to the existing refund path. **Estimate: medium; all integration, no new engine.**

**Risk.** Money path — must pass the three financial CI gates (idempotency, payment-integrity,
single-source) before merge. Escrow release must remain the "charge nothing" path.

---

## B. Scheduled compliance-reminder service

**Problem it solves.** Advocates and clients have legal deadlines (hearing dates, filing windows,
agreement renewals, licence expiry) with no proactive nudges. Today compliance is checked only
on-demand (`legalCheckCompliance`, `legalGetPendingUpdates`) — nothing pushes.

**Do NOT build a new notifier or scheduler pattern.** Reuse the canonical Notification Engine
(`functions/notify.js` — the single push/in-app/SMS/email entry point) and the platform's existing
`onSchedule` pattern (e.g. `scheduledDailyOpsReport`, the FinOS auto-settlement 6h schedule).

**Architecture.**
```
onSchedule('every 24 hours')  legalComplianceSweep
   → query legalConsultations / legalDeadlines where dueDate within [now, now+window]
   → for each, notify.send(uid, 'legal_reminder', {…})   (push + in-app + email, one call)
   → write legalReminderLog/{consultId}_{dueDateBucket}  (deterministic id → idempotent, no dupes)
```

**Dependencies.** `notify.js` (Notification Engine), `onSchedule`, a `legalDeadlines` collection
(new — the one genuinely new store) or a `dueDate`/`remindAt` field on existing consultations.
Idempotency via a deterministic reminder-log id so a re-run never double-sends.

**Data model.** New `legalDeadlines/{id}` (uid, type, dueDate, remindOffsets[], sourceId) OR
extend `legalConsultations` with `remindAt`. New `legalReminderLog/{deterministicId}` for
send-once. Rules: both CF-only (`allow write: if false`), matching the rest of the hub.

**Plan.** (1) Define the deadline source (start by reminding on upcoming `legalConsultations`).
(2) `onSchedule` sweep with a bounded query + deterministic send-log. (3) Add reminder categories
to the Notification Engine's category list. (4) Opt-in preference honoured via existing DND/notif
prefs. **Estimate: small–medium.** Billing note: one scheduled function, bounded query — cheap.

**Risk.** At-least-once scheduled invocation → the deterministic send-log is mandatory (Firestore
triggers/schedules can fire more than once). Follow Pattern C.

---

## C. Company-registration UI

**Problem it solves.** Users searching "company registration" are routed to legal-hub.html, but
there is **no backend** for registering a user's business entity (Business Name Search, CR12, KRA
PIN, VAT, NSSF, SHA, county permits). `company-identity.js` is SOKONI's *own* corporate metadata —
the opposite thing — and must not be conflated.

**This is the largest of the three** — it is a genuine new workflow, not an integration. Build it
as a self-contained module that does not touch v1.0.

**Architecture.**
```
company-registration.html (new page, reuses the premium dark layout + shared-header)
   → registrationDispatch CF (new, single onCall dispatcher — matches servicesDispatch pattern)
       ops: startRegistration, uploadDocument, submitStep, getStatus, trackProgress
   → companyRegistrations/{uid}_{regId}  (application state machine)
   → Document Engine (existing) for uploads/verification
   → Notification Engine for step-complete / action-needed
   → optional: eTIMS/KRA integration reuse (functions/etims.js has the AES-256 credential pattern)
```

**Dependencies.** Document Engine (uploads), Notification Engine, the dispatch pattern, and
— if automated KRA/registrar filing is in scope — the eTIMS credential-encryption pattern. Payments
for statutory fees route through the ONE payment rail (as in A).

**Data model.** New `companyRegistrations/{id}` (uid, entityType, steps[], status, documents[],
fees[], submittedAt), new `companyRegistrationDocs` (or reuse Document Vault). CF-only writes.
New Firestore indexes for `uid`+`status` queries.

**Plan (phased, largest scope).**
1. Application state machine + `registrationDispatch` (startRegistration/getStatus/trackProgress).
2. Business Name Search + step forms (client) → submitStep.
3. Document upload via Document Engine + verification.
4. Statutory-fee payments via the payment rail; receipts via the invoice engine.
5. Registrar/KRA integration (if automated) reusing the eTIMS credential pattern — otherwise a
   manual-assist workflow with status tracking.
**Estimate: large; deliver in the phases above, each shippable.**

**Risk.** New collections → new indexes (watch the 200/200 index budget; use the ops second
database if needed, per the index-management rule). Handles PII and statutory identifiers →
encryption at rest (eTIMS pattern) and strict rules. Do not let it regress the certified v1.0.

---

## Sequencing recommendation

1. **Provider availability / slot management** (the L-4 sibling from certification) — smallest,
   unblocks true booking integrity (slot uniqueness). Good first v1.1 item.
2. **B. Compliance reminders** — small–medium, high user value, low risk (one scheduled fn).
3. **A. Escrow** — medium, money path, must clear all three financial gates.
4. **C. Company registration** — large, phased, mostly independent of the rest.

Each lands without modifying the v1.0 booking/rating/search flows. Certify each against its own
gates before merge, exactly as v1.0 was.
