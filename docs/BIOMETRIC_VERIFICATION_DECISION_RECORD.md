# Biometric Verification Decision Record (BVDR)

**Status: DECISION RECORD — OPEN. Nothing implemented. No vendor selected. No deployment.**
D1-B implementation is blocked until this is approved.

Purpose: make these decisions *makeable* — state what engineering has established, and leave
every genuine policy/vendor call explicitly open rather than implying one through a default.

Related: [[project_official_application_verification]], [[DELIVERY_D1_VERIFICATION_CONTRACT]],
[[project_odpc_compliance]].

---

## 0. Established by census — not decisions, facts

| | finding |
|---|---|
| Automated facial verification today | **NONE.** `faceMatch`, `faceVerified`, `faceEmbedding`, `faceScan`, `face-api` — **0 files each**. No liveness, no matching, no embeddings, no vendor SDK. |
| A selfie IS already collected | **`provider-onboarding.js:977`** accepts `selfieUrl` alongside `nationalIdUrl`, `businessRegUrl`, `licenceUrl`, `kraPinUrl`, writes them to `providerVerification`, and **AdminOS already human-reviews them** (`admin-os.js:1764` records `documentsReviewed: [...selfieUrl]`). So capture → store → human review **already exists** for providers. What is missing is liveness, automated match, and disposal. |
| **Those images have NO disposal mechanism** | Zero matches for disposal / retention / purge across `provider-onboarding.js` and `admin-os.js`. The path stores national ID images and selfies **indefinitely**. It holds 0 production rows today, so no images are actually retained yet — but the code is written and the gap is shipped, not hypothetical. |
| WebAuthn in `manager-auth.html` | Device-local Face ID/fingerprint for POS manager authorization. The biometric **never reaches the server**; only a credential id is stored. **NOT evidence of facial-verification capability** and must not be cited as precedent. |
| Canonical verification authority | **`providerVerification` already is one** — `status` (`pending_review`/`verified_on_file`), `priorDecisions[]`, `reviewedBy`, `reviewedAt`, `reviewNotes`; AdminOS reads it at `admin-os.js` 475/579/1733. **0 production rows.** |
| `driverVerification` | The weaker sibling: `documentsComplete`, `documentsMissing[]`, no reviewer, no history. **1 production row.** Shares the `verified_on_file` token. |
| `applicationVerification` / `legalVerification` / `merchantVerification` / `identityVerification` | **Zero writers.** Do not create a third schema — generalise `providerVerification`. |
| Data-minimisation precedent | `legal-agreements.js:355` stores a **SHA-256 hash** of a drawn signature, never the raw image, because it is *"biometric-adjacent personal data"*. Useful shape; **not a substitute** for whatever artifact a face vendor requires. |
| Legal classification | Biometric data is **sensitive personal data** under the Kenya Data Protection Act 2019. |
| Live population affected | 10 applications: 5 `business`, 3 `driver`, 1 `voiceover`, 1 service category. |

---

## 1. THE GATING DECISION — scope

**D-01 · Which application roles require facial verification?**

    A  UNIVERSAL      every official application -> liveness + identity match
    B  ROLE-BASED     healthcare / legal / delivery -> mandatory
                      merchant -> a defined identity/KYC policy, not necessarily biometric

**STATUS: 🟢 RULED 2026-09-13 — A, UNIVERSAL.** Every application that creates an official
identity passes liveness + identity match. Merchants included.

### What that settles, and what it now obliges

One rule, one path to certify, no per-role exemption matrix to maintain or argue about — and
"official is earned" means the same thing everywhere, which is the property that makes the claim
defensible.

The obligations that follow are not objections; they are scope that must now be planned for:

- **The DPIA covers ordinary shop onboarding.** All **5 live `business` applications** are in
  scope, as are all future merchant signups. This is the widest of the four options and the
  assessment must be written against it, not against the provider roles alone.
- **The vendor contract is priced per application, not per provider.** Merchant onboarding is the
  highest-volume application type on the platform, so volume assumptions in D-02/D-04a should be
  taken from merchant signups rather than from the 3 driver applications.
- **D-15 (fallback) is now load-bearing, not a courtesy.** Under a universal rule, an applicant who
  cannot complete facial verification — no suitable device, poor connectivity, a disability
  affecting capture — cannot open a shop at all. A universal requirement without a working
  fallback is an exclusion policy. This decision raises D-15 from "should have" to "must ship
  with".
- **Merchant onboarding gains a biometric step**, which is a real change to that funnel. Flagged
  as a product consequence, not an engineering objection.
- **`provider-onboarding.js` becomes the template for every application type**, which makes its
  missing disposal path (§0) a blocker for all of them rather than a provider-only remediation.

---

## 2. Vendor and technology

| # | Decision | Status | What engineering can say |
|---|---|---|---|
| D-02 | Approved vendor / technology | 🔴 OPEN | **Homemade facial recognition is PROHIBITED** (owner ruling). Nothing exists to build on, so this is procurement, not integration. |
| D-03 | Liveness method | 🔴 OPEN | Vendor-dependent (passive vs active/challenge). Affects applicant experience and spoof resistance. |
| D-04 | Face ↔ document match method | 🔴 OPEN | Vendor-dependent. Must produce a **confidence score**, not a boolean, so D-11's low-confidence path exists. |
| D-04a | Vendor's own data retention | 🔴 OPEN | A vendor that retains images or templates on its own infrastructure makes SOKONI's retention policy necessary but not sufficient. Must be contractual. |

---

## 3. Biometric data handling

| # | Decision | Status | Engineering constraint |
|---|---|---|---|
| D-05 | Where processing occurs | 🔴 OPEN | On-device / SOKONI backend / vendor cloud are three different DPIA answers. |
| D-06 | What biometric artifacts are created | 🔴 OPEN | Must be enumerated exactly — image, video, template, embedding, score. "A face check happens" is not an answer a regulator accepts. |
| D-07 | Is any template/embedding retained? | 🔴 OPEN | Owner has already said: do **not** silently retain embeddings. If the answer is "none retained", that must be provable, not asserted. |
| D-08 | Encryption and access authority | 🔴 OPEN | Who can read verification material, under what claim, and is every read audited. |
| D-09 | Maximum retention | 🟡 **P-1 decided: ~30 days after the verification decision**, then disposal. Extends to face material unless D-05/D-07 change the shape. | The operational **profile photograph is separate** and keeps its own lifetime — it is operational identification, not verification material. |
| D-12 | Secure disposal mechanism | 🔴 OPEN | Must be a server job **with its own audit record**: an image deleted with no evidence of deletion is indistinguishable from one that was missed. |

---

## 4. Decision authority and states

| # | Decision | Status | Notes |
|---|---|---|---|
| D-10 | Human reviewer authority | 🟡 PARTIAL | AdminOS review pattern exists (`providerVerification.reviewedBy/reviewedAt/priorDecisions[]`). The **contract** — which claim may approve, whether approver ≠ applicant is enforced, whether two-person review is required for biometric evidence — is undefined. |
| D-10a | Approval / rejection states | 🟡 PARTIAL | `pending_review` / `verified_on_file` exist. The face states must stay **distinct and non-collapsing**: `faceCapture`, `faceLiveness`, `faceMatch`, `humanFaceReview`. A camera capture is not verification. |
| D-11 | Failed / low-confidence / manual-review path | 🔴 OPEN | Needed because face matching is probabilistic. Without it the system fails closed on real applicants and support has no route. |
| D-13 | Audit evidence | 🔴 OPEN | What is retained to prove a verification happened **after** the material is disposed of — the decision, scores, reviewer, timestamps, provenance. This is what survives the 30 days. |
| D-14 | Consent / DPIA | 🔴 OPEN | Sensitive personal data under the Kenya DPA 2019. Explicit consent and an impact assessment are obligations, not checklist items. Scope depends entirely on **D-01**. |
| D-15 | Fallback when an applicant cannot complete facial verification | 🔴 OPEN | Accessibility, device capability, connectivity, and disability are all real. A verification system with no fallback excludes people rather than verifying them. |

---

## 5. Invariants that hold regardless of the decisions above

These are already ruled and do not reopen:

    official = applicationApproved
            && identityVerificationPassed
            && faceVerificationPassed        (where D-01 requires it)
            && humanReviewCompleted

- `application.status === 'approved'` is **never sufficient by itself**.
- Every component is **server-authoritative**. A client must never be able to submit
  `faceVerified: true`, `documentsVerified: true` or `official: true`.
- `documentsComplete` and any `official` flag are **derived**, never client-supplied — a derived
  flag that can also be written directly is two authorities disagreeing.
- One shared engine; **required documents stay role-specific**.
- No renaming or migration of `providerVerification` / `driverVerification` until the migration
  shape is designed. 1 live row and 0 live rows respectively — cheap, but not yet decided.

---

## 5b. Three constraints added by the owner, 2026-09-13

**The existing indefinite storage is a REMEDIATION TARGET, not documented debt.**
`provider-onboarding.js` stores `nationalIdUrl` / `selfieUrl` / `licenceUrl` / `kraPinUrl` with no
disposal path. It holds 0 rows today, which is the only reason this is cheap — it must be fixed as
work, not carried as a known issue. Extend that workflow; do not build a second capture/review
system beside it.

**The surviving audit record must be designed BEFORE disposal is implemented.**
Disposal is irreversible. Building deletion first and deciding later what evidence should have
survived destroys the ability to show how a decision was reached — for exactly the records where
that question is most likely to be asked. Design order: evidence contract, then the sweep.

**Never collapse these three into one `verified: true`:**

    verificationStatus   the workflow state
    faceMatchScore       automated evidence, probabilistic
    humanDecision        the authority

A high confidence score is evidence, never approval. Collapsing them destroys the distinction
between what a machine measured and what a person authorised — which is the distinction an audit,
a dispute, and a regulator each ask about first. It is the same authority separation DL-01 applied
to presence-vs-eligibility and V-1 applied to vehicle ownership.

## 6. Migration shape — deferred, deliberately

Generalising `providerVerification` means one live `driverVerification` row must eventually
resolve into it. That is 1 record, so cost is not the constraint — correctness is. The shape is
**not designed in this record** and must not be improvised during implementation.
