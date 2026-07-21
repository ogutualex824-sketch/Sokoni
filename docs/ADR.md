# SOKONI Architecture Decision Records

**Status:** canonical · governance document
**Purpose:** one owner per subsystem, recorded with evidence, so a second
implementation cannot be added without a reviewer seeing this first.

This file exists because the platform repeatedly grew a *second* engine for a
subsystem that already had one — 11 print engines, five subscription stores,
two receipt engines assigning the same global on the same page. Each was
individually reasonable and collectively corrosive. An ADR is the record that
makes "there is already a canonical one" impossible to miss.

**Rule:** no PR may introduce a second engine, orchestrator, transport layer,
receipt builder, or entitlement path for any subsystem below without updating
its ADR and providing a migration plan. `scripts/architecture-guardian.js` is
the intended enforcement point (see ADR-0007).

Each record: **Decision · Evidence · Consequences · What is forbidden.**

---

## ADR-0001 — Printer engine

**Decision:** `sokoni-universal-printer.js` (`window.SokoniPrinter`) is the one
printer engine. It owns the ESC/POS encoder, the command table, the five
transport adapters (Bt/Usb/Serial/Network/Browser) and the persistent queue.

**Evidence:** it is the only module with a complete `ESCPOSEncoder` class plus
all five adapters and a queue; `sokoni-bluetooth-printer.js` already delegates to
it (`new SokoniPrinter.ESCPOSEncoder()`), proving the adapter model works. A
2026-07-21 audit found ~10 independent ESC/POS encoders, up to six co-loading on
`pos.html`.

**Consequences:** `sokoni-bluetooth-printer.js` is the P58E **profile adapter**.
`print-engine`, `pos-print`, `pos-print-service`, `printer-manager`,
`printer-drivers` (old), `pos-printer`, and the 8596d21 additions
`printer-providers`/`printer-driver`/`device-profiles` are duplicates to be
collapsed into adapters or retired one page at a time.

**Forbidden:** a new ESC/POS byte table; a new Web Bluetooth `requestDevice` for
printing outside the permission pipeline (ADR-0004); loading more than one
printer engine on a page.

---

## ADR-0002 — Receipt engine

**Decision:** exactly one receipt builder. `pos-receipt-engine.js`
(`SokoniReceiptEngine`) is canonical; `sokoni-receipt-engine.js` must be removed
from any page that also loads it.

**Evidence:** both assign `window.SokoniReceiptEngine`, and **both load on
`pos.html`** (`:1445`, `:2231`). `pos-receipt-engine.js:1120` documents the
collision against itself. Later `defer` wins by Object.assign merge — fragile
and load-order dependent.

**Consequences:** receipt rendering is transport-independent — the builder emits
a model, the printer engine (ADR-0001) encodes it. Marketplace, orders, refunds,
invoices and gift receipts all consume the same builder.

**Forbidden:** a second module assigning `SokoniReceiptEngine`; ESC/POS bytes
inside a receipt builder.

---

## ADR-0003 — Hardware setup UI

**Decision:** `pos-hardware-wizard.html` is the one hardware setup UI. Its
capability model lives in `pos-hardware-wizard.js` (four layers: capabilities /
transports / configured / live devices).

**Evidence:** four setup UIs exist — `pos-hardware-wizard.html` (200),
`pos-printer-setup.html` (200), `pos-printer-hardware-test.html` (200), and
`pos-hardware-setup.html` (**404, never deployed**, from 8596d21). The wizard is
the one with the audited capability/transport/device separation.

**Consequences:** `pos-hardware-setup.html` must NOT be deployed — deploying it
would add a fourth parallel UI. It should redirect to the wizard or retire.

**Forbidden:** a new hardware setup page.

---

## ADR-0004 — Hardware permission pipeline

**Decision:** `sokoni-permission-manager.js` (`SokoniPermissionManager`) is the
single funnel for every `requestDevice` / `requestPort` / permission gesture.

**Evidence:** added by 8596d21 and genuinely new — nothing older centralised
permissions. The audit found five independent `requestDevice` paths that should
route through it.

**Consequences:** this is the one part of the 8596d21 hardware layer worth
keeping wholesale, alongside `capability-detector`, `hardware-persistence`
(IndexedDB config), `hardware-diagnostics`, `hardware-recovery`, and
`peripheral-drivers` (scanner/drawer/NFC/scale/terminal/biometric). The DEAD
files from the same commit — `sokoni-hardware-manager.js`,
`sokoni-printer-providers.js` (zero consumers) — are retired.

**Forbidden:** a driver calling `navigator.bluetooth.requestDevice` directly.

---

## ADR-0005 — Payment → entitlement

**Decision:** `functions/entitlement-engine.js` is the one authority that turns a
payment into a capability. Every paid domain is a thin adapter
(`entitlement-adapters.js`) registered against a purpose; pricing is derived
server-side by `functions/payment-purposes.js`; recovery is the one
purpose-agnostic reconciler in `payment-reconciliation.js`.

**Evidence:** the invariant `one paymentRef ⇒ one entitlements/{paymentRef}`,
created in the same transaction as activation. Proven by 53+ assertions across
engine, subscription, digital-download and booking suites. The reconciler runs
in production every 10 minutes (39+ clean runs observed).

**Consequences:** subscriptions, digital downloads and bookings are wired;
tickets, hub registration and marketplace orders are pending adapters. No domain
performs its own payment verification.

**Forbidden:** granting paid access from a payment callback directly; a client
value deciding entitlement (closed in `booking.js` where `paymentId ? 'paid'`
was forgeable); a new reconciler.

---

## ADR-0006 — Identity & session

**Decision:** device/session registration happens once, in the Firebase auth
observer (`firebase.js`), latched per browser session. Firebase custom claims —
never localStorage — are the authority for role and admin state.

**Evidence:** registration previously fired only from account-centre.html, so
concurrent devices showed as one; moved to the observer. Client IP is stored
pseudonymised (`ipHash`, HMAC keyed per uid), never raw — Kenya DPA / GDPR.
Banking and permissions gates previously trusted `localStorage.isAdmin`, a field
nothing writes; now read from claims.

**Forbidden:** authorising from browser storage; storing a raw client IP;
registering the device from a page rather than the observer.

---

## ADR-0007 — Enforcement

**Decision:** `scripts/architecture-guardian.js` and `scripts/perf-guard.js` are
the enforcement points, and both belong in the predeploy gate so the rules above
fail a build rather than relying on review.

**Evidence:** the guardian already encodes 10 rules (5 CRITICAL) and caught the
101-commit unpushed backlog and the caught-error-blames-network class. The
perf-guard already ratchets getAll-in-loop, forEach-async fan-out, and
precached-not-fresh regressions. Neither is wired into `firebase.json` predeploy
yet.

**Consequences:** wiring them is the single highest-leverage governance change —
it converts these ADRs from documentation into gates. A rule that checks "no
second module assigns `window.SokoniReceiptEngine`" or "no page loads two printer
engines" would have blocked the exact regressions this file exists to prevent.

**Forbidden:** merging past a CRITICAL guardian violation.
