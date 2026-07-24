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

---

## ADR-0013 — Subscription activation: one canonical writer, one open identifier decision

**Status:** PART ACCEPTED (activation), PART OPEN (identifier)
**Date:** 2026-07-22
**Evidence:** `docs/SUBSCRIPTION-WRITERS.md` — 12 write sites, 6 modules, 3 id conventions

### Accepted — `intasendWebhook` is the canonical activation writer

`functions/index.js:5688` reads `paymentIntents/{apiRef}`, requires
`purpose === 'subscription'`, and derives both `uid` and `plan` from that
server-minted intent. The client is never consulted. This is recorded rather
than decided: it is already how production activates, and the code says why —
*"the client-side onSuccess path is fragile (tab close, network drop); this
webhook is the authoritative signal."*

**Rule:** a subscription entitlement is derived from `paymentIntents`. Any writer
that takes a plan from a request body is not an activation path.

### Accepted — `activateSubscription` is legacy and must stop trusting the client

`functions/index.js:5754` validates payment ownership and COMPLETE status, then
writes whatever `plan` arrived in `request.data`. Its two callers both live in
`subscriptions.html`; `:525` sources that plan from
`localStorage.sokoniSubscription`, which a standing project rule forbids as a
business authority.

It must either be deleted — `healSubscriptionEntitlement` already covers webhook
failure, config-gated and failing closed — or resolve the intent and derive the
plan exactly as the webhook does. **Not shipped yet:** the regression suite comes
first (valid activation, plan/intent mismatch rejected, non-subscription payment
rejected, other user's payment rejected, idempotent replay, legacy ref fails in a
documented way).

### Open — the canonical document identifier

Three conventions are in the codebase today:

```
subscriptions/{uid}          webhook, activateSubscription, heal, adapters
subscriptions/{merchantId}   business-bootstrap    ← the one live record
subscriptions/{autoId}       sub-billing, sub-engine   (uid as a field)
```

This is the cause of the lookup failure patched client-side on the same day:
`sokoni-subscriptions.js` read `subscriptions/{providerId}` and missed the only
live merchant, whose record is keyed by `merchantId`. That client fix — direct
id, then `where('uid','==')` — remains correct and remains a symptom fix.

**Recommendation: `{uid}`.** Every deployed writer already uses it, the read path
in `subscription-core` resolves by `uid`, and the alternative conventions belong
to modules that are not deployed.

**The migration cost is one document today.** `subscriptions` holds a single
record. The same decision taken after a hundred merchants onboard is a data
migration with an entitlement-outage risk; taken now it is one write. That
asymmetry, not elegance, is the argument for deciding before the next onboarding
wave.

Ratification is deferred because it is an architecture decision with product
consequences — `merchantId` may be deliberate if a merchant is ever intended to
hold subscriptions across multiple owner accounts. **That question should be
answered explicitly rather than settled by whichever module ships next.**

### Why this ADR exists

Four separate investigations in one session each found a single writer, reasoned
from it, and reached a wrong conclusion. `activateSubscription` was analysed for
an hour before `intasendWebhook` was found sixty lines above it in the same file.
A proposal to renormalise the entire payment reference model was drafted and
withdrawn on discovering the linkage already existed.

**Before changing a canonical write path, enumerate every writer to the same
document and classify each as primary, repair, migration or legacy.** One trace
is a hypothesis; the full set is a finding.

---

## ADR-0014 — Two IntaSend webhooks: ADR-0013 and production disagree

**Status:** OPEN — blocking. Names the conflict; does not resolve it.
**Date:** 2026-07-24
**Evidence:** `docs/INTASEND_WEBHOOK_AUDIT.md`, Cloud Logging 14d, `functions:list`

### The conflict

Three sources name a different canonical collection webhook:

| Source | Canonical | Date |
|---|---|---|
| ADR-0013 | `intasendWebhook` | 2026-07-22 |
| Dashboard (operator observation) | `webhookIntasend` | 2026-07-24 |
| 2026-07-24 changes (entitlement materialisation, FinOS wallet credit) | `webhookIntasend` | 2026-07-24 |

**ADR.md never mentions `webhookIntasend`.** ADR-0013 was written as though one
IntaSend webhook existed. Two do, both deployed, both public, both validating the
same `INTASEND_WEBHOOK_CHALLENGE`, both writing `subscriptions/{uid}`, and both
matching ADR-0013's description — each reads `paymentIntents` and requires
`purpose === 'subscription'`. The description does not discriminate between them.

ADR-0013 cites `functions/index.js:5688`; `intasendWebhook` is now at `:5754`. Line
numbers have drifted, so the ADR binds by **name**, not location.

### Why this matters now

The two have **diverged**, and neither is a superset:

| | `webhookIntasend` | `intasendWebhook` |
|---|---|---|
| Entitlement materialisation | **yes** | no |
| FinOS wallet credit | **yes** | no |
| Event states | COMPLETE · FAILED · PENDING | + **CANCELLED**, processing |

Cloud Logging shows **both receiving traffic** (2026-07-24 10:03:32 and 10:13:22
fired both), so registrations point at both. Every logged delivery in 14 days was a
synthetic probe rejected on challenge mismatch — no genuine IntaSend invoice ID was
observed — so production has never settled the question by behaviour either.

### Consequences if left unresolved

- Dashboard registered to `intasendWebhook` (per ADR-0013) → a real payment
  activates the subscription but **credits no wallet and materialises no
  entitlement**. Exactly the incident of 2026-07-24, reproduced.
- Both registered → duplicate delivery. Per-`apiRef` idempotency prevents double
  commission and double wallet credit, but the two write different data, so which
  one wins is timing-dependent.
- ADR-0013 continues to name a writer that production may not use.

### Decision required

Pick one canonical collection webhook, then either delete the other or reduce it to
a thin delegate. Do **not** maintain two. Whichever is chosen must carry the
entitlement and wallet paths, and the wider event coverage
(`CANCELLED`) should be folded in rather than lost.

**Do not resolve this by changing the dashboard and the code in the same step.**
Changing the handler and the configuration simultaneously makes a failure
impossible to attribute — the same reasoning recorded in
`INTASEND_WEBHOOK_AUDIT.md`.

### Acceptance criterion

> Exactly one webhook endpoint is designated as the production authority, and every
> piece of payment-side business logic — payment finalization, commission, wallet
> crediting, subscription activation, entitlements, audit logging — is reachable
> through that endpoint.

Four things must agree: **documentation, deployment, dashboard configuration, and
code.** Three are machine-checkable:

```bash
node scripts/verify-webhook-authority.js <endpointName>
```

It prints a capability matrix across every IntaSend `onRequest` export and exits 1
if the named endpoint is missing any. Measured 2026-07-24:

```
CAPABILITY                    intasendWebhook   webhookIntasend
payment finalization          yes               yes
commission ledger             yes               yes
subscription activation       yes               yes
entitlement materialisation   NO                yes
wallet credit (FinOS)         NO                yes
audit logging                 yes               yes
```

The **dashboard registration is not checkable from the repository** and is reported
UNKNOWN. Code agreeing with itself is not the same as code agreeing with the
dashboard.

### Why this blocks the acceptance payment

Until one authority is settled, **a live payment cannot be interpreted**. It could
exercise an endpoint without the new logic, and the result would read as the
integration failing when it was never invoked — a false negative dressed as an
acceptance test, which would send the next investigation hunting for a defect in
code that never ran. Resolve this BEFORE spending a qualifying payment, not after.

**Superseded scope:** ADR-0013's "Accepted — `intasendWebhook` is the canonical
activation writer" is downgraded to OPEN until this is decided. Its other rulings
(entitlement derives from `paymentIntents`; a writer taking a plan from a request
body is not an activation path) are unaffected and still hold.

---

## ADR-0015 — Reversal / refund policy — DECISIONS REQUIRED BEFORE CODE

**Status:** OPEN — no implementation exists, and none should be written first
**Date:** 2026-07-24

A reversal handler is not plumbing; it encodes financial policy. The code cannot be
written correctly until these are decided, because each changes the ledger
arithmetic rather than the wiring.

### Current state — verified

- **No reversal handler.** IntaSend Reversal / Send Money / Wallet Transfer events
  are enabled in the dashboard; neither webhook branches on any purpose except
  `subscription`.
- **`adminSubProcessRefund` moves no money.** It marks a refund `status:'processed'`
  and notifies the merchant with **zero gateway calls** anywhere in `sub-billing.js`.
- **The primitives exist.** `debitWalletTxn` supports `allowNegative` (default
  `false`, throws on insufficient balance); clawback precedent at `finos.js:292`.

### Decisions

| # | Decision | Status | What the code supports today |
|---|---|---|---|
| 1 | Full vs partial reversal | Pending | `debitWalletTxn` takes an arbitrary `amountCents` — partial is mechanically supported |
| 2 | Commission clawback on reversal | Pending | `finos.js:292` debits a seller clawback; precedent exists, policy does not |
| 3 | Gateway fee treatment | Pending | **Not modelled at all** — no gateway/processing fee concept in `finos-utils` |
| 4 | Wallet debit after the merchant has withdrawn | Pending | Would fail: `debitWalletTxn` throws on insufficient balance unless `allowNegative` |
| 5 | Negative wallet balances allowed | Pending | `allowNegative: false` today. Flipping it is one flag — and a solvency decision |
| 6 | Disputes vs voluntary refunds | Pending | `finosDisputeEscrow` / `finosResolveDispute` exist and are separate from refunds |
| 7 | Merchant notification | Pending | `adminSubProcessRefund` already notifies "refund processed" **for a refund that moved no money** — must be reconciled |
| 8 | Audit requirements | Pending | `refunds`, `entitlementAuditLog`, `commissionReviewQueue` exist |

Decisions 4 and 5 are the same question asked twice and should be answered
together: if a merchant has withdrawn funds before a reversal arrives, either the
wallet goes negative (a receivable) or the debit fails and the loss sits somewhere
undefined. There is no third option, and today the code silently takes the second.

Decision 3 also governs the existing credit path: `providerNet` is currently net of
commission only, so introducing a gateway fee changes the reconciliation identity in
`RELEASE_SEQUENCE.md` and requires re-derivation rather than a patch.

Once these are approved, implementation is wiring `debitWalletTxn` into a reversal
branch — the same shape as the credit path, using FinOS and adding no new authority.

---

## ADR-0016 — Wallet STK Push: the first user-visible instance of the invoker gap

**Status:** OPEN — one IAM binding, not applied here (gcloud unavailable in this environment)
**Date:** 2026-07-24

### Symptom

"Request STK Push" in the wallet does nothing. No STK prompt reaches the phone.

### Where the chain breaks

| Stage | Status | Evidence |
|---|---|---|
| Client sends request | ✅ | `_initiateTopUp()` in `sfos-wallet.html` calls `httpsCallable(fns,'initiateWalletTopUp')` |
| Cloud Run invocation | ❌ | **403 before the handler runs** |
| Function handler | ❌ | never reached |
| IntaSend / STK / callback / wallet credit | ❌ | never reached |

### Root cause — infrastructure, not code

```
service                invoker     probe   ingress
initiatewallettopup    (NONE)      403     INGRESS_TRAFFIC_ALL
confirmwallettopup     allUsers    401     INGRESS_TRAFFIC_ALL
```

The two are consecutive functions in the same flow and the same file
(`functions/wallet.js`), deployed together, with identical ingress. The only
difference is the `roles/run.invoker` binding. 403 is rejection at the invocation
layer; 401 is the healthy "reached the function, its own auth rejected it".

**No application code is at fault.** The client is correct and the handler is
correct; the request never arrives.

This is the first time a documented entry in `CALLABLE_INVOKER_GAPS.md` has been
observed as a user-visible symptom rather than a table row —
`initiateWalletTopUp` was already among the 346.

### Service name was verified, not assumed

The audit previously derived the Cloud Run service name as `id.toLowerCase()`. That
is an assumption about how Cloud Functions v2 names its backing service, and it sits
in the one field used to address the resource — where a wrong value returns an EMPTY
POLICY rather than an error, and reads as "no bindings". `functions:list` reports
the real name in `runServiceId`; the tool now prefers it. Confirmed for this case:
`runServiceId = initiatewallettopup`, `GET` on that service returns 200.

### Remediation

```bash
gcloud run services add-iam-policy-binding initiatewallettopup \
  --region=us-central1 --member=allUsers --role=roles/run.invoker --project=sokoni-aeb26
```

Grants the binding `confirmWalletTopUp` already holds. Security is unchanged: the
function still enforces `request.auth` internally, which is the real boundary for a
callable.

### Audit trail to record on resolution

```
Before:  initiateWalletTopUp → 403   (rejected at invocation layer)
After:   initiateWalletTopUp → 401   (handler reached, unauthenticated rejected)
Then:    authenticated request → STK initiation → callback → wallet credit
```

Verify the transition with
`node scripts/audit-callable-invokers.js initiateWalletTopUp --probe` BEFORE testing
any downstream stage. Phases 3–6 of the wallet investigation (gateway, callback,
wallet credit, transfers, replay) were deliberately not started: they sit downstream
of a request that never arrives, so results would be uninterpretable.

Note the callback destination remains the open question in **ADR-0014**.
