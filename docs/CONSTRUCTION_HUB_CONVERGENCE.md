# Construction Hub Convergence

Related: [[Marketplace]] · [[Payments]] · [[Orders]] · [[Work Engine]] · `docs/RULES_COMBINED_CANDIDATE.md` ·
`docs/JOBS_BOARD_CONVERGENCE.md` (pattern) · B2B `docs/B2B_HUB_CONVERGENCE.md` (RFQ authority)

**Status (2026-10-03): containment + intake BUILT, NOT DEPLOYED. Not user-ready.**

## Owner decisions (2026-10-03, asked directly)

| Topic | Decision |
|---|---|
| Containment | Contain now: remove fabricated products / suppliers / prices and the fake order; cards → product page; no WhatsApp; open RFQs not public |
| Materials fee | Marketplace 15% |
| Contractor projects / services | Subscription + per-lead fee. **No % of contract value** (honours the 09-28 Work Engine rule) |
| Plans / featured / rental fees | Built unpriced, admin-configurable, **OFF** until the owner sets prices |
| Revenue paste | Rental commission, delivery margin, featured and lead fees are configurable layers, OFF until priced. Never charge both sides for one lead. A project / milestone fee needs an explicit owner number |

## Census (live 72dca56)

- **Fabricated catalogue, in production:** 30 hard-coded products and 10 suppliers, with invented ratings and "verified"
  badges, plus a seeded "AI price guide".
- **Fake order:** "Order via M-PESA" took no money and built the invoice client-side.
- **WhatsApp:** every product's WhatsApp button went to a hard-coded number.
- **RFQs:** RFQ and quote forms promised supplier replies that nothing dispatched. Open RFQs, including buyer name and
  phone, were readable by anyone.
- **Registration:** contractor registration was refused by the rules (`verified:false` is an admin field) while the page
  said "submitted".
- **Rental:** `rental.html` could never load (no `rentalProducts` read rule).
- **No server authority** for construction orders, RFQs or quotes; there are 7 client-written `construct*` collections.
- **Admin and catalogue gaps:** no AdminOS / Super Admin construction surface; no welding / fabrication / equipment
  categories; no commission rows (unmatched labels fell to the 5% default); no search indexing.

## Reuse map (no parallel systems)

| Need | Canonical authority |
|---|---|
| Product page, ordering, checkout | `product.html?id=` + canonical checkout (IntaSend) |
| Enquiry = lead | `contactRequests` (b2 df1a4cb in-app contact; rules hardened f9a5c45) + b2 `product_enquiry` conversation |
| Contractor / welder enquiries | messages `service_lead` (buyer ↔ provider, server-derived) |
| RFQ → quote → order | `rfqDispatch` (functions/b2b-rfq-on-e61c73e). **Gap:** it requires a buyer *business*; consumer RFQs need an owner decision or an extension |
| Projects | the ONE Work/Job Engine (owner 09-28; unbuilt). Construction is its first customer; never fork it |
| Equipment rental | `marketplace-extensions.js` rental callables (server price, conflict check, seller assert) + IntaSend (missing) + `rentalProducts` rules (missing) |
| Delivery / tracking | Shop Riders / Delivery Hub |
| Storefront | MiniShop (sokoni-e3 chain) |
| Applications | the ONE intake (`hub-register.js`) → `applications` → AdminOS Applications |
| Commission / plans / lead fee | sokoni-2f commercial authority |

## Built

1. **Containment, hosting** (`hosting/construction-containment-on-e81d80a` @ 3a8f366): no fabricated data, clean cards →
   `product.html?id=` with no buttons, no WhatsApp / tel, honest RFQ copy, registration through the ONE intake.
   `test-construction-containment` 21/0.
2. **Open RFQ PII rules fix** (combined candidate + `firestore.rules.hotfix-jobs`, bdbd135). Ships with the Jobs hotfix
   as ONE rules release.
3. **Lead rules** (`contactRequests`, f9a5c45):
   - the seller must own the product;
   - fixed keys;
   - status starts `pending`;
   - seller lifecycle `pending → responded / contacted → qualified → quote_requested → quote_sent → negotiating → won`
     (`lost` from any open state);
   - the buyer can cancel.

   EMULATOR PENDING.
4. **Intake** (this branch, `hosting/construction-intake-on-d824b58`): construction company, welding & fabrication,
   equipment rental, construction labour & site services, and haulage are added. Contractor, material supplier and
   architect get proper question sets: all 13 contractor kinds, each approved separately by AdminOS, plus
   NCA / EBK / BORAQS declarations that AdminOS verifies. `test-construction-intake` 13/0; the base fails 10.

## Next slices

- **sokoni-b2:** `product_enquiry` TX on `contactRequests`; df1a4cb's in-app product.js in the assembly; "Open chat".
- **sokoni-2f:** materials → marketplace 15% aliases; a `construction_service` fixed 0% row plus a configurable per-lead
  fee (OFF); rental / featured / plans / delivery margin unpriced and OFF.
- **f3:**
  - server classification of the new categories (business-category, the Car Hub pattern);
  - AdminOS Construction (applications by category, leads, RFQs, rentals);
  - equipment rental made real (rules + IntaSend purpose with 5b / 2f);
  - construction RFQs (consumer path decision);
  - retire the `construct*` client collections behind server authorities;
  - merchant-v2 contractor / supplier routes (hunks to sokoni-e3).
- **Certification:** the full E2E plus the security break list from the owner brief.
