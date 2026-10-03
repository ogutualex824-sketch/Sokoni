# Food Hub Gate 1 — Approval → Seller Setup

**Date:** 2026-10-03 · **Owner:** sokoni-5b · **Branch:** `feat/food-gate1-approval-on-f66f2c1`
**Base:** `f66f2c1`, the live `applicationLifecycle` lineage (K13-B).
**Status:** built and tested. **NOT deployed.**

Related: [[Food Hub]] · [[Capability Engine]] · [[Business Workspace]] · [[Applications]] · [[Shop Discovery]] · [[AdminOS]]

## The defect (live, from code reading of `f66f2c1`)

Lifecycle: FOOD APPLICATION → ADMINOS REVIEW → APPROVED → **nothing**.

1. **Food is filed as a service.** `hub-register.js` declares `requestedRole: 'provider'` for every food category, because its `_ROLE_BY_HUB` names only delivery, healthcare, legal and shopping. So an approved restaurant became a *service provider*. The workspace authority routes `restaurant` to merchant-v2 (the products lane), so the two disagree and the business gets **no workspace**.
2. **Approving a seller creates no seller.** `seller` sat in `DELEGATED_ROLES`, which records "delegated" and writes nothing. The only seller trigger, `ade.adeOnSellerApplied`, reacts to a `sellers` doc going `pending` and never approves anything.
3. **No category is ever stamped.** The live lifecycle has no `business-category`. Nothing writes the C1 stamp the workspace reads.

## What Gate 1 changes (`functions/application-lifecycle.js`)

| Step | Authority |
|---|---|
| Role | `resolveRole`: a `provider` whose category is a merchant-v2 category (`SELLER_CATEGORIES` + `restaurant`) becomes a **seller**. The category must come from an exact business id; free text never decides it. Recorded as `<by>+category`. No other declared role is ever re-filed. |
| Provisioning | `projectSeller` (C4 design, ported) provisions three records: `shops/{uid}` (or the declared shop, if it is unowned or already the applicant's), `sellers/{uid}` and `businesses/{uid}`. It runs **before** the role is granted. |
| Category | The C1 category is stamped by the server as `business.{category, source:'application', applicationId}` on all three records. An AdminOS classification is never overwritten, and a failed derivation never nulls a valid category. |
| Approval evidence | `sellers/{uid}.approvedAt` + `approvedBy`. Both are client-unwritable (`noAdminFields`), and they are what `business-scope` reads as a live seller. |
| Application | The application records the role its decision applied. The workspace judges the approval by `app.role`. |
| Capabilities | Nothing is written. They are derived on read from the valid approval (Slice 0, `service-capabilities`). A café resolves to `FOOD_MENU`, `KITCHEN` and `DRINKS`. |
| Route | `workspaceFor` → `merchant-v2.html`, `AVAILABLE`, category `restaurant`. |

### Deliberate rules

- **Approved ≠ discoverable** (owner, 2026-09-28).
  - A record this approval *creates* is written `_noIndex: true` + `discovery: 'HELD'`. `_noIndex` is the search sync's existing skip guard.
  - Existing records keep exactly the visibility they had.
  - Publication belongs to the one shop discovery gate (`business-category.shopEligibility`), not to approval.
  - The approval message no longer says "customers can find you in search".
- **Ownership is never transferred.**
  - A shop owned by another account fails the projection: no seller, no role.
  - An applicant-written `shopId` that is not a document id is refused, never sanitised into a different id.
- **One POS business.**
  - `businesses/{uid}` carries the stamp but **not** `ownerId`.
  - `_ensureBusinessForOwner` still finds and creates the single `ownerId == uid` POS business (SOK-*). That path is unchanged.
- **Suspension** sets shop, seller and business to `suspended` and makes them non-searchable and non-public. The records are kept, and the visibility it removed is saved in `preSuspension`.
- **Reinstatement** restores exactly that visibility and nothing more.
- **Idempotent:**
  - ids are deterministic and every write is a merge;
  - `createdAt` is written only on first write;
  - `activeShopId` is set only when the account has none;
  - an existing seller's name is never overwritten.

### Why the stamp lives on `businesses/{uid}` and `shops`, not `sellers`

The served ruleset was fetched 2026-10-03 with `scripts/fetch-deployed-rules.js`. Its business-record rules are:

| Collection | `business` writable by a client? |
|---|---|
| `businesses` | No: `create: if false`, and the owner's update allow-list excludes it |
| `shops` | No: admin-only create, and the owner's update allow-list excludes it |
| `sellers` | **Yes**: owner create/update with `noAdminFields` only |
| `providers` | **Yes**: the owner's update blocks only `status / verified / suspended / approved` |

`workspaceFor.categoryFor` reads `businesses/{uid}.business`, which is server-only. The copy on `sellers` is informational; it is never read as authority.

> **FINDING (not fixed here, rules lane):** `providers/{uid}.business` is owner-writable on the served rules. An approved provider can re-stamp their own C1 category, and live `providerDispatch` (`c7e26b6`) reads it through `business-category.categoryOf`. The approval gate still applies, but the category and therefore the route are self-selectable after approval. Fix: add `business` (and `capabilities`) to the providers owner-update deny list in the next rules release (the combined rules candidate).

## Files

- `functions/application-lifecycle.js`: `resolveRole` category fallback, `projectSeller`, `seller` removed from `DELEGATED_ROLES`, the decision stamps `role`, and the approval message.
- `functions/business-category.js` and `functions/healthcare-category.js`: **byte-identical** to the live `providerDispatch` lineage (`95ff9e8` = `c7e26b6`; sha256 `706e0745…` / `60225c70…`).
- `scripts/test-food-gate1-approval.js`: new.
- `scripts/sabotage-food-gate1.js`: new.
- `scripts/test-legal-projection.js`: its assertion "seller is still delegated" is now "seller is provisioned by projectSeller".

**Database:**
- No migration.
- New fields: `discovery`, `preSuspension` and `suspendedBy` on `shops`, `sellers` and `businesses`.
- `_noIndex` (an existing convention) on records this approval creates.

**API:** none.

## Evidence

| Test | Result |
|---|---|
| `scripts/test-food-gate1-approval.js` (REAL `applyDecision` on an in-memory Firestore, then the REAL `workspaceFor` from the Slice 0 line `13f74f3`) | **28/0** |
| same, `BASE=f66f2c1` (live lifecycle) | **21 FAIL**; the 7 that pass are controls or vacuous on base |
| `scripts/sabotage-food-gate1.js` | **15/15 caught** |
| `test-legal-projection` / `test-approval-provisioning` / `test-role-provisioning` / `test-role-vocabulary` / `test-k13b-lifecycle-authority` / `test-convergence-server` | 96/0 · 28/0 · 57/0 · 66/0 · 8/0 · 14/0 |
| `test-approval-provisioning-emulator` | **UNPROVEN**: needs the Firestore emulator (memory below the 512 MB floor) |

## Release dependencies — Gate 1 is NOT proven live until all hold

1. **`providerDispatch` must carry Slice 0** (`13f74f3`, `laneOf` fix). Live `c7e26b6` still classifies `restaurant` as the services lane, so a correctly provisioned restaurant would meet `CATEGORY_CAPABILITY_DISAGREEMENT`. The E2E rows W-1/W-2 run against `13f74f3`. This change ships in the one `providerDispatch` reconciliation release, together with the booking-PIN port, the discovery fix and sokoni-b2's `81cde54` taxonomy.
2. **`applicationLifecycle` deploy:**
   - scoped `--only functions:applicationLifecycle`;
   - from this lineage only, never from a hosting tree;
   - 512 MB floor;
   - live-archive lineage diff first.
3. **Pending food applications** filed `provider` before this release are decided as sellers. If one was **already approved** as a provider, it needs an AdminOS re-decision; nothing is migrated automatically.

## Not in this gate

- Gate 2: merchant-v2 food tools (menu, kitchen, drinks).
- Gate 3: orders and payments.
- Gate 4: `shopOffers`.
- Gate 5: storefront, receipts, levy, delivery, plans. Plans come from sokoni-2f's hub entitlements, `convergence/commercial-fn-on-ef1e992 @ cf535ec`: `requireFeature({hubType:'food', capability})`.
- Gate 6: AdminOS / Super Admin.
- The public Food Hub stays **"ORDERING OPENS SOON"**.
