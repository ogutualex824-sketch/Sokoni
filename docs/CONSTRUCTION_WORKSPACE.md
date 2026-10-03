# Construction Workspace (merchant-v2)

Related: [[Construction Hub Convergence]] (`docs/CONSTRUCTION_HUB_CONVERGENCE.md`, sokoni-f3) · [[Marketplace]] ·
[[Orders]] · [[Work Engine]] · `docs/JOBS_EMPLOYER_WORKSPACE.md` (the pattern this follows) · `docs/NAVIGATION_CONTRACT.md`

**Status (2026-10-03): BUILT on `hosting/construction-workspace-on-e81d80a` (base `e81d80a`). NOT deployed. Hosting only.
Nothing here deploys without the owner.**

## What it is

The contractor / materials-supplier / equipment-rental workspace, built inside merchant-v2 in the same style as the rest
of the shell. It is not a second dashboard.

- **Routes:** ten `con-*` routes in one **Construction** sidebar group. The group is appended **last** in `MORE_GROUPS`,
  after where Jobs, Sports and Marketing land in assembly, so merging the hubs is append-only.
- **Module:** all ten routes mount one module, `sokoni-merchant-construction.js` (`SokoniMerchantConstruction`). Each
  route passes a view key, and the views share one store keyed by uid.
- **Wiring:** `_conCtx(view)` in `merchant-v2.html` builds each view's context. The `MODULES` table holds ten entries,
  and every one points at the same global.

| Route | View | Authority |
|---|---|---|
| `con-overview` | Overview: the three owner layouts, tiles and fees | Loaded data only |
| `con-leads` | Leads | `contactRequests` (direct read + one allowed update) |
| `con-projects` | Projects | SOKONI Work engine. Unbuilt, so the view is an honest entry |
| `con-rfqs` | RFQs | f3's `rfqs` route (`rfqDispatch`) when the shell has it; otherwise an honest entry |
| `con-quotes` | Quotes | Same as RFQs. When RFQs are absent, the view links to Leads ("Quote Sent") |
| `con-services` | Services | Honest dependency: the provider services surface is not reachable from merchant-v2 |
| `con-equipment` | Equipment | `commerceDispatch` `rentalProductCreate`, plus a direct read of `rentalProducts` |
| `con-availability` | Equipment availability | `commerceDispatch` `rentalGetAvailability` |
| `con-rentals` | Rentals | `commerceDispatch` `rentalList` / `rentalConfirm` / `rentalComplete` / `rentalCancel` |
| `con-verification` | SOKONI approval + application progress | approval: `providerDispatch {op:'businessWorkspace'}` (one call per page load); progress: `applications where uid == uid`, filtered to `hub == 'construction'` |

### Owner layout (via sokoni-f3)

**Contractor** has 18 sections, in the owner's order:

1. Overview
2. Storefront
3. Services
4. Products
5. Projects
6. RFQs
7. Leads
8. Quotes
9. Orders
10. Customers
11. Messages
12. Delivery
13. Equipment
14. Marketing
15. Wallet
16. Subscription
17. Verification
18. Staff

**Supplier** has five sections: Products, Inventory, RFQs, Orders and Delivery.

**Equipment rental** has three sections: Equipment, Availability and Rentals.

**Reused sections are links, not copies.** The Overview links the following sections to the routes that already exist.
No module is mounted twice, and no `con-*` route aliases an existing module.

| Section | Existing route |
|---|---|
| Storefront | `shop` |
| Products | `products` |
| Inventory | `inventory` |
| Orders | `orders` |
| Customers | `customers` |
| Messages | `messages` |
| Delivery | `deliveries` |
| Marketing | `marketing` |
| Wallet | `payments` |
| Subscription | `plan` |
| Staff | `staff` |

**Role variants:** no server capability on this tree says whether a business is a contractor, a supplier or a rental
company. The 5b `MODULES` hand-off will supply that. Until then, the Overview shows all three layouts to the owner, with
a note explaining why. The role is never inferred from a browser category.

## Leads

- **Read:** `contactRequests where sellerUid == S.uid`, with `limit 201` for a 200-row page. Hitting the cap is treated
  as an exact `hasMore`: the page shows "Showing the first 200 leads — more exist" and marks the Overview counts `N+`.
  The rows are sorted on the client. There is no `(sellerUid, createdAt)` index, the same reason df1a4cb gives.
- **Buttons:** the owner matrix below. It is a subset of `leadNext()` in the f9a5c45 combined rules. The rules also
  allow pending → contacted; the page does not offer it.

| Status | Buttons |
|---|---|
| pending | responded, qualified, lost |
| responded, contacted | qualified, quote_requested, quote_sent, lost |
| qualified | quote_requested, quote_sent, lost |
| quote_requested | quote_sent, lost |
| quote_sent | negotiating, won, lost |
| negotiating | quote_sent, won, lost |
| won, lost, cancelled, expired | none |

- **Labels:** pending shows as "New" and responded as "Contacted". Every other status is title-cased.
- **The only browser write in the workspace** is `updateDoc(contactRequests/{id})`. It is made in two places:
  - **The module** builds either `{status}` (plus `respondedAt`, only when moving to `responded`) or `{sellerNote}`.
  - **The shell writer** (`_conWriteLead`) refuses any other key, a client-clock `respondedAt` and a malformed id. It
    sends no network request in those cases. It replaces the module's `SERVER_TIME` token with `serverTimestamp()`.
  - **The rules** refuse anything else a third time.
- **Chat:** "Open chat" calls `SokoniInbox.openForTransaction('product_enquiry', leadId)`, but only when
  `SokoniInbox.TX_TYPES` contains `product_enquiry` at runtime. On this tree it does not (b2 `74c9d50` adds it), so the
  page shows a disabled "Chat coming" button. There is no WhatsApp, `tel:` or `mailto:` link anywhere.
- **Staff:** a staff session is shown "Leads go to the shop owner" and no read is made. Leads are addressed to the
  owner's account.

### Merge relationship with df1a4cb (b2 "Buyer enquiries" sheet)

df1a4cb is **not on this tree**. It is on b2's chain and on f3's intake branch. It adds a "Buyer enquiries" sheet to
merchant-v2 over the same `contactRequests` data. That sheet has two problems:

- "Mark responded" is its only action.
- It shows a `tel:` "Call" link.

When the two lines are assembled, they must end up as one enquiries surface:

1. **Repoint the sheet's button.** The Dashboard "💬 Buyer enquiries" button should call `go('con-leads')`. Alternatively,
   the sheet adopts `SokoniMerchantConstruction._pure.leadActions`, `leadMovePayload` and `leadLabel`.
2. **Delete the old sheet code:** `openEnquiries`, `markEnquiryResponded` and the `tel:` link.
3. **Keep df1a4cb's CSS and staff copy.** They are compatible.

## Equipment and rentals

### Server contract consumed

The page is built against **sokoni-f3's rentals line**: `functions/rentals-on-53100ff` @ `bebc922`. That commit adds the
ONE return PIN on top of the owner lifecycle `bb8634d`, which in turn sits on the earlier fix `74672f3` and on DE-2
Build B `53100ff`. It is **NOT deployed**. Production still serves the old
`marketplace-extensions.js`, which is byte-identical to this tree's copy and to the live `commerceDispatch` archive.

**Listings** move `draft` → `active` (shown as "Available") ⇄ `paused`. A draft or paused listing cannot be booked.

| Op | Input | Effect / returns |
|---|---|---|
| `rentalOwnerListings` | `{shopId}` | `{listings, hasMore}`: every status, newest first, capped at 200 |
| `rentalProductCreate` | `{shopId, title, pricingType, rates, deposit?, minDuration?, …}` | `{rentalProductId, status:'draft'}` |
| `rentalProductPublish` | `{rentalProductId, shopId}` | draft or paused → active |
| `rentalProductPause` | `{rentalProductId, shopId}` | active → paused |

**Bookings** follow: requested → accepted or declined → payment_pending → paid_held → active → return_pending → returned
→ completed.

- Terminal states are declined, cancelled and refunded.
- Legacy documents: `pending` means requested, and `confirmed` means accepted.

The seller page offers **only** these buttons:

| Status | Seller buttons | Op |
|---|---|---|
| requested (legacy pending) | Accept · Decline (reason required, two taps) · Cancel | `rentalAccept` (falls back to the alias `rentalConfirm` on an old server) · `rentalDecline {bookingId, shopId, reason}` · `rentalCancel {bookingId}` |
| accepted (legacy confirmed), payment_pending | Cancel (two taps) | `rentalCancel` |
| paid_held | Start hire | `rentalStart` |
| active, return_pending | Confirm return | `rentalConfirmReturn` |
| returned | Complete | `rentalComplete` |
| completed, declined, cancelled, refunded | none | none |

**Cancel is never offered on paid_held.** A paid cancellation falls under SOKONI's refund policy. If the money is held
while the page still shows Cancel, the server's refusal is shown verbatim: "This rental is paid. Cancelling it is
handled under SOKONI's refund policy…".

**`rentalReportReturn` belongs to the renter.** It is not a seller button.

### Return PIN (f3 bebc922: ONE PIN at RETURN)

The PIN authority is `booking-pin-core.js`, source `'rentalBookings'`. It is the same module that service bookings use.

**How the PIN is issued.**
1. The `rentalPinOnRentalBooking` trigger issues the PIN once the payment authority has **held** the renter's money
   (`paymentStatus === 'held'`).
2. The renter gives the PIN when the equipment comes back.
3. The seller types it into **Confirm return**. Confirming the return is what lets the held money be released on
   Complete.

**What the seller page does.**

- **Before the money is held** (requested, accepted, payment_pending), the card says "Return PIN: PIN arrives when the
  renter's payment is held." It does not show "—".
- **At paid_held there is no field.** The order is hand-over first (**Start hire**), then **Confirm return**. A paid_held
  rental cannot be returned, and the button table already reflects that.
- **At active or return_pending with `paymentStatus === 'held'`**, the card shows a 4-digit PIN field next to **Confirm
  return** and sends exactly `commerceDispatch {op:'rentalConfirmReturn', bookingId, shopId, pin}`.
  - An unheld hire (legacy or unpaid) sends no `pin`.
- **Client check:** the page only checks that 4 digits were typed. The server is the authority.
- **Refusals** are shown verbatim, followed by "Nothing was changed." This covers:
  - a wrong PIN: "That PIN does not match this booking.";
  - an expired PIN: "This PIN has expired. Ask the renter to open the rental and tap "Get a new PIN"…";
  - too many attempts: "Too many wrong PINs. Wait a few minutes before trying again."
- **Clearing:** the field has no `value` attribute on any render. It is cleared on read and after every response. The
  typed PIN is held only in the outgoing payload, never in the page state, and it is never logged.
- **Never rendered:** the renter's PIN is not rendered or stored anywhere on this seller surface. PIN-like fields on a
  booking document (`pin`, `pinHash`, `returnPin`, `bookingPin`) are ignored, and the module reads no PIN collection.
- **Staff and read-only:** the field and the button follow the edit rule (`editable === true` only). Staff are therefore
  disabled today.

**The renter-side PIN view is NOT part of this workspace.** "PIN YAKO NI BOOKING YAKO" lives in the buyer's
Messages / booking panel, owned by **sokoni-b2**. That panel calls `serviceBookingPin` with `getMyBookingPin` or
`renewBookingPin` and `source: 'rentalBookings'`.

### Payment

- **Only the payment authority writes `payment_pending` and `paid_held`.** That authority is 2f's `rental_booking`
  purpose plus the 5b webhook.
- **Labels come from the status alone:**
  - payment_pending shows "Awaiting payment";
  - paid_held shows "Paid — held by SOKONI".
- **Other fields are ignored for "paid".** `paymentStatus`, `paidAt` and `paymentMethod` never make a booking read as
  paid (R12; negative control N7).
- **Payment method** is shown as "—" until the webhook sets it. rentalBook's `'none'` is a placeholder, not a method. The
  page never supplies a default (R13; negative control N8).
- **Rental payment is priced on 2f's commercial line.** On `convergence/commercial-fn-on-ef1e992` @ `64da94c`
  (not deployed), the `rental_booking` purpose takes commission `construction_equipment_rental` at 10% of the hire,
  never the deposit.
  - So the old "paid rentals open once SOKONI sets rental pricing" copy is **removed**.
  - In its place the page explains the flow: "After you accept, SOKONI asks the renter to pay. SOKONI holds the payment
    and releases it to you when the rental is completed."
  - The fees card lists "equipment rental — 10% of the hire, never the deposit". The card is labelled as the commission
    release, not yet live.
- **The seller page has no pay step.**

### Equipment list source and errors

- **Source:** the list comes from `rentalOwnerListings`. When `hasMore` is true, the page shows "Showing the first 200 —
  more exist" and the Overview tile shows `200+`.
- **Fallback:** the direct `rentalProducts` read is used only when the server answers "Unknown commerce operation" (the
  old server). A refusal on that read shows "Rentals become visible once access rules ship".
- **Errors** (`HttpsError`) are shown verbatim, followed by "Nothing was changed."

### Open server items (sokoni-f3, 5b, 2f)

- **`active` has no writer except `rentalStart`.** For tests, payment_pending, paid_held and refunded are written
  directly to the store, the way the payment authority would write them.
- **`rentalProducts` and `rentalBookings` rules are still on f3's combined rules line.** Only the old-server fallback
  read needs them.
- **The webhook must write `paymentMethod`** on paid_held. Until it does, the page shows "—".

## Verification

**Owner invariant (2026-10-03): application status is WORKFLOW, not authorization.** Every hub consumes ONE
authoritative approval answer — never `application.status`, `adminApproved`, `approvedBy` or `verified`; no hub-local
interpretation, no fallback.

- **SOKONI approval** comes only from `providerDispatch {op:'businessWorkspace'}` (sokoni-5b `f85039a`, whose
  `approval.state` is derived by `shared/approval-authority.js isAuthoritativelyApproved`). The page shows **Approved**
  only when `approval.state === 'VALID_APPROVAL'` and, by the **server's** `answer.lane` (business-workspace.js
  `laneOf` over the server category, set on every answer; sokoni-5b ruling 2026-10-03):

  | `answer.lane` | Approved iff |
  |---|---|
  | `services` (trades, quoted-service) | VALID_APPROVAL **and** `modules.services.state === 'AVAILABLE'` |
  | `products` (materials supplier, `OWN_WORKSPACE` modules) | VALID_APPROVAL **alone** — no module key by design |
  | absent / null / anything else | `—` (fails closed) |

  The lane is never decided from the browser's category or an application field (control N12). A non-VALID approval is
  "Not approved yet" whatever the lane.
  - **Why `services`:** neither `f85039a` nor the capability line (`1a5c9e5`) has a construction module key.
    Construction trades classify to existing quoted-service provider categories (5b `cf44fc3`: trades /
    service_business / professional_services), whose capability is the `services` module. Swap the one constant
    `APPROVAL_MODULE` if 5b adds a construction key. It applies to the services lane only.
  - Otherwise: "Not approved yet" with the server's message or the plain words for the approval state
    (PENDING / NO / INVALID_LEGACY / REFUSED / BUYER_ONLY / UNREADABLE). A failed or malformed answer shows `—` with
    the reason and a retry — never a guess.
  - **One call per page load:** the shell memoises `_conWorkspace` per uid (shared by all ten views); a failure is
    forgotten so "Try again" can ask once more.
- **Application progress** reads `applications where uid == S.uid` (owner-only), `hub == 'construction'`, and shows the
  status as workflow words only — it never says "Approved":

  | Recorded status | Application progress |
  |---|---|
  | pending | Submitted — awaiting review |
  | info_requested | More information requested |
  | under_review | In review |
  | approved | Review complete |
  | rejected | Closed by review |
  | suspended | On hold |
  | withdrawn | Withdrawn |
  | anything else | title-cased |

- The old "✓ Verified" badge (`verified === true`) is **removed**: `verified` is an application field, not the authority.

## Read-only mode (P0-F)

Deactivated / suspended / revoked / frozen owners cannot edit providers or shops (f3 `1896712`), so the edit UIs render
read-only rather than offering refused saves. The decision is `sokoni-edit-authority.js` (shared byte-identical with the
provider-session and fitness branches) over the SAME businessWorkspace answer plus the ID-token claims:

| Answer | Result |
|---|---|
| `editable === true` | editable — wins over the interim signals |
| `editable` false / missing / non-boolean | read-only; reason from `ownerState`: frozen → "frozen by SOKONI", suspended → "suspended", deactivated → "deactivated — reactivate your account" (+ link to `/profile.html`), unknown → "status unknown", active → "your business status does not allow changes yet" |
| old server (no `ownerState`/`editable`) | still read-only; reason: claim `deactivated === true` → deactivated; `approval.state !== 'VALID_APPROVAL'` → "your business approval is not valid (<state>)"; else "status unknown" |
| answer missing / failed / authority not loaded | read-only, "status unknown" |
| staff (role ≠ owner) | read-only, "the shop owner's account status is not available to staff yet" — the answer describes the signed-in account, not the owner |

Controls rendered **disabled** when read-only: lead moves and the private note, List equipment / Save listing,
Make available / Pause, rental Accept / Decline / Start / Confirm return / Complete / Cancel. A banner states
"Your account can't make changes right now (<reason>)". Every action function re-checks and refuses before any write
or dispatch. Figures and lists are unaffected. **Consequence until 5b `1a5c9e5` is live:** the field is absent, so
Construction edits are read-only for everyone (owner rule) — the hosting change must ship with or after `1a5c9e5`.

## Commercial (sokoni-2f line)

- **Shown as owner-set terms that ship with the commission release (not yet live):**
  - building materials: the marketplace commission, 15%;
  - construction services: 0%.
- **Unpriced and OFF; nothing is charged:** featured listings, lead fees, rental commission and construction plans.
- **Plans** come from the catalog only: `subGetPlans({hubType:'construction'})`. The page shows only entries whose
  `hubType === 'construction'` and that have a numeric `price.monthly`. Otherwise it shows "Construction plans: —".
  There are no built-in construction plans in `sub-billing.js` today.
- **No fabricated metrics.** Overview tiles are counted from loaded server rows only:
  - unknown, refused or failed reads show `—`;
  - a real loaded empty list shows `0`;
  - a capped list shows `N+`.

## Tests

`scripts/test-merchant-construction-workspace.js` passes **84/0**: 70 rows plus 14 of 14 negative controls caught
(N9 "Approved" from applications.status → V1; N10 read-only fails open on a missing answer → RO6; N11 a badge from
`verified === true` → V3; N12 lane from applications.category → VL1; N13 a pin / pinHash field rendered from the booking → R22;
N14 Confirm return sent without the PIN when held → R19). It runs
in a node VM. The rental fixtures come from **running the real handlers** over an in-memory Firestore, with the
dispatcher's error wrapping reproduced:

- **NEW** is f3's `bebc922` source (the owner lifecycle plus the return PIN: `marketplace-extensions.js`, `booking-pin-core.js`,
  `shared/ent-booking-identity.js`), run on f3's own `fake-firestore-txn.js` @ `bebc922` and read with `git show` (`RENTALS_REF` overrides it). If that source is missing, the run
  fails closed.
- **OLD** is this tree's copy, which equals live.

 The shell writer `_conWriteLead` is lifted from
`merchant-v2.html` and executed.

| Row | What it proves |
|---|---|
| O | Unknown shows `—`, loaded zero shows `0`, capped shows `N+`; three layouts; every section resolves; reused routes exist; plan price only from a construction-priced entry; fees copy |
| L | Legal lead buttons per status (owner matrix ⊆ rules `leadNext`); labels; exact payloads; shell writer refusals; chat runtime gate; permission, staff and failure copy; exact `hasMore`; refused write |
| R | f3 bebc922 handlers: every booking state produced by the real handlers (payment-authority states written as that authority would); seller button matrix incl. legacy pending/confirmed; payment from STATUS only; method "—" until the webhook sets it; no Cancel on paid_held, refund-policy refusal verbatim; decline reason required; Accept → rentalConfirm alias on an old server; Start / Confirm return / Complete / seller Cancel; listing Draft / Available / Paused + publish / pause; Equipment via rentalOwnerListings (hasMore); direct read only on an unknown-op answer; reasons verbatim; RETURN PIN: field only on a held rental at return, exact payload with `pin`, client checks 4 digits only, wrong / expired / locked refusals verbatim, field cleared after every response, no PIN rendered from booking data, disabled when not editable |
| H | Projects, RFQs, Quotes and Services are honest; staff Verification copy |
| V | Status is "Application progress" only; Approved only for VALID_APPROVAL + services AVAILABLE; verified/adminApproved/approvedBy/status alone → not approved; failed/malformed/unwired answer → `—`; one businessWorkspace call per page load (module + shell memo) |
| VL | Lane from `answer.lane` only: supplier VALID → Approved; supplier NO_APPROVAL → not; trade VALID + services unavailable → not; unknown/absent lane → `—` |
| RO | Claim deactivated; approval not valid; editable false (frozen); editable true overrides interim; every ownerState × editable true/false/missing/"true"; missing answer fails closed; staff; figures untouched |
| S | No `wa.me`, `tel:` or `mailto:`; escaping; no Firestore write API or browser storage in the module; dispatch ops limited to the seller rental ops (never rentalBook / rentalReportReturn) |
| G | Ten `con-*` routes; Construction group last; `validate()` clean; `MODULES` wiring; no duplicate module ids; script tag |

Each negative control is a mutant that must fail its named row:

| Control | Mutant | Row that must fail |
|---|---|---|
| N1 | Illegal lead button (pending → won) | L1 |
| N2 | Extra field in the lead move payload | L3 |
| N3 | A pay button on a rental | R2 |
| N4 | `0` rendered for an unknown count | O1 |
| N5 | Direct `rentalProducts` read used although `rentalOwnerListings` exists | R10 |
| N6 | Cancel offered on paid_held | R14 |
| N7 | "Paid" derived from a non-status field (`paymentStatus`) | R12 |
| N8 | An M-PESA default payment method | R13 |
| N13 | A `pin` / `pinHash` field rendered from the booking document | R22 |
| N14 | Confirm return sent without the PIN when held | R19 |

Re-run on this branch:

| Suite | Result |
|---|---|
| `test-merchant-routes` | 65/0 |
| `test-mv2-1-sidebar` | 14/0 (R3 now expects `…\|Back office\|Construction`) |
| `test-mv2-1-sidebar` after assembly | R3 must expect `…\|Back office\|Jobs\|Sports\|Construction` (assembly order: chain → Jobs → Sports → Construction) |
| `test-merchant-v2-panels` | 20/0 |
| `test-inshell-chrome` | 30/0 |
| `test-merchant-products-native` | 23/0 |
| `test-merchant-receipts-native` | 28/0 |
| `test-rider-navigation` | 24/0 |
| `verify-nav-identity-honest` | 8/0 |
| `test-merchant-exit-contract` | 18/0 |
| `test-merchant-flash` | 46/0 |
| syntax gate | see CHANGELOG |

`test-merchant-capability` fails 2 rows on the **base** as well. Both pin the v1 shell's withheld-route count:

- "exactly 12 routes need negotiation": the base already has 14;
- "only the 2 genuinely-new surfaces are withheld": the base already has 4.

The `con-*` routes add to both counts. Those rows predate several merchant-v2 slices and need re-baselining by their
owner.

**Browser certification is QUEUED, not run** (RAM floor). To be run on the assembled candidate:

1. Sidebar shows the Construction heading last, with its ten rows.
2. Every view mounts at 390 px with no horizontal scroll.
3. Leads: a real `contactRequests` row moves pending → responded and the rules accept it. The rules must be f9a5c45.
4. Chat opens `messages.html?tx=product_enquiry` once b2 `74c9d50` is assembled.
5. Equipment and Rentals show the rules-pending copy on the current production rules.
6. The Verification approval matches the account's `applicationDecisions` record (VALID only after an admin decision).
7. A deactivated test owner (claim `deactivated`) sees every Construction edit control disabled with the reason.

## Release dependencies (nothing deploys without the owner)

| Dependency | Owner | Needed for |
|---|---|---|
| Combined rules **f9a5c45** (lead lifecycle) and the rental rules | sokoni-f3 | The lead lifecycle beyond responded; rental reads |
| Intake **98589b6** (`hosting/construction-intake-on-d824b58`) and containment **3a8f366** | sokoni-f3 | Construction applications existing to show |
| `product_enquiry` TX (`74c9d50`, server d5d81d6) and df1a4cb contact flow | sokoni-b2 | "Open chat"; leads being created at all |
| Commission line: materials 15%, construction_service 0%, unpriced layers OFF | sokoni-2f | The fees copy becoming live fact |
| f3 rentals line `bebc922` (owner lifecycle `bb8634d` + return PIN; `functions/rentals-on-53100ff`, on `74672f3` / DE-2 Build B `53100ff`): **ship with or before this hosting change**, together with `rentalPinOnRentalBooking`. That trigger is deployed scoped, only after the providerDispatch booking-PIN release is live and only from a byte-identical `booking-pin-core.js` (5b). The old server still works through the fallbacks, but real owners are refused | sokoni-f3 | Rentals working for real owners |
| 2f `rental_booking` purpose + commission 10% (`64da94c`), 5b webhook (paid_held + paymentMethod) | sokoni-2f / 5b | Awaiting payment / Paid — held states existing at all |
| Rental rules | sokoni-f3 | The old-server fallback read |
| Renter PIN view (`serviceBookingPin` `getMyBookingPin` / `renewBookingPin`, `source:'rentalBookings'`) in the buyer's Messages / booking panel | sokoni-b2 | The renter having a PIN to give at return |
| Server role or module answer (contractor / supplier / rental) | sokoni-5b | Per-role sections in place of all three |
| RFQ module `sokoni-merchant-rfq.js` (`hosting/b2b-on-7b5171e`) | sokoni-f3 | RFQs and Quotes linking to `rfqs` |
| SOKONI Work engine | owner programme | Projects |
| ONE approval authority `f85039a` (`hotfix/approval-authority-on-c7e26b6`; P0-H migration first) | sokoni-5b | "Approved" meaning server evidence |
| `ownerState` + `editable` on businessWorkspace `1a5c9e5` (`feat/education-workspace-on-d377b28`) | sokoni-5b | Construction edits being enabled at all (without it everything is read-only) |
