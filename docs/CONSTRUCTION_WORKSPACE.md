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
| `con-verification` | Construction application | `applications where uid == uid`, filtered to `hub == 'construction'` |

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

The page is built against **sokoni-f3's owner rental lifecycle**: `functions/rentals-on-53100ff` @ `bb8634d`, which sits
on the earlier fix `74672f3` and on DE-2 Build B `53100ff`. It is **NOT deployed**. Production still serves the old
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

The page reads `applications where uid == S.uid` (owner-only read) and keeps only `hub == 'construction'`.

- **Status:** shown as the application records it:

  | Recorded status | Label |
  |---|---|
  | pending | Submitted — awaiting review |
  | info_requested | More information requested |
  | approved | Approved |
  | rejected | Not approved |
  | suspended | Suspended |
  | anything else | title-cased |

- **"✓ Verified"** appears only when `verified === true`. `verified` is in `noAdminFields()`.
- **Finding for the rules line:** `status`, `decidedBy` and `decidedAt` are **not** admin-only fields. Under the current
  rules the applicant can rewrite their own application's status label. That is cosmetic, because roles are granted on
  the server, but the label alone is not proof. That is why "Verified" depends on `verified === true` and not on
  `status`.

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

`scripts/test-merchant-construction-workspace.js` passes **52/0**: 44 rows plus 8 of 8 negative controls caught. It runs
in a node VM. The rental fixtures come from **running the real handlers** over an in-memory Firestore, with the
dispatcher's error wrapping reproduced:

- **NEW** is f3's `bb8634d` source (the owner rental lifecycle), read with `git show` (`RENTALS_REF` overrides it). If that source is missing, the run
  fails closed.
- **OLD** is this tree's copy, which equals live.

 The shell writer `_conWriteLead` is lifted from
`merchant-v2.html` and executed.

| Row | What it proves |
|---|---|
| O | Unknown shows `—`, loaded zero shows `0`, capped shows `N+`; three layouts; every section resolves; reused routes exist; plan price only from a construction-priced entry; fees copy |
| L | Legal lead buttons per status (owner matrix ⊆ rules `leadNext`); labels; exact payloads; shell writer refusals; chat runtime gate; permission, staff and failure copy; exact `hasMore`; refused write |
| R | f3 bb8634d handlers: every booking state produced by the real handlers (payment-authority states written as that authority would); seller button matrix incl. legacy pending/confirmed; payment from STATUS only; method "—" until the webhook sets it; no Cancel on paid_held, refund-policy refusal verbatim; decline reason required; Accept → rentalConfirm alias on an old server; Start / Confirm return / Complete / seller Cancel; listing Draft / Available / Paused + publish / pause; Equipment via rentalOwnerListings (hasMore); direct read only on an unknown-op answer; reasons verbatim |
| H | Projects, RFQs, Quotes and Services are honest; Verification never claims "Verified" without `verified === true` |
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
6. The Verification status matches AdminOS.

## Release dependencies (nothing deploys without the owner)

| Dependency | Owner | Needed for |
|---|---|---|
| Combined rules **f9a5c45** (lead lifecycle) and the rental rules | sokoni-f3 | The lead lifecycle beyond responded; rental reads |
| Intake **98589b6** (`hosting/construction-intake-on-d824b58`) and containment **3a8f366** | sokoni-f3 | Construction applications existing to show |
| `product_enquiry` TX (`74c9d50`, server d5d81d6) and df1a4cb contact flow | sokoni-b2 | "Open chat"; leads being created at all |
| Commission line: materials 15%, construction_service 0%, unpriced layers OFF | sokoni-2f | The fees copy becoming live fact |
| f3 owner rental lifecycle `bb8634d` (`functions/rentals-on-53100ff`, on `74672f3` / DE-2 Build B `53100ff`): **ship with or before this hosting change**. The old server still works through the fallbacks, but real owners are refused | sokoni-f3 | Rentals working for real owners |
| 2f `rental_booking` purpose + commission 10% (`64da94c`), 5b webhook (paid_held + paymentMethod) | sokoni-2f / 5b | Awaiting payment / Paid — held states existing at all |
| Rental rules | sokoni-f3 | The old-server fallback read |
| Server role or module answer (contractor / supplier / rental) | sokoni-5b | Per-role sections in place of all three |
| RFQ module `sokoni-merchant-rfq.js` (`hosting/b2b-on-7b5171e`) | sokoni-f3 | RFQs and Quotes linking to `rfqs` |
| SOKONI Work engine | owner programme | Projects |
