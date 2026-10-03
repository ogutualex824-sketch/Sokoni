# Merchant v2 — target architecture (receipts, POS, workspace)

**Status:** TARGET, recorded deliberately. **Nothing here is built.** It exists so the remaining
messaging / location / release gates can be closed without anyone inventing a parallel POS or a
second receipt model in the meantime.

Related: [[CANONICAL_ORDER_DESTINATION]] · [[MESSAGES_PLATFORM_CENSUS]] · [[MERCHANT_SHELL_CAPABILITY]]

---

## 1. Merchant v2 is the workspace; POS Setup is advanced configuration

```
approval → shop setup → MERCHANT V2  ← the operating workspace
                          Dashboard · Orders · Sell/POS · Messages · Inventory
                          Customers · Payments · Delivery · Receipts · Analytics
                             ↓
                    Print / Share / WhatsApp / Delivery
```

**`pos-setup.html` stops being a doorway.** An approved merchant with an active shop sells from v2
immediately. POS Setup becomes **Settings → POS & Terminals**: printer pairing, terminal
registration, multiple tills, receipt templates, cashier permissions, payment-terminal config, test
prints, diagnostics, offline testing, advanced tax/receipt settings.

Configuration is for merchants who need it, not a toll gate for merchants who don't.

## 2. Receipt identity — one record, reconcilable

Every receipt carries enough to reconcile it, whether the sale began online or at the counter:

```
receiptId  orderId  transactionId  createdAt
sellerUid  shopId   terminalId?    paymentMethod  fulfillmentType
```

`terminalId` is present only where a terminal exists — absent for a phone sale, and **not**
fabricated.

### The timestamp rule

**The stored timestamp is the SERVER's and is immutable. The device clock is display only.**

A phone clock is user-settable and must never be the authority on a financial record. The UI
formats local time for the merchant; the receipt, order, payment, POS sale and delivery record all
carry the *same* server timestamp, so the same sale never appears at two different times in two
different views.

This mirrors what `merchantAdjustStock` already does — `serverTimestamp()` written inside the
transaction alongside the value it timestamps.

## 3. Sell → receipt, in one surface

Sell captures items, discount, payment method, cash received and change, and fulfilment — pickup or
delivery — without leaving v2. On completion it shows the receipt id and server time, with **Print**
and **Share** side by side (as the order sheet already does), plus View Order / Send Receipt /
Start New Sale.

**Delivery capture feeds the canonical destination, not a POS-only address model.** That is the
whole reason this document exists: the destination contract
([[CANONICAL_ORDER_DESTINATION]]) is **still unresolved**, and building a POS location form now
would add an eleventh spelling to the ten already measured.

> **Blocked until the destination census runs.** POS may read an existing destination; it must not
> write one.

## 4. P58E should be owned by the shell, not an iframe

The printer connection belongs to the v2 shell's device layer, so a merchant can
**sell → pay → change → pickup/delivery → complete → print → share → sell again** without a page
change.

**Today v2 frames POS**, and an iframe cannot share a GATT handle without a native rebuild. That is
already recorded as the expected cause if the P58E device check fails across
`v2 → POS → Orders → Analytics → POS` ([[RUNBOOK_p58e_and_pos_device_checks]]). This is the
architectural reason to eventually render POS natively — not a reason to start now.

## 5. Sequencing — what must close first

```
1  messaging authority        DONE   51/0 code, not deployed
2  history scoping            DONE   21/0 rules (emulator), not released
3  canonical destination      BLOCKED — data census not yet run
4  messaging Function release  one coherent deploy
5  premium Messages UI
6  receipts + native POS       ← this document
```

**Nothing in section 3 may be built before item 3 closes.** A beautiful POS location form on top of
ten competing destination fields would be the most expensive mistake available here.

## 6. Explicitly NOT a licence to

- create a second POS, a second receipt model, or a POS-only address schema
- write any new destination field
- trust the device clock for a stored financial timestamp
- make POS Setup a prerequisite for selling
- render a receipt total that was not produced by the same server authority as the order

## Header chrome: profile menu

The shell header carries the shared avatar → account dropdown → role switcher, mounted from `sokoni-profile-menu.js` (the same module `shared-header.js` injects on every other page). Authority, API and certification: [[SHARED_PROFILE_MENU]].

## Availability: the schedule saves through the server (2026-10-03)

Availability is **server-authoritative** (owner rule). The Merchant V2 schedule editor (`#availability`, built in
`6775b09`) used to write `providerAvailability/{uid}` and `shops/{uid}.openingHours/hours` **from the browser**. Its
SAVE now goes to **`kasshop.setShopAvailability`** (owned by sokoni-2f, `convergence/commercial-fn-on-ef1e992`) via
the shell's `_callable()` (same App Check path as every other merchant callable). The UI is unchanged.

| | Before | After |
|---|---|---|
| Save | `setDoc(providerAvailability/{uid})` + `updateDoc(shops/{uid})` | `_callable('setShopAvailability')({ schedule: { hours, overrides } })` (+ `shopId` for an employee) |
| Who decides the shop | `S.uid` (the browser) | server: owner from auth, employee via `shopId` + `manageAvailability` |
| `shops/{id}.openingHours` | human string (`formatWeek`) | the SAME structured object as `providerAvailability.hours` (server, same transaction) |
| Overrides | merged (a removed date could survive) | REPLACED by the server (a removed date stops applying) |
| Failure | toast; shop-record write could half-succeed | honest message, form stays unsaved, **no fallback write — ever** |
| Load | direct `getDoc(providerAvailability/{uid})` | unchanged (rules govern reads) |

- "Saved" is shown only after the callable **resolves with `success: true`**.
- Not available (`not-found` / `internal` / `unavailable` / offline, or the pre-schedule 2026-09-09 build answering
  `No availability fields supplied.`) → *"Couldn't save — the schedule service isn't available yet. Nothing was changed."*
- Client preflight mirrors the server's limits (≤6 periods a day, ≤120 dates, dates from 31 days ago to 400 days ahead).
  An out-of-range date **blocks** the save with its name — never silently pruned, because the server replaces the map.
- Proof: `scripts/test-merchant-availability-server-save.js` (token-aware static scan of every merchant file, VM run of
  the real save code, contract cross-check against 2f's source, negative control `--control=reinsert-setdoc`).

**DEPLOY PRECONDITION (hard):** requires functions: setShopAvailability live (verify with a functions list before the hosting deploy).
It must be the **schedule-capable** build from 2f's functions release. On 2026-10-03 the listed `setShopAvailability`
is the 2026-09-09 build (`setshopavailability-00003-fab`, live switches only): a name in the list is necessary but
NOT sufficient — confirm the deployed revision carries `schedule`. Order: 2f functions release (lineage gate + owner
go-ahead) → this hosting change → f3's rules deny on client `providerAvailability` writes.

**Gaps handed to 2f / follow-ups (not fixed here):**
- `shops/{id}.hours` (the human-readable copy the old client wrote) is no longer refreshed by any merchant save; the
  server writes only `openingHours` (structured). Any reader of `shops.hours` as text sees the last pre-cutover value.
- The editor still READS `providerAvailability/{S.uid}` — correct for an owner; an employee session reads its own uid's
  document (pre-existing). `getShopAvailability` (settings mode) is the server read that resolves the owner.
- Override fields other than `closed` / `periods` / `label` are not kept by the server; the editor never edits any.
- `availability-manager.html` and `provider-dashboard.html` still write `providerAvailability` from the browser —
  provider/booking surfaces, outside Merchant V2; their own slice.

Related: [[SHOP_AVAILABILITY_AUTHORITY]] · [[AVAILABILITY_CERT_ACCEPTANCE]]

### Availability → paid service bookings: locked prerequisite and regression plan (owner, 2026-10-03)

Availability is a **locked prerequisite for certifying paid service bookings**. Sequence (each step gates the next):

1. This schedule-editor change (merchant-v2 saves via `setShopAvailability`) — built, not deployed.
2. 2f's functions release carrying the schedule-capable `setShopAvailability` (lineage gate + owner go-ahead), **then**
   this hosting change. Precondition: requires functions: setShopAvailability live (verify with a functions list before the hosting deploy).
3. Verify availability is server-authoritative: f3's rules deny on client `providerAvailability` writes is live.
4. The booking regression below. 2f's booking side (commercial-fn `8d127ab`): `booking-service._prepareSlot` consults
   `kasshop.verdictFor` at the slot's instant (not taking orders, closed date, temporary closure, canonical hours);
   slot locks are taken in the booking transaction.

**QUEUED runtime suite — `scripts/test-availability-booking-regression.js`** (written, NOT run: needs Auth + Firestore +
Functions emulators). It **refuses** (exit 2) unless every emulator host is localhost, the project is `demo-*`, and no
`GOOGLE_APPLICATION_CREDENTIALS` is set (refusal verified 2026-10-03 with no env and with a production project id).

| Row | Asserts | Note |
|---|---|---|
| R1 | provider B → `setShopAvailability({ shopId: A, schedule })` is `permission-denied`, A's document unchanged | |
| R2 | a direct browser write to `providerAvailability` is rejected (403) | **BLOCKED until f3's rules deny is loaded** (`SOKONI_F3_RULES_DENY=<commit>` + the rule present) — never a pass before then |
| R3 | two concurrent bookings of one slot → exactly one succeeds, exactly one slot lock | |
| R4 | booking on a closed date / during a temporary closure (both set via the callable) → refused | `CLOSED_DATE` / `TEMPORARILY_CLOSED` |
| R5 | schedule saved via the callable is what `verdictFor` uses: inside hours books, outside is `out-of-range`; re-saving moves the gate | |
| PC | positive control: a plain in-hours booking succeeds | if it fails, R3–R5 are BLOCKED (fixture), not pass/fail |

Exit: 0 pass · 1 fail · 2 refused · 3 blocked rows only. Fixture is a salon with a fee-0 service. **Paid Education and
electronics receipts stay OFF** (owner) — the suite never enables or test-enables them.

## Session model: one shell for merchants AND providers (owner, 2026-10-03)

Owner decision: **"Provider mode in merchant-v2"** — one shell, two session kinds. This section is the SHELL half;
the Marketing module (`sokoni-merchant-mktpro.js`, `mkt-*` routes, group *Marketing services*) is sokoni-b2's, on a
separate branch. Related: [[NAVIGATION_CONTRACT]], [[MERCHANT_ROUTE_MATRIX]], [[CAPABILITY_AUTHORITY_READ_MODEL]].

### Resolution order (`resolveShop` → `resolveProviderSession`, `merchant-v2.html`)

1. **Shop resolves** (`shops/{uid}`, else `shopEmployees/{uid}.shopOwnerId`) → `merchantIdentity({shopId})` →
   **merchant session**, exactly as before (`S.session = 'merchant'`; capabilities = merchantIdentity's list).
   A shop always wins — `providers/{uid}` is never read and `businessWorkspace` is never called.
2. **No shop, `providers/{uid}` exists** → **provider session** (`S.session = 'provider'`). The doc is read ONLY to
   learn that the account is a provider and its display name (`name` / `businessName` / `displayName`). Its fields are
   owner-writable and are **never** a source of capability. One call: `providerDispatch {op:'businessWorkspace'}`
   through the shell's `_callable` path (App Check attested). The answer is mapped by `sokoni-merchant-session.js`.
3. **Neither** → the existing no-shop state, unchanged (`S.session = null`, `S.shopError = 'no-shop-document'`).
   A failed `providers/{uid}` read also stays here (`S.providerError`) — never a provider session on a guess.

`S.session` is `null` while resolving and in the no-shop state; the contract treats `null` as the merchant shell, so
nothing about a resolving, merchant, or no-shop session changed.

### Server answer contract → `S.capabilities` (`SokoniMerchantSession.mapWorkspace`)

`businessWorkspace` (functions/business-workspace.js `workspaceFor` + the handler) answers
`{ found, state, reason, message, label, category, route, modules:{key:{state,reason}}, approval:{state}, serviceCapabilities, marketing, marketingCategories }`.

| Answer | Capability | Condition |
|---|---|---|
| `marketing === true` | `marketing` | **strict boolean only** — missing, `'true'`, `1`, `{}` grant nothing. Computed by sokoni-b2's server (`e4f9b7d`): `applicationDecisions/marketing_{uid}.approvedCategories` ∩ the provider listing, fail closed; a self-written `providers.marketing*` yields `false`. |
| `modules[k].state === 'AVAILABLE'` | `module:<k>` | only when `state === 'AVAILABLE'` (a routed answer) **and** `approval.state === 'VALID_APPROVAL'`. A holding answer's AVAILABLE overview/settings grant nothing. |
| `capabilities: [...]` (future) | each well-formed string | same approval gate; `'marketing'` in this list is ignored — only the boolean grants it. |
| `marketingCategories` | — | exposed read-only as `S.workspace.marketingCategories` (frozen; empty unless `marketing === true`). |

`module:` is a namespace so a provider module key (`modules.marketing` is the provider's OWN promotion module,
AVAILABLE for every approved provider) can never collide with a merchant capability (`sell`) or a group gate
(`marketing` = approved to SELL marketing services). Refused / malformed / unavailable → `S.capabilities = []` and
`S.sessionNotice = "Your provider workspace isn't available yet — <server reason>."`, shown above every surface
(`#session-notice`, `role=status`). Header: provider display name, else the account email — never a placeholder.

**Trust dependency.** The approval half is trustworthy only once sokoni-5b's P0 (*approval needs SERVER evidence*,
`0cb93bd`, shipped with `7db4c76` on `hotfix/approval-authority-on-c7e26b6`) is live. Until then nothing security-
relevant may rely on it — every operation behind a module is still refused by its own server gate (C2b
`assertModule`). The `marketing` key exists only on b2's server line; until it deploys the key is absent and the
marketing group stays hidden (fails closed).

### Editable — `S.editable` from the SAME answer (P0-F, owner 2026-10-03)

Owner invariant: application status is WORKFLOW, not authorization — every hub consumes ONE approval answer, and a
deactivated / suspended / frozen owner is shown edit UIs **read-only** rather than offered saves the server/rules refuse.
The one decision is `sokoni-edit-authority.js` (`SokoniEditAuthority.decide(answer, claims)`, pure), reached through
`SokoniMerchantSession.editableOf`. Server contract: `approval.state` token **`'VALID_APPROVAL'`** (sokoni-5b `f85039a`,
`shared/approval-remediation.js` `STATES.VALID`); `ownerState` + `editable` (sokoni-5b `1a5c9e5`, `ownerStateOf`).

| Answer | `S.editable` |
|---|---|
| `editable === true` | editable — **wins** over the interim signals |
| `editable` false / missing / non-boolean | **read-only**; reason from `ownerState`: frozen → "frozen by SOKONI", suspended → "suspended", deactivated → "deactivated — reactivate your account" (+ `action.href = /profile.html`), unknown → "status unknown", active-but-false → "your business status does not allow changes yet" |
| old server (no `ownerState`) | interim reason: ID-token claim `deactivated === true` → deactivated; `approval.state !== 'VALID_APPROVAL'` → approval; otherwise "status unknown" — still read-only |
| no answer / callable error / authority module missing | read-only, "status unknown" (fails closed) |

`S.editable` is `{editable, readOnly, reasonCode, reason, ownerState, source, action}` (frozen) in a provider session,
`null` outside one (the merchant session's authority is `merchantIdentity`). Modules read `SokoniShell.editable()`;
framed modules receive a plain copy in the `session` postMessage. Every page shows the one sentence
`SokoniEditAuthority.message(d)` = "Your account can’t make changes right now (<reason>)". Never derived from
`application.status`, `adminApproved`, `approvedBy` or `verified`. Tests: rows E0–E20, controls X-e / X-f.

### Route key `sessions` (sokoni-merchant-routes.js)

`sessions: ['merchant'] | ['provider'] | ['merchant','provider']` — **absent = `['merchant']`**, so every route that
predates provider mode stays merchant-only without being edited (POS, Sell, Inventory, Products, Devices, Staff,
Orders, Settings, Plan, Payments, Dashboard… can never mount for a provider by omission). `validate()` accepts only a
non-empty array of `'merchant'|'provider'` without repeats. Provider-capable today (inspected, conservative):

| Route | Why |
|---|---|
| `messages` | participant-scoped through `messagesDispatch`; ctx SELLER_UID only; the module refuses only `not_signed_in` and never reads `S.activeShopId`. |
| `home` (exit) | leaving for the marketplace needs no shop. |
| `signout` (exit) | every session must be able to end itself. |

**Gated provider route (2026-10-03):** `rates` — `sessions:['provider']` ONLY, in group `services`
(`requires:'module:services'`). The one generic rate-card editor, [[RATE_CARD_EDITOR]]. The rule "ungated provider
routes are exactly home / messages / signout" is unchanged (test C2); `rates` is the only gated provider route (C2b)
and the only provider-only route (C5b), so it never mounts in a merchant session.

**Left merchant-only (gaps for b2/2f):** Payments/Financial Center (ledger is `sellerPayments`; wallet withdraw is
`requestSellerPayout` + merchant entitlements — providers use `providerGetEarnings`/`providerRequestPayout`);
Plan (`plans.html` = merchant `subGetStatus/subActivate`; providers use `providerSelectPlan`); Settings (a shop hub:
business profile, devices, delivery); Disputes (`getSellerDisputes`, order-scoped, bookings not covered); KRA Tax
(account-scoped and would work, but `etimsRegisterSeller` is seller-shaped — needs an owner decision); Reviews (no
merchant-v2 route exists; providers have `providerGetReviews`); Dashboard (shop KPIs).

### Group key `requires` (MORE_GROUPS)

`{ key, label, requires:'<capability>', ids:[...] }` — the group's heading and routes appear, and its routes are
navigable, only when `can(requires)` is `true`. Fails **closed**: no capabilities (resolving, refused, error) → hidden.
Works in both sessions. `validate()`: `requires` must be a non-empty string; a gated route must not also appear
ungated elsewhere (another group, the bottom nav, the Settings hub links; PRIMARY_ORDER is excluded by tier).

### One mount decision

`SokoniMerchantRoutes.mountRefusal(id, session, can)` → `null` or `'unknown-route' | 'session:<s>' | 'requires:<cap>'`.
The shell's sidebar, bottom nav, palette AND `go()` all ask it. A refused navigation renders a named refusal panel
(`data-why`) — never another destination. Exception, by design: when the shell's own DEFAULT route (no hash asked for)
is not mountable once a provider session lands, it lands on the first mountable sidebar destination — a default is not
a request. A gated deep link refused while capabilities were `[]` is re-evaluated when the session lands. The nav is
re-projected on session events but rebuilt only when the mountable set changed, so a merchant's nav is never touched.

Tests: `scripts/test-merchant-provider-session.js` (VM over the real shell source; negative controls X-a…X-d).
Browser certification (real sign-in as a provider-only account; notice rendering; phone layout) is **QUEUED** (RAM floor).
