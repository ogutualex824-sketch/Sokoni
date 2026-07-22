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

**Consequences — CORRECTED 2026-07-22 by behavioural analysis.** The sentence
that stood here called `print-engine`, `pos-print`, `pos-print-service`,
`printer-manager`, `printer-drivers` and `pos-printer` "duplicates to be
collapsed or retired". That was wrong, for the second time in this file, and
from the same cause: counting ESC/POS byte tables instead of reading what each
module does.

A per-file audit of all six — complete public API, unique methods, external
call sites, and output protocol — found **zero true duplicates**. Every one has
at least four methods with no equivalent in any other module, and at least two
external consumer files. They are a **layered stack**, not parallel engines:

| Module | Role | Unique capability |
|---|---|---|
| `pos-printer.js` | transport foundation for `pos.html` | `sendRaw` — the only raw-byte sink on the page; `printBrowser`; `buildQR` |
| `sokoni-print-engine.js` | branded business documents | Firestore merchant branding; six A4 HTML templates (invoice, quotation, delivery note, return slip, shelf tag, sticker) |
| `sokoni-pos-print.js` | multi-printer fleet | IndexedDB printer registry; `printFulfilment` role routing; Web Serial; Android bridge |
| `sokoni-pos-print-service.js` | POS document orchestrator | ~15 document types (refund, credit note, X/Z report, EOD); reprint; audit trail |
| `sokoni-printer-drivers.js` | stateless encoder library | `logoBytes` raster; 7-symbology barcodes; eTIMS/KRA block; TSPL/ZPL/CPCL |
| `sokoni-printer-manager.js` | adapter over canonical | `.p58e` proxy; `PRINTER_PROFILES`; `detectPlatform`/`getConnectionPriority` |

The trap: four modules expose a method named `print` and three expose
`printLabel`, with mutually incompatible signatures and protocols.
`PosPrinter.printLabel` renders HTML for `window.print()`;
`SokoniPosprint.printLabel` emits TSPL/ZPL bytes. Same name, opposite protocol
— identical to the ADR-0002 error below. **A shared method name is not shared
behaviour, and an ESC/POS table is not evidence of a duplicate engine.**

Deleting any of the six removes production capability: POS pairing, all
receipt printing, price labels, `print-station.html` entirely, seller
fulfilment documents, or every barcode label silently printing blank paper.

**Genuine defects the audit did find** — neither is duplication:
- `pos.html:1449-1450` loads `printer-manager` and `pos-print-service` but
  **not** their hard dependency `sokoni-universal-printer.js`; both are inert
  there (no call sites on that page) and load-bearing elsewhere.
- `sokoni-printer-driver.js:468` (singular) assigns `SokoniPrinterDrivers` with
  a *different shape* than `sokoni-printer-drivers.js:5` (plural). Latent only
  because no page loads both. **Rename, never delete** — co-loading them breaks
  `sokoni-receipt-engine.js:88`.

**Forbidden:** a new ESC/POS byte table; a new Web Bluetooth `requestDevice` for
printing outside the permission pipeline (ADR-0004); **deleting any printer
module on the basis of a name, a global, or an encoder count** — only a
behavioural audit proving zero unique capability and zero external callers may
justify removal.

**Guard note:** `printerEnginesPerPage` baselines at 6 and that is **not** a
violation being tolerated — six layered modules on `pos.html` is the correct
state. The metric blocks a *seventh*; it is not driving the count to one.

---

## ADR-0002 — Receipt engine

> **Superseded 2026-07-22 by evidence. The first version of this record was
> wrong and would have broken production if executed.** It said
> `sokoni-receipt-engine.js` "must be removed from any page that also loads
> `pos-receipt-engine.js`", reasoning from a static count of two modules
> assigning one global. That is recorded here rather than deleted, because the
> mistake is the useful part: a duplicate-looking global is not evidence of
> duplicate capability, and the count that looked like a defect was a fix.

**Decision:** the two modules are **complementary and both stay**.
`sokoni-receipt-engine.js` owns **thermal ESC/POS receipt bytes**;
`pos-receipt-engine.js` owns the **on-screen receipt UI**. Neither may absorb
the other. What is forbidden is the *ambiguity*, not the second module.

**Evidence:** `sokoni-receipt-engine.js` uniquely provides the thermal
primitives — `init, bold, align, size, feed, partCut, drawer, charset, line,
receipt, customer, invoice` — plus `buildShippingLabel()`, which
`sokoni-label-engine.js:413` calls directly, on a page where it is loaded
(`pos.html`). `pos-receipt-engine.js` provides `show / generate / print /
downloadPDF / shareWhatsApp / copyText / close`. Removing either deletes
capability: dropping the thermal module throws `TypeError` on every shipping
label.

The shared global is already handled deliberately —
`pos-receipt-engine.js:1136` merges rather than overwrites
(`Object.assign({}, window.SokoniReceiptEngine || {}, engine)`) precisely so
whichever loads second keeps the other's methods, and it already publishes
itself under the unambiguous `window.SokoniPosReceiptUI`. That merge was a bug
fix for exactly the breakage this ADR originally proposed to reintroduce.

**Consequences:** the residual defect is load-order sensitivity, not
duplication. The convergence is to finish the explicit-naming migration the
canonical file started — give the thermal engine its own distinct global, move
callers onto explicit names, and keep `SokoniReceiptEngine` as a merged
backward-compatible alias. That is incremental and breaks nothing. It is not
"delete one file".

**Forbidden:** a *third* module assigning `SokoniReceiptEngine`; a new on-screen
receipt renderer; a new thermal receipt byte builder. ESC/POS bytes for
*printing transport* still belong to ADR-0001 — `sokoni-receipt-engine.js`
builds receipt content, and folding its byte emission into the canonical
encoder remains open, but only as a merge that preserves `buildShippingLabel`.

**Guard note:** `perf-guard` ratchets `receiptEngines` at a baseline of **2**,
which is now the correct steady state rather than a violation being tolerated.
The metric's value is blocking a third owner, not driving the count to one.

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

---

## ADR-0008 — Public listing reads expose whole documents

**Decision:** listing collections are readable anonymously only when the record
carries an explicit `active` or `published` status; drafts, pending and rejected
records stay private. Owner and admin escape hatches are preserved.
`propertyListings` and `healthProviders` are Cloud-Function-write-only.

**Evidence:** audited 2026-07-22 before a rules deploy. `services`, `vehicles`,
`cars`, `properties`, `propertyListings`, `digitalJobs` are all status-gated;
`applications` is `isAdmin() || isOwner()` and never public; `stores` is fully
public as a shopfront. Verified against the rules themselves, not the commit
message that described them — the message said "added public allow read" for all
nine, which materially overstated what shipped.

**Consequence — the open item.** Firestore rules gate documents, not fields, so
an approved `healthProviders` record is anonymously readable *in full*:
`phone`, `licenseNumber`, `address`, `qualifications`, `bio`. For a healthcare
directory that is arguably the intent — a patient needs the number, and a
practising licence is normally a public identifier — but it is bulk-scrapable,
and SOKONI is ODPC-registered.

The fix, when the directory justifies it, is to split the document rather than
tighten the rule: a public profile (name, specialty, practice phone, licence,
clinic location) beside a private operational record (verification notes,
internal contacts, moderation state). A rule cannot do this; only the data model
can.

**Forbidden:** adding a field to a publicly-readable listing collection without
asking whether it should be world-readable. The rule will not stop you — it
grants the document, not a field list.

---

## ADR-0009 — Upload incident runbook

**Decision:** `scripts/diagnose-upload.js` is the first action on any "cannot
publish a product" report. It runs in the browser console on the affected
account, needs no deployment, and returns a structured artifact whose
`firstFailingStage` names the owning subsystem.

**Evidence:** a full static search could not explain a reported cap of 3. All
four plan tables say 10 (`functions/index.js:3683`, `sokoni-revenue.js:28`,
`sub-billing.js`, `product-limit.js`); the gateway's `upload.maxTokens = 3` has
no call sites across the 114 pages that load it; storage rules cap size, not
count; no image or AI-credit quota of 3 exists. When the code cannot explain a
number, the number is runtime state and only the running system can be asked.

### Response matrix

| `firstFailingStage` | Owner | Action |
|---|---|---|
| `auth` | identity | refresh token (`getIdToken(true)`), inspect claims |
| `counterRead` | data | inspect `productCounters/{uid}`, check trigger logs |
| `consistency` → `SELLER_KEY_MISMATCH` | data model | products split across `sellerUid`/`sellerId` — fix the query, **not** the counter |
| `consistency` → `STATUS_FILTER_MISMATCH` | counting | one component filters by status, another does not — reconcile the definition |
| `consistency` → `COUNTER_DRIFT` | data | run `recountMarketplaceProducts`. **Do not roll back rules** |
| `firestoreWrite` + `permission-denied` | rules | the deployed rule is the blocker — investigate or roll back |
| `callable` | functions | inspect Cloud Function logs and revision |
| none | client | rejection is upstream — client validation, image upload, or storage |

**Consequence — the rule this exists to enforce:** a rollback must follow
evidence that the suspected component actually denied the request. Reverting
Firestore rules on suspicion, when the fault is counter drift, removes
protection and fixes nothing.

**Forbidden:** changing production code during an upload incident before one
diagnostic artifact exists from an affected account. Every change made before
the failing stage is identified adds a variable to an investigation that already
has too many.

**Probe safety:** the diagnostic writes and deletes one product flagged
`__diagnostic: true`, cleaned up in a `finally` so a later throw cannot orphan
it. An orphaned probe would inflate the counter being measured — the diagnostic
would become a cause of the symptom it is investigating.

---

## ADR-0010 — Subsystem freeze during a P0 investigation

**Decision:** when a P0 investigation opens on a subsystem, that subsystem is
frozen for the duration. Only instrumentation, or a fix explicitly approved for
the incident, may land. Normal development resumes when the incident closes.

**Evidence — 2026-07-22, four collisions in one day.** Two agents edited the
printing stack simultaneously while a convergence audit was in progress. The
search agent rewrote `firestore.rules` while a subscription rules deploy was
staged, so shipping one meant shipping the other. A POS startup fix landed
mid-crash-investigation and was carried to production by an unrelated hosting
deploy. And a crash instrument was armed against a startup path that had already
been changed underneath it.

None of those were bad changes — the startup fix cut parser-blocking scripts
from 41 to 3 and was exactly right. The cost was interpretive: a diagnostic
measures the build it runs on, so a build that moves during the measurement
produces evidence about neither the old state nor the new one.

**Consequence:** `firebase deploy --only hosting` ships the whole working tree,
not the files the author edited. Scope cannot be controlled by intent while a
second process writes the same tree — it can only be controlled by the tree
holding still. A freeze is the only mechanism that actually works.

**Record the prediction before testing.** The iPhone crash investigation logged
its expected outcome per platform before any device ran, so the result is
falsifiable rather than rationalised afterwards. Do this on every incident: a
prediction written after the fact explains anything.

**Split investigations the evidence separates.** iPhone crash and Android hang
were assumed to share a cause. Parser blocking is platform-neutral, so if
removing it fixes one and not the other, they were never the same defect and
pursuing a common cause discards the evidence just gained.

**Forbidden:** landing a behavioural change in a frozen subsystem, however
correct, without recording it against the open incident — the next person
reading the diagnostic output has no way to know the ground moved.

### Incident exit checklist

A P0 is not closed when the symptom stops. It is closed when these are answered,
in writing, on the incident:

1. **Root cause identified?** Name the component and the mechanism. "It stopped
   happening" is not a cause.
2. **Evidence supporting it?** A runtime artifact — crash report, diagnostic
   output, live bytes — not a code reading. Three findings during this incident
   were overturned by measurement after looking certain in source.
3. **Verified on every affected platform?** A fix confirmed on one device says
   nothing about the others; parser blocking was platform-neutral and its
   removal still had to be checked per platform.
4. **Guarded against recurrence?** A regression test, or a ratchet in
   `scripts/perf-guard.js`. Without one the same defect returns and the next
   investigation starts from zero.
5. **Can the instrumentation be removed?** Temporary diagnostics that are never
   removed become permanent startup cost. Name the commit that removes them.
6. **What changed in how we work?** Every incident that produces only a code fix
   has wasted the expensive part. ADR-0010 exists because four collisions in one
   day were cheaper to prevent than to keep untangling.

Unanswered questions are not a reason to keep an incident open — they are the
content of the follow-up work, recorded rather than forgotten.

---

## ADR-0011 — A harness must reproduce the production contract

**Decision:** a test that supplies state, triggers an event, or names a target
which production does not provide has not tested production. It has tested the
harness. Before a passing test is treated as evidence, the binding it depends on
must be verified against the real artifact.

**Evidence — three failures in one day, all reading as PASS:**

1. **A deploy target that did not exist.** `product-limit.js` was written but
   never required by `index.js`, so `firebase deploy --only
   functions:onMarketplaceProductCreated` would have reported success and
   shipped nothing. The counter would never have been maintained, and because
   the rule fails open, the cap would silently never have applied.

2. **A code path that could not fire.** Crash breadcrumbs were armed against a
   startup path that had already been changed by another commit, so the
   instrument measured a build that was not the one that crashed.

3. **State production does not expose.** `pos-lifecycle.js` read `window.state`
   and `window.SPos`; `pos.js` declares `const SPos = (…)()` at the top level of
   a classic script, which lives in the global *lexical* scope and is not a
   property of `window`. The harness manufactured `window.state`, so the policy
   passed 10/10 against the deployed bytes while being structurally unable to
   observe a real cart.

Each shares one property: **the harness did not reproduce the production
contract**, and a passing result was indistinguishable from a working one.

**Consequence — the third outcome.** Tests have three results, not two:

| Result | Meaning |
|---|---|
| PASS | the behaviour was exercised and was correct |
| FAIL | the behaviour was exercised and was wrong |
| **UNTESTABLE** | **the behaviour was never exercised — no conclusion may be drawn** |

Collapsing UNTESTABLE into PASS is how all three above would have shipped.

**Practices this earns:**

- Verify a deploy target resolves before naming it in a deploy command.
- Verify the artifact hash matches before running behavioural tests against it.
- Verify a binding exists in the real page before trusting a test that supplies
  it — reading how the application declares the value settles in one grep what
  a device check would take a day to surface.
- Run independent cases in independent processes. Two simulations in one Node
  process leaked state between them and produced a false failure on the same
  day.

**Forbidden:** reporting a green test as evidence when the value under test was
provided by the test.

### Artifact parity — companion to ADR-0011

`scripts/verify-artifact-parity.js` answers the question a hash cannot: when the
deployed bytes differ from the repository, does the deployed **program** differ?

```
node scripts/verify-artifact-parity.js pos-lifecycle.js sw-register.js
```

| Verdict | Meaning | Runtime tests |
|---|---|---|
| `IDENTICAL` | bytes match | valid |
| `COMMENT-ONLY` | bytes differ, executable code does not | **valid** |
| `BEHAVIOUR-DIFFERS` | the deployed program is not this program | **invalid — stop** |

**Why a hash alone misleads in both directions.** Treating any mismatch as "not
deployed" stalls a release over a comment that cannot affect a test. Treating a
mismatch as "probably just formatting" is how a real change gets waved through.
The check removes the judgement call by measuring instead.

The normalisation is deliberately naive about comment-like sequences inside
string literals. A false `BEHAVIOUR-DIFFERS` only delays a test; a false
`COMMENT-ONLY` would validate against the wrong program. **When the two errors
are not symmetric, prefer the harmless one.**

Exit 1 only on `BEHAVIOUR-DIFFERS` — comment drift is reported, not fatal.

*Verified by injecting one executable line into a comment-only diff: verdict
flips to `BEHAVIOUR-DIFFERS`, exit 1; removing it returns to `COMMENT-ONLY`,
exit 0.*

---

## ADR-0012 — Two subscription pages exist; the broken one is the one everything links to

**Status:** OPEN — engineering has established the facts, the product decision is not made
**Date:** 2026-07-22

### What was found

SOKONI has two subscription pages.

`plans.html` resolves plans server-side through the `subGetPlans` callable, groups
them by `hubType`, and offers the tier matching the hub the user is actually in.
It is correct.

`subscriptions.html` carries a hardcoded `PLANS_DATA` array and purchases the plan
ids `starter`, `pro`, `business`. In `sub-billing` those three ids are
`hubType: 'service_provider'`. The page describes them in marketplace language —
"20 active listings", "Unlimited listings" — while the plans grant
`services_limit` and `leads_per_month`.

**16 links across the codebase point to `subscriptions.html`. None point to
`plans.html`.** The correct page is orphaned; the incorrect one is the default
route.

### It is not hypothetical

`paymentIntents/SKN3550FD490`, created 2026-07-20T22:05Z:

```
uid       xrH21J5GFbW8PluCZ2ny5nIuf602   ← KASS VAPES, a marketplace merchant
planId    starter
hubType   service_provider               ← recorded on the intent itself
amount    499 KES
status    created                        ← abandoned, never paid
```

A merchant selling vape products attempted to buy a service-provider plan. Had
they completed payment they would hold a subscription whose `hubType` does not
match the marketplace lookup in `subscription-core.resolveSubscription(uid,
{role:'merchant', hubType:'merchant'})` — paying KES 499/month while remaining on
marketplace Free.

Zero completed purchases exist, so no migration is owed. The defect is live and
reachable, not latent.

### What is NOT wrong

Pricing was suspected and cleared. The page displays KES 499 / 1,499 / 4,999 and
`sub-billing` charges 49900 / 149900 / 499900 cents — the same figures.
`subscriptionPlans/{planId}` is empty, so nothing overrides them. The payment
intent above was minted at exactly the advertised 499. `sub-billing`'s own comment
records that its prices were transcribed from this page.

An earlier reading of this compared the page against the `seller_*` tiers, which
the page never purchases, and concluded merchants were charged double. That was
wrong.

### The decision required

Not an engineering one:

1. **`subscriptions.html` is legacy** — retire it, repoint the 16 links to
   `plans.html`. Marketplace sellers then reach `seller_basic` / `seller_pro` /
   `seller_enterprise`, which exist in `sub-billing` and are currently
   unpurchasable from any client surface.
2. **`subscriptions.html` is the service-provider page** — its plan ids and prices
   are already correct; only the marketplace wording is wrong. Marketplace sellers
   still have no upgrade path.

### Why nothing was changed

The listing numbers on that page were briefly edited to match the marketplace
catalogue and reverted. The page's `listings: 20` already matched
`services_limit: 20` on the plan it sells; aligning it to the marketplace
catalogue would have made a coherent page incoherent, to match a catalogue
governing a different product.

**A number that looks wrong against one authority may be right against the one
that actually applies. Establish which product a surface belongs to before
synchronising its values.**
