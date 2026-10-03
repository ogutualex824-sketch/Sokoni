# Rules patch — provider trust fields (Tech Hub 4P)

**Status: PROPOSED, not applied.** For the rules release owner (sokoni-f3's rules line). It needs emulator proof, which can't run below the 512 MB memory floor.

Related: [[Tech Hub Convergence]], [[Provider Badge]], the 4P census in the CHANGELOG.

The server now projects the public badge (`functions/shared/provider-badge.js`, `verification-engine.js`). The rules below close the owner-side paths that bypass it. Line references are from `firestore.rules` on hosting/techhub-on-chain (identical in the functions tree for these blocks).

## 1. `verifications/{sellerUid}` create — the owner could forge approved facets

Current (≈ :2075):

```
allow create: if isAuthed()
              && request.auth.uid == sellerUid
              && request.resource.data.status == 'pending'
              && !request.resource.data.keys().hasAny(['verifiedAt','approvedBy']);
```

Proposed:

```
allow create: if isAuthed()
              && request.auth.uid == sellerUid
              && request.resource.data.status == 'pending'
              && !request.resource.data.keys().hasAny(['verifiedAt','approvedBy',
                   'facets','emailVerified','phoneVerified','verifiedTypes','isVerified']);
```

Why: `/profile/{uid}` (profile-engine) and `sokoni-verifications.js` badges read `verifications.facets` and `emailVerified` / `phoneVerified`. A first-time create can currently carry `facets.identity.state:'approved'`. Facets are written only by `verificationDecide` / `verificationRevoke` (Admin SDK).

## 2. `providers/{providerId}` create + update — owner-writable trust signals

The update rule (≈ :375) forbids only `status, verified, suspended, approved`, and create relies on `noAdminFields()`. Add one function next to `noAdminFields()`:

```
function noProviderTrustFields() {
  return !(resource == null ? request.resource.data.keys()
                            : request.resource.data.diff(resource.data).affectedKeys())
    .hasAny(['status','verified','suspended','approved','featured','providerVerified','isVerified','badges',
             'rating','reviewCount','jobsCompleted','verifiedFacets','verifiedName','verificationReviewRequired',
             'verificationProjectedAt','searchable','business','sourceApplicationId','approvedAt','suspendedAt']);
}
```

Then:

```
allow create: if isActive() && isAuthed() && request.resource.data.uid == request.auth.uid && noAdminFields()
              && noProviderTrustFields();
allow update: if isAdmin()
              || (isAuthed() && resource.data.uid == request.auth.uid && uidUnchanged() && noProviderTrustFields());
```

The create change also removes the old `status == 'pending'` allowance. Only the server sets status, through `projectProvider`.

Why:
- `providerVerified` fed the search "verified" flag. The server now ignores it, but owners shouldn't be able to write it.
- `featured`, `rating`, `reviewCount` and `jobsCompleted` drive sort order and trust.
- `business` is the category stamp read by business-category / workspaceFor.
- `searchable` is the lifecycle's retraction flag.

**Check before applying:** `onboarding-professional.html` creates `providers/{uid}` with `status:'pending'`. Under this patch that create would be refused. Either drop `status` from that page's write, or keep the old `status == 'pending'` allowance as an extra clause.

## 3. `services/{serviceId}` — owner-writable `providerVerified`

Current create / update use `noAdminFields()` (covers `verified` and `featured`). Add `noProviderTrustFields()` to both, or extend `noAdminFields` with `providerVerified`, `isVerified`, `badges`, `rating`, `reviewCount`.

## Emulator rows to add (the rules owner's harness)

| Row | Expected result |
|---|---|
| R-1 owner creates `verifications/{self}` with `facets.identity.state:'approved'` | DENIED |
| R-2 owner creates `verifications/{self}` `{status:'pending'}` | ALLOWED (unchanged) |
| R-3 owner updates `providers/{self}` with `providerVerified:true` / `featured:true` / `rating:5` / `business:{category:'it_services'}` | DENIED (one row each) |
| R-4 owner updates `providers/{self}` with `bio` / `phone` | ALLOWED (unchanged) |
| R-5 owner updates `services/{own}` with `providerVerified:true` | DENIED |
| R-6 admin updates any of the above | ALLOWED |
