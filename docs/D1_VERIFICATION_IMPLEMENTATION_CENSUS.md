# D1 — verification implementation census

**READ-ONLY. No code changed, nothing deployed.** Sizes the smallest vendor-neutral patch for the
D1 foundation, with the biometric engine kept behind the adapter boundary.

Vendor selection (D-02), topology (D-03) and the biometric engine remain **HOLD**.

---

## 1. What already exists and is CORRECT — do not rebuild

| | evidence |
|---|---|
| Both verification collections are **server-write-only** | Deployed rules: `providerVerification` and `driverVerification` each carry `allow read: if isAdmin() \|\| (isAuthed() && request.auth.uid == uid)` and **no write clause at all**. A client cannot write verification state today. |
| `documentsComplete` is **derived**, not submitted | `application-lifecycle.js::projectDriver` computes `missing[]` and sets `documentsComplete = missing.length === 0`. |
| Self-approval is **blocked** | `admin-os.js`: `if (uid === actor) throw` — *"An administrator is still an applicant when the subject is themselves."* |
| A decision cannot be **manufactured** | The review op refuses when no submission exists — a decision ON evidence, never a way to create one. |
| Decision history exists | `providerVerification.priorDecisions[]` (`slice(-9).concat`) — the append-only pattern the two-reviewer record should extend, not replace. |
| Rejections require a reason | Enforced server-side. |
| Review is idempotent | Re-issuing the same decision writes no second audit entry — which matters once "two reviews" is the rule. |

**`official` does not exist as a field anywhere** — three matches repo-wide, all in search indexers
and unrelated. So the contract introduces it cleanly; there is nothing to migrate or reconcile.

---

## 2. The three write sites — the whole surface

    provider-onboarding.js:998   providerSubmitVerification   applicant submits (URLs + status)
    admin-os.js:1754             provider verification review reviewer decision
    application-lifecycle.js:624 projectDriver                driver projection (derived)

That is the entire authority surface. A vendor-neutral patch has three call sites to touch, not a
scattered rewrite.

---

## 3. The two schemas, and what convergence costs

    providerVerification   status: pending_review | verified_on_file | rejected
                           priorDecisions[], reviewedBy, reviewedAt, reviewNotes
                           nationalIdUrl, businessRegUrl, licenceUrl, kraPinUrl, selfieUrl

    driverVerification     status: verified_on_file | incomplete
                           documentsComplete, documentsMissing[]
                           nationalId, dlNumber, dlExpiry, plate, sourceApplicationId
                           — identifiers, NO reviewer, NO history, NO URLs

They already share the `verified_on_file` token. **provider has the governed review workflow;
driver has the structured identifiers.** The converged contract is close to the union: driver's
extracted-identifier discipline plus provider's review/history discipline. Neither is a third
system — which is the stated requirement.

Production rows: `providerVerification` **0**, `driverVerification` **1**. Migration cost is one
record.

---

## 4. The gaps — the actual patch

| # | gap | smallest vendor-neutral fix |
|---|---|---|
| G-a | **No `verification-adapter.js`** | Create the boundary with the agreed result shape (`livenessResult`, `faceMatchScore`, `vendorModelVersion`, `processingRegion`, `vendorReceivedAt`, `deletionHandle`, `automatedOutcome`, `failureClass`, `correlationId`). Ship it with a **null/manual adapter** — no vendor. |
| G-b | **Client-supplied document URLs** | `provider-onboarding.js` `_san()`s a URL string it never validated. Server must derive/validate the path from the authenticated uid, so disposal is possible by construction. |
| G-c | **No disposal** | Server-controlled, auditable, with the surviving evidence designed **before** the sweep. |
| G-d | **Single-reviewer schema** | `reviewer1/reviewedAt1`, `reviewer2/reviewedAt2`, `humanDecision/decisionAt`, `verificationRoute` — extending `priorDecisions[]`, not replacing it. |
| G-e | **Any admin is a reviewer** | `admin-os-dispatch.js` applies *"the same admin/superAdmin check"* to every op. The designated *application verification reviewer* capability does not exist and cannot be configured into being. |
| G-f | **reviewer1 ≠ reviewer2** | A distinct server check; the existing `uid === actor` guard does not cover it. |
| G-g | **Two schemas** | Converge onto the provider shape per §3. |

---

## 5. Sequencing, and what must NOT be presupposed

Buildable now, vendor-neutral: **G-a (null adapter), G-b, G-d, G-e, G-f, G-g**.

**G-c (disposal) is buildable but must not run before the surviving-evidence contract is settled** —
deletion is irreversible, and building the sweep first destroys the record of how a decision was
reached.

Nothing in the patch may hard-code a vendor, a processing region, a retention constant, or a
confidence threshold. P-1's ~30 days is **configuration**, not a literal. The adapter ships with no
provider selected, so the engine boundary exists while the engine stays HOLD.

**Do not claim biometric verification is operational.** With a null adapter, `faceMatchScore` and
`livenessResult` are absent — and absence must route to the assisted path (D-15), never to a pass.

---

## 6. Out of scope
Vendor selection · processing topology · production deployment · the multishop branch ·
`release-firestore-rules.js` · the lineage guard · DL-01 function release · D1-C vehicle
provisioning.
