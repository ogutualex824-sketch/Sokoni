# C3 cleanup manifest — CORRECTION: two REAL businesses were classified as synthetic

Related: [[C3_IDENTITY_CLASSIFICATION_CENSUS]] · [[ADJUDICATION_SIX_UNRESOLVED]] · [[APPROVAL_REMEDIATION_CENSUS]] · [[Authentication]]

**Status:** correction to the read-only manifest `docs/release-gates/c3-cleanup-manifest.json`
(34 records, digest `028299e7…13e2`). The manifest is NOT edited, so its digest stays verifiable. This notice
**supersedes it for the ids below**. The deletion protocol was never started (census §B "not started, not authorized"),
and no commit records an execution. Raised 2026-10-03 while checking the owner's request that Shave 'n' Trims and
DJ Bambi have the correct dashboard.

## The error

Rule **R1** treats every Auth account on an RFC 2606 `.invalid` domain as synthetic ("can never be a real mailbox").
That inference is wrong for accounts the platform itself onboarded for **phone-OTP sign-in**. Those scripts set a
placeholder email on a `.invalid` domain *precisely because the person never signs in by email*. The account belongs to
a real person, keyed to their real phone number.

| uid | Business | Onboarding source (committed) | Real-world identity | Manifest rows that must NOT run |
|---|---|---|---|---|
| `13iuLZx63jN5evaNcUnx7bhDSfs1` | **Shave 'n' Trims** (barber shop) | `scripts/onboard-barber.js` (`98ea174`, 2026-07-25): "owner Pacifique, phone 0742544979 … signs in with +254742544979 by OTP"; email `…@sokoni-provider.invalid` is commented "placeholder; login is by phone" | owner Pacifique, +254742544979 | R1 `auth/13iu…`, R1 `users/13iu…`, R6 `providers/13iu…` |
| `zewfgP9OpcSTc34x07UCecTo0Mh2` | **Maina Groceries** (grocery seller) | `scripts/onboard-maina-groceries.js` (2026-07-26): "phone 0706603915. Signs in with +254706603915 by OTP" | +254706603915 | R1 `auth/zewf…`, R1 `users/zewf…`, R6 `sellers/zewf…` (and any R6 row it owns) |

The other two R1 accounts (`EmV3RXLm…`, `MtexojeA…`, both `@sokoni-probe.invalid`) carry **probe** naming and no
onboarding script. They are unaffected by this correction.

## Rule for any executor of this manifest

1. **Refuse these six records by id.** Executing them would delete a real business owner's sign-in, user profile and
   shop/provider record.
2. **R1 needs a second condition before it means "synthetic":** the account has NO phone number AND no onboarding script
   names it. A `.invalid` email alone is a placeholder signal, not a synthetic one. Re-run the census with that condition
   before any deletion slice is authorized.
3. These two remain **CONFLICT** cases for approval (status written directly, with no application and no admin decision).
   That is an *approval* problem for AdminOS under the canonical approval rule, not a deletion.

## What these accounts actually need (owner decisions, not done here)

- An **authoritative admin approval decision** (no application exists for either). Same class as DJ Bvmbxno and King
  Bruce in [[ADJUDICATION_SIX_UNRESOLVED]]. Either the business files an application that an admin approves, or a
  server-authorized, audited admin decision op records it. Never a raw write.
- A **server-stamped category**: Shave 'n' Trims → `salon` ("Salon / Barber / Spa", business-category.js), which is
  SERVICES and routes to the provider dashboard. Maina Groceries → its grocery category, which is PRODUCTS and routes to
  Merchant V2.
