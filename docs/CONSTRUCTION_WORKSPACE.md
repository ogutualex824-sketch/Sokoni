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

### Server shapes

These were read from `functions/marketplace-extensions.js`. It is byte-identical to the live `commerceDispatch` archive,
and every op below is in the live `_h` map.

| Op | Input | Returns |
|---|---|---|
| `rentalProductCreate` | `{shopId, title, pricingType ∈ hourly/daily/weekly/monthly/flexible, hourlyRate?, dailyRate?, weeklyRate?, monthlyRate?, deposit?, minDuration?, maxDuration?, terms?, description?, category?, images?}` | `{rentalProductId}` |
| `rentalGetAvailability` | `{rentalProductId}` | `{unavailablePeriods:[{start,end}]}` (pending, confirmed and active bookings in the last 200 bookings) |
| `rentalList` | `{shopId}` | `{bookings[]}`, at most 100, sorted on the server |
| `rentalConfirm` | `{bookingId, shopId}` | `{success}` (pending only) |
| `rentalComplete` | `{bookingId, shopId}` | `{success}` (no status check on the server) |
| `rentalCancel` | `{bookingId, reason?}` | `{success}` |

### What the page does

- **Buttons:**
  - pending: Confirm and Cancel.
  - confirmed or active: "Mark returned" and Cancel.
  - closed bookings: none.
- **Cancel** takes two taps.
- **Price:** the price SOKONI calculated is labelled "Not paid through SOKONI".
- **No pay step.** The page always shows "Paid rentals open once SOKONI sets rental pricing." Rental commission is
  unpriced, so `calculateCommission` refuses `category_unpriced`.
- **Listing read refused:** a `permission-denied` read of the equipment list shows "Rentals become visible once access
  rules ship". It never shows an empty list.
- **Session-only listings:** an item created in this session appears as "Listed in this session", with the caveat that
  buyers cannot see it. It is held in memory only, with no browser storage.

### Server gaps (owner: sokoni-f3, measured by running the real handlers)

1. **`_assertSeller` checks `shops/{id}.ownerId`, a field the shop identity model does not have.** Shop ownership is
   `uid === shopId`, and `merchant-identity.js` says there is no ownerId field. As a result, an owner whose shop document
   lacks `ownerId` is refused by `rentalList`, `rentalProductCreate`, `rentalConfirm` and `rentalComplete`. The suite
   reproduces this (R4).
2. **`rentalCancel` authorises a seller by `auth.token.shopId`, a claim nothing mints.** Seller cancellation is therefore
   refused. The page says "Nothing was changed" (R9).
3. **`rentalComplete` does not check the booking status.** It can complete a pending or cancelled booking. The page only
   offers it on confirmed or active bookings.
4. **Handlers throw plain `Error`s, which the dispatcher wraps as `internal`.** The client never sees the reason, such as
   `dates-not-available` or `forbidden`.
5. **There is no rules block for `rentalProducts` or `rentalBookings`.** f3 is adding them on the combined rules line.
6. **There is no op that lists a seller's equipment.** The page reads `rentalProducts where shopId == activeShopId`
   directly. That read works once the rules ship.
7. **`rentalBook` records `paymentMethod: 'mpesa'` by default** even though no payment exists. That is misleading data
   (buyer side; not used here).

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

`scripts/test-merchant-construction-workspace.js` passes **39/0**: 35 rows plus 4 of 4 negative controls caught. It runs
in a node VM. The rental fixtures come from **running the real handlers** of `functions/marketplace-extensions.js` over an
in-memory Firestore, with the dispatcher's error wrapping reproduced. The shell writer `_conWriteLead` is lifted from
`merchant-v2.html` and executed.

| Row | What it proves |
|---|---|
| O | Unknown shows `—`, loaded zero shows `0`, capped shows `N+`; three layouts; every section resolves; reused routes exist; plan price only from a construction-priced entry; fees copy |
| L | Legal lead buttons per status (owner matrix ⊆ rules `leadNext`); labels; exact payloads; shell writer refusals; chat runtime gate; permission, staff and failure copy; exact `hasMore`; refused write |
| R | Buttons per booking status; no pay step; unpriced and rules-pending copy; owner-without-ownerId refusal; create payload and validation; confirm, availability and cancel through the real handlers |
| H | Projects, RFQs, Quotes and Services are honest; Verification never claims "Verified" without `verified === true` |
| S | No `wa.me`, `tel:` or `mailto:`; escaping; no Firestore write API or browser storage in the module; dispatch ops limited to the six seller rental ops |
| G | Ten `con-*` routes; Construction group last; `validate()` clean; `MODULES` wiring; no duplicate module ids; script tag |

Each negative control is a mutant that must fail its named row:

| Control | Mutant | Row that must fail |
|---|---|---|
| N1 | Illegal lead button (pending → won) | L1 |
| N2 | Extra field in the lead move payload | L3 |
| N3 | A pay button on a rental | R2 |
| N4 | `0` rendered for an unknown count | O1 |

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
| Rental server fixes (gaps 1–4 above), rental rules, rental IntaSend purpose | sokoni-f3 / 5b / 2f | Rentals working for real owners; paid rentals |
| Server role or module answer (contractor / supplier / rental) | sokoni-5b | Per-role sections in place of all three |
| RFQ module `sokoni-merchant-rfq.js` (`hosting/b2b-on-7b5171e`) | sokoni-f3 | RFQs and Quotes linking to `rfqs` |
| SOKONI Work engine | owner programme | Projects |
