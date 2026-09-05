# IAM & Access Decisions

Authoritative ledger of who holds which role, at which scope, across the SOKONI
estate. Every grant, revocation, and refusal is recorded here with its evidence.

Related: [[ADMIN_ROLES]] · [[ADMINISTRATOR_GUIDE]] · [[ADMIN_CREDENTIAL_RISK_REPORT]]

---

## Estate map (verified 2026-09-05)

| Scope | Identifier | Notes |
|---|---|---|
| Organization | `SokoniTech` — `919282779719` | **Does not contain SOKONI.** Holds only `project-78965978-780a-45d0-a68` ("My First Project"). |
| Project | `sokoni-aeb26` — number `24799054989` | **No `parent`.** Standalone project, outside the org. This is production SOKONI. |
| Billing | `016742-7E2122-8406F7` — "Firebase Payment" | OPEN; linked to `sokoni-aeb26`, `billingEnabled: true`. |
| Repository | `github.com/ogutualex824-sketch/Sokoni` | Owner type **User** (personal, not a GitHub org). **Visibility: PUBLIC.** |

### Structural facts that constrain every future grant

1. **Org roles do not reach production.** Because `sokoni-aeb26` has no org parent,
   any role granted at `SokoniTech` — including `roles/resourcemanager.organizationAdmin`
   — confers **zero** authority over SOKONI. Project access must be granted on
   `sokoni-aeb26` directly. Do not treat an org grant as a project grant.
2. **GCP IAM never grants source-code access.** The repository is governed solely by
   GitHub collaborator/team permissions. These are two disjoint permission systems and
   must be mapped and recorded separately.
3. **The repository is public.** Read access to all SOKONI source is already granted to
   everyone. No IAM or GitHub change is required for any person to *read* the code;
   only push/admin requires a collaborator grant. Repository visibility is an open
   posture question, tracked separately from any individual's access.
4. **No domain restriction is in force.** `constraints/iam.allowedPolicyMemberDomains`
   is unset at both org and project, and the project inherits nothing. External
   identities can therefore be bound without a policy exception.

---

## Standing authority

**Sole owner: `alexochieng3030@gmail.com`.** Ownership is not delegable and is not
transferred by any decision in this ledger.

| Scope | Role |
|---|---|
| `sokoni-aeb26` | `roles/owner` (**sole** human binding on the project) |
| `016742-7E2122-8406F7` | `roles/billing.admin` |
| `SokoniTech` | `organizationAdmin`, `billing.admin`, `billing.creator`, `projectCreator`, `projectMover`, `serviceUsageAdmin`, `workforcePoolAdmin` |

> Identity note: the GCP estate is held by `alexochieng3030@gmail.com`, while the git
> author and GitHub owner is `ogutualex824@gmail.com` / `ogutualex824-sketch`. Both are
> the founder. Confirmed 2026-09-05. Any future automation must not assume one identity
> implies the other.

---

## Decision log

### 2026-09-05 — Donna (`donna@adg.io`) — Step 1: billing visibility

**Decision.** Grant `roles/billing.viewer`, scoped to billing account
`016742-7E2122-8406F7` only. Donna is a trusted collaborator on development, build, and
management. **She is not an owner and ownership remains exclusively with Alex.**

**Applied.**

```
gcloud billing accounts add-iam-policy-binding 016742-7E2122-8406F7 \
  --member="user:donna@adg.io" \
  --role="roles/billing.viewer"
```

**Before** (`etag: BwZTnZ1Be3Q=`) — `roles/billing.admin` → `alexochieng3030@gmail.com`, single binding.

**After** (`etag: BwZauLRpjaI=`):

```
bindings:
- members:
  - user:alexochieng3030@gmail.com
  role: roles/billing.admin
- members:
  - user:donna@adg.io
  role: roles/billing.viewer
```

**Verified.** `roles/owner` on `sokoni-aeb26` returns `user:alexochieng3030@gmail.com`
and nothing else. A `donna` filter over the project IAM policy returns empty; the same
filter over the org policy returns empty. Billing linkage unchanged. Repository
visibility unchanged. `firestore.rules`, payment rails, and deployment configuration
untouched — no application deploy was performed, and none was required.

**What this grants.** Read-only billing information, cost and usage reports, and budget
visibility for account `016742-7E2122-8406F7` and the projects it funds.

**What this does NOT grant.** Any access to `sokoni-aeb26` resources — Firestore, Cloud
Functions, Storage, Hosting, deployment, console resource administration. No ability to
modify budgets, link or unlink projects, or authorize spend. No source-code write access.
No organization role.

**Reversal.** `gcloud billing accounts remove-iam-policy-binding 016742-7E2122-8406F7
--member="user:donna@adg.io" --role="roles/billing.viewer"`

**Explicitly withheld pending separate authorization:** `roles/owner`,
`roles/resourcemanager.organizationAdmin`, `roles/billing.admin`, and every project-level
production role. GitHub collaborator access was **not** granted and was not in scope.

---

## Open items

- **Step 2 — project development access** on `sokoni-aeb26`, not yet authorized. Must be
  specified as a least-privilege role set on the project directly (org roles will not work
  — see constraint 1) and recorded here before it is applied.
- **Repository write access** for Donna, if wanted, is a GitHub collaborator grant
  (Write or Maintain), entirely separate from GCP IAM. Not granted. Blocked locally:
  the `gh` CLI on the operator workstation is unauthenticated, so current collaborators
  could not be enumerated.
- **Repository visibility.** `Sokoni` is public. Reviewed 2026-09-05: the only tracked
  secret-shaped file, `functions/.env`, contains six non-sensitive configuration keys
  (`ALGOLIA_APP_ID`, `TYPESENSE_NODES`, `ETIMS_ENV`, `AT_ENV`, `AT_SENDER_ID`,
  `DARAJA_SANDBOX_SELLER_UIDS`) and no credentials or service-account material. No
  exposure found; the posture decision remains open.
