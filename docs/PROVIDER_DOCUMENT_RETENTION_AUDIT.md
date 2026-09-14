# Provider identity-document retention — remediation audit

**READ-ONLY. Nothing deleted, nothing modified, nothing deployed.** Opened as a gate parallel to
D-02 because this is shipped code and is independent of the eventual biometric vendor.

Scope, as set: *stop indefinite retention of provider verification source images while preserving
the evidence necessary for an authorized verification decision.*

---

## The headline: shipped capability, ZERO retained data

The distinction was required and it holds in the strongest possible direction.

    gs://sokoni-aeb26.firebasestorage.app/  contains exactly:
        product-images/
        profile-avatars/
        provider-service-images/

    documents/**                 -> "One or more URLs matched no objects."
    providerVerification         -> collection has NEVER been written (absent from the 213
                                    production root collections)
    driverVerification           -> 1 row, and it carries NO url fields at all
                                    (dlNumber, nationalId, plate, documentsComplete, status…)

**No identity document has ever been retained in production.** There is nothing to delete, nothing
to migrate, and no decision evidence at risk. This is the cheapest moment this defect will ever
have — the capability can be corrected before any data exists to be harmed by it.

That is *not* a reason to close it. A live path that accumulates identity documents with no
disposal mechanism is a defect whether or not anyone has used it yet.

---

## The seven questions

| # | Question | Answer |
|---|---|---|
| 1 | Which storage objects does `provider-onboarding.js` create? | **None.** The function never touches Storage — no `bucket()`, no `upload()`. It accepts `nationalIdUrl` / `selfieUrl` / `licenceUrl` / `businessRegUrl` / `kraPinUrl` as **strings** and stores them. Objects are created by **client** upload under `storage.rules` → `match /documents/{uid}/{filename}`. |
| 2 | Do production objects exist? | **No. Zero.** The `documents/` prefix does not exist in the bucket. |
| 3 | Which verification records reference them? | **None.** `providerVerification` has never been written. `driverVerification`'s single row holds identifiers, never URLs. |
| 4 | Does AdminOS need them for an existing decision? | **No** — there are no existing decisions. `admin-os.js` records `documentsReviewed: [...]` naming the *fields*, and no review has occurred. Nothing to preserve. |
| 5 | Disposal trigger and retention clock | Policy already set (**P-1: ~30 days after the verification decision**). With zero data, the mechanism can be built **before** first use rather than retrofitted. |
| 6 | Surviving audit/correlation evidence | The in-house pattern applies: `age-verification.js` — record the **decision**, plus a salted hash and last-four as correlator, never the document. Plus the D-04 artifact fields. |
| 7 | Temporary retention ceiling needed now? | **No ceiling is needed — there is nothing to cap.** The useful control is the opposite: prevent *accumulation* during D-02 negotiation. See below. |

---

## A defect this audit found: the URL is client-asserted

`provider-onboarding.js` stores a URL **string the server never validated**. The server does not
create the object, does not confirm it exists, and does not confirm it lives in a bucket SOKONI
controls.

Two consequences, both material to the retention promise:

1. **Disposal may be impossible for a record SOKONI holds.** A deletion job must resolve the
   stored URL to an object it can delete. If a client submits an arbitrary or foreign URL, the
   verification record references material SOKONI cannot delete — so "we dispose of identity
   documents after 30 days" would be unprovable for that record, which is precisely the claim
   D-04a exists to make provable.
2. **Provenance is asserted, not established** — the same defect class as DL-01, where a
   client-writable field decided a server question.

**Design requirement for D1-B:** the server must derive or validate the storage path from the
authenticated uid, rather than trust a submitted URL. A path the server constructs is a path the
server can delete.

---

## Two smaller observations

**`/documents/{uid}/{filename}` has no `allow delete`.** Neither the owner nor an admin can delete
through rules, so disposal must run server-side with the Admin SDK. That is the right shape for a
*governed* disposal job with an audit record — but it also means a provider cannot remove their own
identity document, which is a data-subject-rights question for the DPIA rather than a bug.

**The read scope is already correct:** `request.auth.uid == uid || request.auth.token.admin`, with
a 20 MB cap and image/PDF only. The write scope is owner-only. The collection side is not the
weakness here — the absent lifecycle is.

---

## Reachability — why "prevent accumulation" is NOT an emergency

    providerSubmitVerification    deployed callable
    sokoni-provider.js:76         exposes submitVerification(docs)
    provider-onboarding.html      0 calls · 0 storage upload code
    provider-dashboard.html       0 calls · 0 storage upload code

**No reachable UI path creates an identity document or submits a verification.** That is why
Storage holds zero objects and `providerVerification` zero rows — the three facts are consistent,
not coincidental. Nothing surfaces the capability, so no applicant can trip into it.

**Residual risk, stated accurately rather than dismissed:** `storage.rules` does permit an
authenticated user to write under `/documents/{own-uid}/`, and the callable can be invoked
directly. So a crafted client could still accumulate material. What cannot happen is *organic*
accumulation through the product.

**Consequence for sequencing:** step 1 does not need to jump the production hold. Preventing
accumulation, server-derived paths and the disposal job can land together as one coherent change
inside the remediation gate — which is the narrow, certifiable shape wanted, rather than an
emergency rules deploy now followed by the real fix later.

## Recommended remediation shape — not implemented, not authorized

Because there is no data, the cheap and safe order is:

1. **Prevent accumulation while D-02 is negotiated.** The provider verification submission path is
   live and unused; gating it is reversible and costs nothing today. Deleting data later costs
   more than not collecting it now.
2. **Server-derived storage paths** (above) so disposal is possible by construction.
3. **Build the disposal job with its audit record before first use** — and per the standing rule,
   design the surviving evidence *before* the deletion, since deletion is irreversible.

No production object was listed, read, modified or deleted in this audit — only the existence of
prefixes was queried.
