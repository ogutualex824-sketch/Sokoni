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

### 2026-09-05 — Donna (`donna@adg.io`) — Step 2: developer + deployment access

**Decision.** Grant six least-privilege roles on project `sokoni-aeb26` so Donna can
build, debug, and deploy SOKONI. **Developer and deployment collaborator — not an owner.**
Reviewed and approved by Alex before application.

| Role | Capability granted |
|---|---|
| `roles/firebase.developAdmin` | Read/write Firestore data and Storage objects, manage Functions/Hosting/Auth resources, Firebase console access |
| `roles/cloudfunctions.developer` | Deploy, update, and delete Cloud Functions |
| `roles/firebasehosting.admin` | Deploy Hosting releases, manage sites and preview channels |
| `roles/logging.viewer` | Read Cloud Logging |
| `roles/errorreporting.viewer` | Read Error Reporting |
| `roles/monitoring.viewer` | Read metrics and dashboards |

**Accepted trade-off, explicitly acknowledged by the owner.** `firebase.developAdmin`
carries read/write access to **live production Firebase data** — real customer records,
orders, and wallet documents. No Firebase role grants deploy capability without it. This
is the accepted consequence of choosing a deploy-capable developer over a staging-only
developer. The mitigation is that every administrative and self-escalation role is
withheld.

**Applied.**

```
for R in roles/firebase.developAdmin roles/cloudfunctions.developer \
         roles/firebasehosting.admin roles/logging.viewer \
         roles/errorreporting.viewer roles/monitoring.viewer; do
  gcloud projects add-iam-policy-binding sokoni-aeb26 \
    --member="user:donna@adg.io" --role="$R"
done
```

Project policy etag `BwZab5yQA3Q=` -> `BwZauN7VlmI=`. Member-bindings 39 -> 45 (delta 6).

**Withheld — NOT granted, require separate authorization:**

| Role | Why withheld |
|---|---|
| `roles/owner` | Ownership is not delegable |
| `roles/resourcemanager.projectIamAdmin` | Would permit self-escalation to any role |
| `roles/resourcemanager.organizationAdmin` | Confers no production authority (project is outside the org) while granting real control of the org container |
| `roles/billing.admin` | Could link/unlink projects and close the billing account |
| `roles/firebaserules.admin` | Firestore Rules are a protected boundary |
| `roles/secretmanager.secretAccessor` | Payment, eTIMS, and SMS credentials |
| `roles/iam.serviceAccountKeyAdmin` | Service-account key exfiltration path |
| `roles/iam.serviceAccountUser` | **Deliberately not granted.** To be granted only if a real deployment failure demonstrates it is required, and then only after reporting the exact failure for a fresh decision. No deployment was run, so no such need has been demonstrated. |

**Verified after applying.** Donna holds exactly the six approved roles and no others.
Each of the eight withheld roles confirmed absent from her bindings. `roles/owner` on
`sokoni-aeb26` returns `user:alexochieng3030@gmail.com` and nothing else. Donna's
`roles/billing.viewer` from Step 1 intact, billing policy etag unchanged at
`BwZauLRpjaI=`. Donna has no organization binding. A diff of all non-Donna bindings
before against after is **identical** — no other binding changed. No application
deployment was performed; an IAM change is not a release.

**Deployment constraint Donna must follow.** Deploy with explicit targets only:

```
firebase deploy --only hosting,functions
```

A bare `firebase deploy` attempts to publish Firestore Rules. She does not hold
`firebaserules.admin`, so that attempt fails rather than succeeding silently — but the
explicit-target habit is the intended control, not the role boundary alone. She must also
be briefed on `scripts/deploy/guard-no-rollback.js`: deploy rights mean a stale worktree
can roll production back, and the guard is the control that prevents it.

**Reversal.**

```
for R in roles/firebase.developAdmin roles/cloudfunctions.developer \
         roles/firebasehosting.admin roles/logging.viewer \
         roles/errorreporting.viewer roles/monitoring.viewer; do
  gcloud projects remove-iam-policy-binding sokoni-aeb26 \
    --member="user:donna@adg.io" --role="$R"
done
```

---

## Open items

- **GitHub source access — PENDING, deliberately unchanged.** Donna's GitHub username is
  not yet known; `donna@adg.io` is a Google identity, not a GitHub handle. When supplied,
  grant **Write/push**, never Admin:
  `gh api -X PUT repos/ogutualex824-sketch/Sokoni/collaborators/<username> -f permission=push`.
  Also blocked locally: the `gh` CLI on the operator workstation is unauthenticated, so
  current collaborators cannot be enumerated. Note the repo is public, so Donna can
  already read and clone all source; only push requires this grant.
- **`roles/iam.serviceAccountUser`** — conditional, not granted. If a Functions deploy
  fails with a service-account error, report the exact failure and obtain a fresh decision
  rather than granting it reflexively.
- **Repository visibility.** `Sokoni` is public. Reviewed 2026-09-05: the only tracked
  secret-shaped file, `functions/.env`, contains six non-sensitive configuration keys
  (`ALGOLIA_APP_ID`, `TYPESENSE_NODES`, `ETIMS_ENV`, `AT_ENV`, `AT_SENDER_ID`,
  `DARAJA_SANDBOX_SELLER_UIDS`) and no credentials or service-account material. No
  exposure found; the posture decision remains open.
- **Organization access** — none granted and none proposed. Withheld indefinitely unless
  `sokoni-aeb26` is ever migrated under `SokoniTech`, which would change the calculus.
