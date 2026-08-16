# Role Authority

**Status:** primitive live in repo, **not deployed** · Stage 2 of the role-convergence track
**Owner module:** `functions/role-authority.js`
**Related:** [[Authentication]] · [[Access Control Matrix]] · [[Application Lifecycle]] · [[Security]]

---

## The invariant

An account role is **two facts that must agree**:

| fact | store | read by |
|---|---|---|
| `users/{uid}.roles[]` | Firestore | the server, every dashboard, the analytics gate |
| `customClaims.<key>` | Firebase Auth | `firestore.rules`, the client role gate |

Since Role Authority Phases 1–5 the **claim is the only client-side authority**. Firestore alone
grants nothing the user can act on; the claim alone grants access the server does not recognise.

Vocabulary → canonical key:

| application role | key (`roles[]` *and* claim) |
|---|---|
| `provider`, `health`, `legal` | `provider` |
| `driver` | `rider` |
| `seller` | `seller` |

---

## The contract

`setCustomUserClaims()` is an **Auth** call. It is not part of Firestore's transactional model, so
it must never run inside `runTransaction`: a transaction retry re-issues it, and a rolled-back
transaction leaves a claim minted for a grant that never happened.

```
roleFieldPatch(role, approved, extra)     ← inside the caller's transaction / batch / set
            ↓                               (field values and sentinels only — no I/O)
        COMMIT succeeds
            ↓
syncRoleClaim(uid, role, approved, ctx)   ← after the commit, never inside it
            ↓
   { ok: true }  → the caller may report success
   { ok: false } → the caller reports PENDING and surfaces the reconcile id
```

`grantAccountRole(db, uid, role, approved, ctx)` is the all-in-one form for a caller that has no
transaction of its own; it is the same two phases in order.

### API

| export | purpose |
|---|---|
| `roleFieldPatch(role, approved, extra?)` | the Firestore half, as a plain patch. Caller extras are merged **first** so the canonical role fields always win. |
| `syncRoleClaim(uid, role, approved, ctx?)` | the Auth half. **Never throws.** Returns `{ ok, key, claim, reconcileId, error }`. |
| `grantAccountRole(db, uid, role, approved, ctx?)` | patch + mint, in order. |
| `claimsFor(role, approved, existing)` | the claim shape, merged onto existing claims. |
| `roleKeyFor(role)` / `ROLE_KEY` | vocabulary → canonical key. |

---

## Failure is observable, never silent

A mint that fails **after** the Firestore commit is the exact divergence this module exists to
prevent from hiding. `syncRoleClaim` records it and returns it:

- `roleClaimReconcile/{uid}__{key}` — `state: CLAIM_MISSING` (grant) or `CLAIM_STALE` (revoke, the
  more urgent one — the privilege is still live in the token), plus `source`, `entityId`,
  `lastError`, `attempts`, `lastFailedAt`. Server-only: the collection has **no rules match**, so
  default-deny applies and no client can enumerate accounts whose privileges are mid-flight.
- `adminAlerts/role_claim_unminted__{uid}__{key}` — severity `high`, deterministic id so a retried
  grant updates one alert instead of flooding the queue.
- On the next successful mint the reconcile record is deleted.

**Nothing self-repairs.** Classification precedes repair; a sweep over an unclassified population is
how a privilege reaches an account nobody decided to grant it to.

### What each caller does with `{ ok: false }`

| caller | behaviour |
|---|---|
| `application-lifecycle.js` | `projectionStatus: 'applied_claim_pending'`, `projectionError` names the reconcile id; the applicant is told *"Approved — finishing setup"*, under a separate dedupe key so the real approval can still be sent. |
| `automation-engine.js` (auto-approve) | audit outcome `approved_claim_pending`, an `automationQueue` exception at `high`, honest notification. |
| `wap.js` (`seller.activate`) | **throws.** The step has no `onFailure`, so the instance fails to the DLQ rather than advancing to *"Notify Seller: Approved"*. The Firestore write is an idempotent merge — a re-run converges. |

---

## Gotcha: `set()` does not expand dot notation

`patch['registeredAs.seller'] = true` passed to `set()` creates a field **literally named**
`registeredAs.seller`; the nested map is never touched. Only `update()` expands dot paths
(`DocumentSnapshot.fromUpdateMap`). The previous implementation did exactly this, so `registeredAs`
was never populated by a role grant. The primitive writes the nested form.

---

## Verification

```bash
node scripts/test-role-authority.js        # 29/0 — no emulator, no credentials
```

- **Part A** drives the real primitive against stubbed `firebase-admin` modules and asserts the
  exact payload: `roles[]` via `arrayUnion`, nested `registeredAs`, preserved unrelated claims,
  Firestore-before-mint ordering, and every field of the failure record.
- **Part B** is a static contract on the call sites — and every detector is proven by a **mutation**
  that reintroduces the original defect (bare `role: 'seller'`, a dropped mint, a mint moved inside
  the transaction). A detector that cannot fail proves nothing.

```bash
GOOGLE_APPLICATION_CREDENTIALS=… GCLOUD_PROJECT=… node scripts/census-role-claims.js --out <file>
```

Read-only classification of the live population into **CONSISTENT / CLAIM_MISSING / ROLE_MISSING /
AMBIGUOUS**, plus dangling Firestore roles and open reconcile records. Zero writes. **Not yet run.**

---

## Open — not addressed by Stage 2

Found while building the claim-writer registry; recorded, deliberately untouched.

| file | issue |
|---|---|
| `functions/admin-os.js` | `adminSetUserRole` accepts `seller`/`provider`/`driver` and mints `{[role]: true}` **without spreading existing claims** — assigning a role destroys every other claim on the account (an admin who is also a seller loses `admin`). It writes `users.role` (string), never `roles[]`. A third account-role authority. |
| `functions/provider-onboarding.js` | mints `provider: true` **before** `batch.commit()`, and the batch never writes `users.roles[]` — the ROLE_MISSING mirror of this defect. |
| `functions/universal-onboarding.js` | a parallel role model on `accounts/{uid}`, not converged with `users/{uid}`. |
| `functions/invitations-core.js` | writes `` [`registeredAs.${role}`] `` through `set()` — the same dot-notation trap fixed above. |
| `sokoni-wap-definitions.js:419` | a **client-side** `seller.activate` that writes `users/{uid}.role`. Live rules put `role` in both `noAdminFields()` and `noSelfGrant()`, so it is denied and throws — dead on arrival, not an escalation vector. |
