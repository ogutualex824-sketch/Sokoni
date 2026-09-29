# Landing — King Bruce: admin approval decision REFUSE (identity 4 of 6)

**Applied 2026-09-29T22:16:26Z** under the owner's authorization of digest `21746cfc69025723ec4f7a308d23c1db4c54970926b65f6762aa2e32e2cc7e8b`, with the owner's reason text verbatim, through the REAL `bizAdminApprovalDecide` handler ([[APPROVAL_DECISION_AUTHORITY]]) via `scripts/approval-decision-manifest.js --apply`. Actor: the real admin account **`D5Ql2EYr95bt79IpcGTmOMTK0P83`** (admin + superAdmin claims, verified by the apply before any target read). Packet: `docs/release-gates/kingbruce-landing.json`. **DJ Bvmbxno and Kasindi untouched (control digests identical).**

## 1 · Decision record written (`providers/aOdQxmUGLCO4hOYsdHMhWuwYV9D2.approvalDecision`)

`{ decision: refuse, decidedBy: D5Ql2EYr95bt79IpcGTmOMTK0P83, decidedAt: 22:16:26Z, reason: <owner text>, prior: { status: active, approvedAt: null, approvedBy: null, decidedBy: null }, source: admin_decision }`. The prior state is copied verbatim; the record says what was there (a client-written `active` with no evidence) and what was decided today.

## 2 · Audit record written

`adminAudit/ERx37gnfqJk4YNFHqGdA` — `action: business_approval_decision`, `targetUid: aOdQxmUG…`, `performedBy: D5Ql2EYr…`, `decision: refuse`, `previous: { status: active, approvedAt: null }`, `next: { status: suspended, approvedAt: null }`, the owner's reason, `createdAt` 22:16:26Z. `adminAudit` total 21 → **22**; the uid's audits 0 → **1**.

## 3 · Projection

`status: suspended`, `suspended: true`, `searchable: false`, `isPublic: false`, `updatedAt` refreshed. **No `approvedAt`, no `approvedBy`** were written (a refusal creates no approval evidence). No role granted: `users/{uid}` byte-identical, Auth claims unchanged (none).

## 4 · Unchanged (pre 22:15:13Z vs post 22:17Z, byte-level)

wallet document and wallet transactions (0), bookings (0), services (0), applications (0, none created), sellers / businesses / shops (absent). Provider count 11 → 11. Control digests identical for DJ Bvmbxno's provider, Kasindi's provider and application, and k Riss's provider.

## 5 · One side effect, not from the authority — recorded

The provider document also changed in **`searchableTerms`**: the deployed `indexProviderUpdate` trigger (Cloud Function, built 2026-09-09, `providers/{providerId}` on-write) regenerates prefix search terms on every provider update, so the write above caused it to replace the eight legacy terms with the current prefix set. Same document, deployed production behaviour, not a write by `bizAdminApprovalDecide`. The record is delisted by `searchable: false` / `isPublic: false`; whether every search surface honours those flags rather than the presence of terms is a separate question for the discovery track ([[project_shop_discovery_authority]]), noted, not acted on.

## 6 · Idempotency

Second apply with the same digest and actor → `applied: false, reason: already_decided_same`; the provider document is byte-identical between the first and second post-snapshots; audits still 1 / 22.

## 7 · Landing checks

11 assertions: **11 pass** once two harness artefacts are read correctly — the `prior` comparison differed only in Firestore key order (content identical), and the changed-field set included `searchableTerms` for the reason in §5. Every substantive assertion (record, audit, projection, no evidence, no role, isolation, controls, idempotency) passed on first evaluation.

## Next

DJ Bvmbxno: **no decision** (owner: keep unchanged while the reapplication path is implemented). Kasindi: unchanged tonight; tomorrow the acknowledgement gate → fresh approval through `applicationDecide` with preservation. Then the **Approval Remediation / Reapplication** slice the owner specified: census (partition buyers / valid / invalid-legacy / none / pending / refused) → server-derived approval state → user "complete your application" surface → same-admin decision → projection; no production writes until tested and each identity manifested.

Related: [[MANIFEST_APPROVAL_DECISION_DJ_KINGBRUCE]] · [[ADJUDICATION_SIX_UNRESOLVED]] · [[LANDING_KRISS_ARTIST_CREATOR]]
