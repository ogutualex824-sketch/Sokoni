# Manifest — k Riss → `artist_creator` through the AdminOS classification authority (REVIEW; not applied)

**Date:** 2026-09-29 · **Production project** `sokoni-aeb26` · **Plan digest `b7a2053b2f82921bbd909ec84ebe8c9c1e071ec6aaeddb5ee5b0744649d170a0`** · nothing written.
Wrapper `scripts/classify-identity.js` (plan / apply; suite `scripts/test-classify-identity.js`). Authority: `functions/business-category-admin.js` `bizAdminClassify` (AdminOS › Business categories). Follows [[ADJUDICATION_SIX_UNRESOLVED]] identity 1.

## Identity

| | |
|---|---|
| uid / business identity | `3SkVHLqJXzfeQlQ4PfBx5DFR4at2` — "k Riss"; `providers/{uid}` (providerId `PRV…`), no `businesses` / `sellers` / `shops` record; Auth claim `provider`; `users.roles` buyer + provider |
| approval evidence | application **`ENTMS9AACTG`** (entertainment hub), status `approved`, **decided 2026-08-26T05:02:08Z by `D5Ql2EYr95bt79IpcGTmOMTK0P83`** (an admin account); provider `status: active`, **`approvedAt` 2026-08-26T05:02:14Z**, `sourceApplicationId` = ENTMS9AACTG. Live by approval evidence (business-scope). Not the Kasindi case: the decider here is a person's admin account, not "reindex". |
| current C1 / lane / capability | C1 category **null** (no `business` stamp; `categoryFromApplication` → no exact match for "Entertainment Performer" / "voiceover"); lane none; capability **SERVICES / NOT_YET_STAMPED**, no conflicts; resolver today **PENDING_CLASSIFICATION, no route** |
| activity | 0 bookings, 0 services, 0 enquiries, 0 reviews, 0 orders, 0 products |

## Classification

| | |
|---|---|
| proposed C1 category | **`artist_creator`** — "Artist / Creator", group Entertainment, no owning authority, not healthcare |
| classifier evidence | C1's own tables: `FROM_BUSINESS_ID` maps **dj, mc, band, comedian, photographer, videographer, content-creator → artist_creator**; `FROM_PROFESSION` maps photographer, videographer, content creator, dj, mc → artist_creator. The approved application: hub **entertainment**, type **voiceover**, category label "Entertainment Performer"; the provider's own description: "K Riss is a rapper from a group known as 303 choppers". The lane classifier already places the application in the **entertainment** hub (`entClass: SERVICE`). "voiceover" and "rapper" are not ids in C1's tables — that is exactly why C1 could not stamp at approval and why an admin must — and they sit inside the Artist / Creator category by its own members (dj, mc, band, comedian). The only other Entertainment-group category, `event_services` (event planners), does not fit a performer. |
| resulting lane | services (`artist_creator` is not a seller category); the commercial lane stamped at approval is **not changed** by this authority (`laneUnchanged: null` — none was stamped) |
| resulting capability | unchanged: SERVICES (the read model reads registries and stamps; classification does not touch capability) |
| post-R2 route | category artist_creator (services lane) + SERVICES → **`provider-dashboard.html`, AVAILABLE**, entertainment profile (booking PIN available, content NOT_APPLICABLE — not a creator) |

## Mutation (exactly what the authority's transaction writes)

- **update (set-merge) `providers/3SkVHLqJXzfeQlQ4PfBx5DFR4at2`:** `business = { category: 'artist_creator', source: 'admin', classifiedBy: 'admin-sdk:classify-identity', setAt: <serverTimestamp> }`, `updatedAt: <serverTimestamp>`. Update-only; no create.
- **create `adminAudit/{auto}`:** `{ action: 'business_classify', targetUid, performedBy: 'admin-sdk:classify-identity', previous: null, next: 'artist_creator', laneUnchanged: null, reason: <the owner-authorization text above>, createdAt }`.
- **untouched:** every other field of the provider record (status, approvedAt, name, description, categories text, searchable, isPublic, acceptsBookings, rating, providerId…); `applications/ENTMS9AACTG`; `users/{uid}`; `wallets/{uid}`; `sellers`, `businesses`, `shops` (absent, stay absent); products, providerBookings, orders; Auth claims.
- **idempotency:** a second apply finds `business.category === artist_creator && source === admin` → `already_classified`, nothing written, no second audit.
- **refusal conditions:** provider absent · not live by approval evidence · application not approved / other uid / no decider · `sourceApplicationId` ≠ ENTMS9AACTG · already stamped with a different category · category not C1 / owned by another authority / healthcare · reason shorter than 3 chars · **any drift**: the plan digest covers the full provider, application, seller and business snapshots, and apply re-snapshots and refuses on mismatch. The handler itself additionally refuses: no provider (`not-found`), status not active/approved/suspended (`NOT_APPROVED`), the healthcare boundary, an authority-owned category, a missing reason.

## Audit

| | |
|---|---|
| authority used | `business-category-admin._adminH.bizAdminClassify` — the same handler AdminOS dispatches (`admin-os-dispatch.js`), invoked directly through the Admin SDK because this lineage is not deployed |
| decision record | the `adminAudit` document above (immutable trail; `adminAudit` is append-only per `security/adminlog-append-only`) |
| actor | `admin-sdk:classify-identity` — recorded truthfully as this owner-authorized session, **not** a person's uid; the reason text names the owner's 2026-09-29 authorization |
| timestamp | `setAt` / `createdAt` server timestamps at apply |
| before / after | `previous: null → next: artist_creator` in the audit; `business` absent → present on the provider |
| source approval evidence | application ENTMS9AACTG, decided by `D5Ql2EYr…` 2026-08-26 (cited in the reason) |

## Safety (proven on the fake store, `test-classify-identity.js`)

- **the business owner cannot invoke it:** the handler refuses a request without an admin claim (`permission-denied`) and an unauthenticated one; nothing is written by the refused attempts. In the rules (this line, R1 and the existing providers rule) a client — even an admin's raw client write — cannot touch `providers.business`.
- **it cannot manufacture approval evidence:** the handler refuses a provider that is not approved (`NOT_APPROVED`); the plan refuses one that is live by status alone; after apply, `status`, `approvedAt`, `adminApproved`, `approved` are byte-identical (never written).
- **it cannot alter products, wallet, bookings, orders or unrelated data:** the transaction touches `providers/{uid}` (`business`, `updatedAt`) and one `adminAudit` document only; application, users, wallet and a seeded booking are byte-identical after.
- **post-write census (the landing proof to run after apply):** provider stamp present and exactly as above; every other provider field byte-identical to the pre-apply snapshot; application byte-identical; users / wallet / claims unchanged; sellers / businesses / shops still absent; products 0; exactly one new `adminAudit` (`business_classify`); whole `providers` collection: only this row changed; collection counts unchanged except adminAudit +1; full identity census: no capability row changed, cleanup digest unchanged; **resolver on production docs → provider-dashboard.html, AVAILABLE**; second apply → `already_classified`.

## Authorization checkpoint

Nothing is written until the owner names digest `b7a2053b…70a0`. Apply command (to be run only then):

```
node scripts/classify-identity.js --uid 3SkVHLqJXzfeQlQ4PfBx5DFR4at2 --application ENTMS9AACTG --category artist_creator --reason "<the reason text above>" --apply b7a2053b2f82921bbd909ec84ebe8c9c1e071ec6aaeddb5ee5b0744649d170a0
```
