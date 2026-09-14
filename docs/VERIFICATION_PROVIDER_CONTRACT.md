# Verification Provider Contract — D-02, D-03, D-04, D-15

**Status: SPECIFICATION. No vendor selected. No implementation. No deployment.**
Purpose: make D-02 an evaluation against stated requirements rather than a choice between sales
decks, and design D-15 **before** procurement, as ruled.

Depends on: **D-01 = UNIVERSAL** — every application creating an official identity, merchants
included. Related: [[BIOMETRIC_VERIFICATION_DECISION_RECORD]],
[[project_official_application_verification]].

---

## 0. SOKONI already has the privacy pattern this needs — twice

Do not invent a retention model. Two in-house precedents already answer "how do we verify without
holding the evidence", and both were written for ODPC:

**`age-verification.js`** — the closest analogue, and the model for D-13:

> *"We record the DECISION, not the raw identity data. Date of birth is never stored: it is used
> to compute an age, the age produces a boolean, and the boolean is stored. The national ID is
> reduced to a salted hash plus its last four characters — enough to answer 'is this the same
> person' and to support an investigation, without holding a national ID number in Firestore.
> A breach of this collection should not expose a customer's identity document."*

**`legal-agreements.js:355`** — stores a SHA-256 hash of a drawn signature, never the image,
because it is *"biometric-adjacent personal data"*.

The biometric workflow inherits this shape: **verify against the material, retain the decision
plus a correlation token, dispose of the material.**

---

## 1. D-02 — vendor evaluation contract

SOKONI integrates external providers through an adapter (`payment-adapters.js`,
`etims-kra-adapter.js`, `wallet-money-adapter.js`). The verification vendor follows the same
house pattern: **`verification-adapter.js`**, one port, vendor behind it.

That is a requirement, not a style preference. It means the vendor is replaceable, the contract
below is testable with a fake, and no vendor SDK type leaks into
`providerVerification`.

### Mandatory — a vendor failing any of these is disqualified

| # | Requirement | Why |
|---|---|---|
| V-a | Returns a **confidence score**, not a boolean, for face↔document match | D-11's low-confidence path has nothing to branch on otherwise, and a boolean hides the vendor's own threshold choice |
| V-b | Liveness result is **separate** from match result | `faceLiveness` and `faceMatch` are distinct states and must not be collapsed |
| V-c | Contractual commitment on **their own retention** (D-04a) | A vendor that keeps images or templates makes SOKONI's policy necessary but not sufficient |
| V-d | Can operate **without persisting a face template/embedding**, or discloses exactly what is persisted and for how long | Owner ruling: no silent embedding retention |
| V-e | Processing location is **disclosed and contractually fixed** | D-03; a vendor that may relocate processing invalidates the DPIA |
| V-f | Provides an **auditable decision reference** that survives image deletion | D-13 — the evidence must outlive the material |
| V-g | Documented accuracy/bias characteristics across skin tone, age and gender | Universal scope means every merchant. A vendor that cannot evidence this is an exclusion risk, not merely a quality risk |
| V-h | Supports a **manual/assisted path** or degrades cleanly | D-15 is a launch blocker |

### Disqualifying
Homemade or self-hosted facial recognition (owner ruling). Any vendor requiring indefinite image
retention. Any vendor that will not contract on V-c/V-e.

---

## 2. D-03 — processing location

Not a recommendation; the three options with what each commits to.

| option | DPIA consequence |
|---|---|
| **On-device** (capture + liveness locally, only a result transmitted) | Smallest biometric surface. Constrains vendor choice sharply and shifts trust to a client SOKONI does not control — the result must then be server-attested or it is client-asserted, which violates the server-authoritative invariant |
| **SOKONI backend** | Full control and full custody — SOKONI becomes the biometric processor, with every obligation that carries |
| **Vendor cloud** | Smallest engineering burden, largest contractual surface. Cross-border transfer rules apply if processing leaves Kenya, and that must be established BEFORE selection, not discovered after |

**Engineering constraint regardless of choice:** the verification result reaching
`providerVerification` must be **server-verified**, never client-reported. A client that can post
`faceMatchScore: 0.99` has defeated the whole contract — the same class of defect as DL-01.

### MEASURED 2026-09-13 — SOKONI's data is ALREADY outside Kenya

Queried from the live project, not assumed:

    Firestore (default)                   nam5          multi-region UNITED STATES
    Firestore sokoni-ops                  europe-west1  Belgium
    Cloud Functions (all)                 us-central1
    sokoni-aeb26.firebasestorage.app      US-EAST1      <- where document images land
    sokoni-aeb26-backups                  US-CENTRAL1

Four consequences for D-03 and the DPIA, none of them optional:

1. **A vendor in the EU does not introduce cross-border transfer — it is the existing baseline.**
   Every personal data record SOKONI holds is already processed in the US. The DPIA must assess
   SOKONI's own footprint, not only the vendor's, or it assesses the smaller half of the problem.
2. **The selfies and national ID images `provider-onboarding.js` already accepts land in
   US-EAST1** — so identity documents are already crossing a border today, with no disposal path
   (§0). That is a live gap, not a future one.
3. **Choosing EU for Persona puts TWO jurisdictions in one workflow**: biometric processing in the
   EU, while the resulting verification record and the source images sit in the US. That is more
   complex to assess than either alone, and it is a reason to decide deliberately rather than by
   default. It may still be right — it is not automatically simpler.
4. **Firestore location is immutable.** `(default)` cannot be moved from `nam5`; changing it means
   a new database and a full migration. Anyone proposing Kenyan or EU residency for SOKONI's own
   records should know that before it is promised. `sokoni-ops` already sitting in `europe-west1`
   proves EU is achievable for a *new* database, and equally that this project already runs two
   residencies at once.

**Therefore the stored artifact must record the processing region** alongside `vendorModelVersion`
— per verification, not as a global setting. A region that is configuration rather than evidence
cannot answer "where was this person's face processed?" a year later, which is precisely what a
transfer audit asks.

---

## 3. D-04 — artifacts and the score contract

What the adapter is permitted to return into SOKONI, and what SOKONI stores.

    ALLOWED INTO SOKONI            livenessResult      pass | fail | indeterminate
                                   faceMatchScore      number, 0..1, vendor-normalised
                                   vendorDecisionRef   opaque, survives disposal
                                   extractedFields     the identifiers already contracted in D1
                                   capturedAt, vendorId, vendorModelVersion

    NEVER STORED BY SOKONI         face template / embedding
                                   raw face image beyond the retention window
                                   any vendor-proprietary biometric blob

    RETAINED AFTER DISPOSAL        the decision, the scores, thresholds applied,
    (the D-13 surviving record)    reviewer identity, timestamps, vendorDecisionRef,
                                   and a salted-hash correlator per age-verification.js —
                                   NOT the images

`vendorModelVersion` is required: a score means nothing a year later without knowing which model
produced it, and a vendor silently changing models would otherwise be invisible.

**The score is evidence, never approval.** `faceMatchScore >= threshold` sets
`faceMatch: 'passed'`. It does **not** set `humanDecision`, and it does not set `official`.

---

## 4. D-15 — accessibility and fallback. LAUNCH BLOCKER.

Universal scope makes this load-bearing: without a working fallback, an applicant who cannot
complete face capture **cannot become an official merchant at all**. That is an exclusion policy
wearing a verification badge.

### Who this affects, concretely
No front camera or a device the vendor SDK does not support · low bandwidth, where video liveness
is unusable · visual impairment or a condition affecting gaze/expression challenges · facial
differences, injury, or covering worn for religious reasons · an applicant onboarding through an
agent rather than personally.

### Required design
1. **Every failure is classified, not merged.** `capture_unsupported`, `liveness_indeterminate`,
   `match_low_confidence`, `applicant_unable` are four different situations and only one of them
   is a suspected fraud signal. Collapsing them into "failed" turns accessibility into rejection.
2. **A human-assisted route exists** — supervised/in-person verification by an authorized
   reviewer, producing the SAME `providerVerification` record with the route recorded, so the
   audit trail shows how the identity was established rather than hiding that it differed.
3. **Assisted verification is not a weaker tier.** It yields the same official status. If it did
   not, the fallback would be a second-class identity and the exclusion returns by another door.
4. **The route is recorded** — `verificationRoute: 'automated' | 'assisted'`. Never inferred from
   missing scores.
5. **No time limit that expires an applicant out of the platform** for a device or disability
   reason.

### RULED 2026-09-13 — designated reviewers, TWO for an assisted approval

Assisted verification may be performed **only by designated AdminOS verification reviewers**, and
an assisted approval requires **two independent reviewers**. Separation of duties on the exception
path, without creating a second identity tier.

    verificationRoute: 'assisted'
    reviewer1, reviewedAt1
    reviewer2, reviewedAt2
    humanDecision, decisionAt

The absence of a face score is **never** treated as failure on this route.

**Authority boundary:** ordinary AdminOS access must NOT imply verification authority. A distinct
governed capability — *application verification reviewer* — has to be held explicitly.

    AdminOS admin   ≠   verification reviewer

And the applicant can never be either reviewer.

### What already exists, and what is genuinely missing

Measured against `admin-os.js` (the provider verification review op):

**Already implemented — do not rebuild:**
- **Self-approval is already prohibited**, with the reasoning in the code:
  *"A reviewer may not decide their own submission, whatever claims they hold. An administrator is
  still an applicant when the subject is themselves."* — `if (uid === actor) throw`.
- A decision cannot be manufactured: the op refuses when no submission exists, so it is a decision
  **on submitted evidence** rather than a way to create one.
- A rejection requires a reason the applicant can act on.
- Idempotent: re-issuing the same decision writes no second audit entry, so a double-tapped button
  cannot manufacture a second review event — which matters once "two reviews" is the rule.
- Records `reviewedBy`, `reviewedAt`, `previousStatus`, and `documentsReviewed`.

**Missing, and exactly what this ruling adds:**
1. **No capability registry.** `admin-os-dispatch.js` authorizes *"every op with the same
   admin/superAdmin check"* — so today **any admin is a verification reviewer**. The designated
   capability does not exist and must be created; the ruling cannot be satisfied by configuration.
2. **The schema is single-reviewer.** `reviewedBy`/`reviewedAt` are singular. Two-reviewer
   approval needs `reviewer1`/`reviewer2`, which is a schema change folded into the deferred
   `providerVerification` generalisation — not a separate migration.
3. **Reviewer-1 ≠ reviewer-2** must be enforced server-side, the same way `uid === actor` already
   is. Two approvals from one person is the failure this ruling exists to prevent, and it is a
   different check from self-approval.

---

## 4b. Candidate comparison — completed 2026-09-13 against current vendor documentation

**Persona LEADING, NOT APPROVED. Sumsub a serious finalist. Veriff a benchmark** unless it can
contractually defeat its published retention position (90 days active + 3-year archive, biometric
embeddings included, backups to 90 days) — capable technically, but D-04a cannot pass on those
public terms.

**Demographic-performance evidence is 🔴 for ALL THREE.** Not a tie — a procurement result. Do not
accept "we are unbiased", "AI tested", or SOC 2 / ISO certification: security certification and
demographic-performance evidence answer different questions. Require methodology, population
composition, metrics, confidence intervals where available, and results relevant to the
populations SOKONI actually onboards.

### THE CONTINGENCY THIS CREATES — decide before issuing the evidence request

V-g is **mandatory and disqualifying**. If no finalist supplies demographic evidence to that
standard, then by SOKONI's own contract every candidate is disqualified and procurement deadlocks.
Under **D-01 = Universal** this is not a niche risk: the requirement applies to every merchant on
the platform, so a vendor that underperforms for any demographic group excludes real applicants
from trading.

Three ways out, and the choice should be made **before** the request goes out, not after the
answers arrive and one vendor is already preferred:

1. **Hold the line** — no vendor without the evidence. May mean no biometric verification ships,
   which forces D-01 back open.
2. **Accept a defined substitute** — e.g. independent third-party evaluation (NIST FRVT-style)
   plus contractual performance warranties and a remediation obligation. Weaker than direct
   evidence; at least it is specified in advance rather than negotiated under pressure.
3. **Mitigate rather than evidence** — proceed, and lean on D-15's assisted route as the
   compensating control, with monitoring of failure rates by route. This only works because the
   assisted path yields the SAME official status; without that it would formalise exclusion.

Option 3 is only defensible if the assisted-route capacity is real. A fallback nobody is staffed
to perform is not a mitigation.

### Two additions to the VerificationResult shape

The shape is otherwise right, and `automatedOutcome` (rather than `outcome`) correctly keeps the
adapter to *evidence* while `humanDecision` stays SOKONI's. Two fields are missing:

    deletionHandle    what SOKONI uses to COMMAND deletion at 30 days and to verify it happened.
                      D-04a requires deletion EVIDENCE; without a handle returned at verification
                      time, SOKONI can request deletion but cannot prove it for a specific record.

    vendorReceivedAt  the vendor's OWN retention clock starts at their ingest, not at SOKONI's
                      decision. Both timestamps are needed to check a vendor deleted on time —
                      SOKONI's 30 days runs from the decision, theirs does not.

## 5. Invariants carried forward

    verificationStatus   workflow state
    faceMatchScore       automated evidence, probabilistic
    humanDecision        authority
    official             derived — never client-supplied, never implied by a score

The surviving audit record (D-13) is designed **before** disposal is built. Deletion is
irreversible, and building the sweep first destroys the evidence of how a decision was reached.
