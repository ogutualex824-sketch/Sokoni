# Category + capability routing convergence — read-only ownership and provenance census

**Date:** 2026-09-29 · **Line:** `slice/c4-capability-consumer` (c4 implementation lineage) · **Nothing changed by this census.**
Precedes any edit to `functions/business-category.js` (C1) or `functions/business-workspace.js`. Follows [[C4_DG_WINE_MIGRATION]], [[C5_LATOMI_MIGRATION]], [[CAPABILITY_AUTHORITY_READ_MODEL]].

## 1 · Provenance and ownership

| Module | Introduced | Lineage | Later edits | Owner today |
|---|---|---|---|---|
| `functions/business-category.js` (C1) | `13597e4` 2026-09-28 "one server business category authority; commercial lane frozen at approval" | `feat/creator-hub`, shared by every `slice/c4-*` branch | `1b07fec` provider directory · `5908dd0` every registrable category classified · `dca1049` seller shops get a C1 category at approval · `62e38b3` AdminOS classifies seller shops | no live session claims it (peers sokoni-66 / d6 / eb all answered "not mine"); the platform owner's earlier agent lineage. Treat as **shared authority: extend, never fork**. |
| `functions/business-workspace.js` | `ad7265b` C2a one workspace authority · `36e82b9` C2b server refuses · `300ddaa` C2c one route | same | `5908dd0`, `48d932d`, `62e38b3`, then **`a7d142f` (this track: capability consumer)** | as above; the capability consumer edit is this track's. |
| `functions/business-category-admin.js` | with C1 | same | AdminOS reclassification (`source: admin`, `classifiedBy`, `setAt`); refuses Healthcare boundary | shared |

All commits are authored by the platform owner's account; the lineage is the owner's convergence line, not a foreign one.

## 2 · Who writes the category stamp, and what protects it

- **`providers/{uid}.business = { category, source, lane, classifiedBy? }`** is written by `application-lifecycle.js:534` (`projectProvider`, at approval) and `:911` (`projectSeller` → `shops.business`), and changed only by `business-category-admin.js` (AdminOS, `source: admin`). `categoryOf(providerDoc)` reads `business.category`, then the healthcare authority.
- **Rules (this line):** `providers` updates may not touch `business` unless admin (`firestore.rules:595-611`). Good.
- **`businesses/{id}`** — `allow create: if isAuthed() && request.resource.data.uid == request.auth.uid && noAdminFields()`; `noAdminFields()` lists isAdmin, suspended, banned, adminApproved, featured, verified, flagged, adminNote, role, approved, approvedAt, approvedBy, commissionRate. **Neither `capabilities` nor `business` is in it.** A signed-in user can therefore create `businesses/{their uid}` carrying a well-formed `capabilities` stamp (decidedBy/decidedAt/source are just strings to the rules), and the capability consumer would read it as **STAMPED**. This is a **self-stamp vector** and must be closed — `capabilities` (and `business`) added to the protected keys for `businesses` — in the same slice that makes any surface trust the stamp. Today nothing deployed reads the stamp, so it is latent, not live.

## 3 · Production state of the two authorities (read-only, 17:35Z)

| Fact | Value |
|---|---|
| providers | 11 · **with a C1 `business` stamp: 0** · with a healthcare stamp: 0 |
| businesses | 12 · with a capability stamp: **2** (DG Wine, Latomi — C4/C5) · with a C1 stamp: 0 |
| providers live by approval evidence | 7 (k Riss, Julian's Closet, Langa'ta mamafua, Latomi, DG Wine, Kasindi, Hometown Movers) |
| providers live by status only | 3 (Shave 'n' Trims — synthetic, DJ Bvmbxno, King Bruce) · pending 1 (Heights Creations) |

**C1 has never run in production** (it is not deployed). Under the c4 workspace authority as it stands, every approved provider is `LEGACY_UNCLASSIFIED` (grandfathered to the full provider dashboard by the 2026-09-28 owner decision) and every unclassified one is PENDING.

## 4 · What C1 would say about the two migrated businesses — a disagreement the resolver must surface

`categoryFromApplication(application, 'provider')` for both DG Wine and Latomi (application `category: wholesaler`) → **`wholesale`, exact match** — a **SELLER category** (`SELLER_CATEGORIES` = retail_store, supermarket, wholesale, hardware, electronics, fashion, agriculture) whose `ROUTE_OF` is **`merchant-v2.html`**. Their stamped capability is **SERVICES** (inherited from the provider approval, which the role resolver produced by keyword/default — the `wholesal` regex and the b2b default recorded in C3).

So for these two identities, **category and capability disagree**: the category authority says "product business, Merchant V2"; the capability authority says "SERVICES, provider workspace". Under the locked model that is **CONFLICT → no inferred dashboard**, not a fallback to either. Resolving it is an **admin decision**, not a resolver rule: either approve PRODUCTS (they sell wine and gadgets; there is nothing today to stamp it from — no seller application, no products) or reclassify the category to a service category (which the facts do not support). The census reports; it does not decide.

The same test on the five other approved providers (tailor, cleaning, moving, entertainment performer, "Service Provider") would need the C1 stamp to exist first; on this line it does not.

## 5 · The resolver contract proposed for the next slice (not built)

`route = f(category, capabilities)`, both from server facts, both required:

| category lane | capability | route |
|---|---|---|
| seller category (`SELLER_CATEGORIES`) | PRODUCTS | Merchant V2 |
| service category (everything else incl. healthcare) | SERVICES | provider workspace (the existing provider-dashboard, healthcare rows unchanged) |
| any | PRODUCTS_AND_SERVICES | Merchant V2 + Services workspace |
| seller category | SERVICES only | **CONFLICT** — no dashboard (DG Wine, Latomi today) |
| service category | PRODUCTS only | **CONFLICT** — no dashboard |
| any | UNCLASSIFIED | no dashboard (Overview + Settings holding page, as today's PENDING) |
| **no category** | SERVICES | **owner decision**: today grandfathered as LEGACY_UNCLASSIFIED to the full provider dashboard (2026-09-28); the model says no category = not routable until AdminOS classifies. Keeping the grandfather clause keeps 7 real providers working; removing it parks them until classification. |
| unreadable | any | readable:false, category path answers (as the consumer does now) |

No fallback is added to make a test green; the fixtures already carry `approvedAt`, and a CONFLICT row stays red until an admin decision changes the record.

## 6 · Proposed order

1. **Rules**: add `capabilities` and `business` to the protected keys on `businesses` (and a rules suite proving a client cannot create or update them; admin/server can). Small, first, because everything after trusts the stamp.
2. **Resolver**: `business-workspace.js` computes `route` from the table above; `_categoryWorkspace` keeps module states; the disagreement cases return `CAPABILITY_CONFLICT` with the two authorities' answers named. Suites: extend `test-workspace-capability.js`; regression on the 18 suites already listed.
3. **Owner decisions needed before step 2 can be certified against production identities**: (a) the grandfather clause; (b) DG Wine / Latomi — PRODUCTS approval or reclassification; (c) whether C1 stamps are applied to the 7 approved providers by an admin pass (AdminOS › Business Categories) — a production write, its own slice with a manifest.
4. Then cards/UI convergence, then AdminOS/Super Admin, per the owner's order. KASS, the four status-only accounts, the 34-record deletion, branch-model design and the user-count repair stay outside.
