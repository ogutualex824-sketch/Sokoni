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
| `roles/firebaserules.admin` | ⚠️ **Withholding this is INEFFECTIVE — see the correction below.** `firebase.developAdmin` already grants all 11 `firebaserules.*` permissions. Donna *can* publish Rules. |
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

A bare `firebase deploy` attempts to publish Firestore Rules.

> **CORRECTION 2026-09-06 — this paragraph previously claimed such an attempt would FAIL
> because `firebaserules.admin` was withheld. That was wrong, and the error was in the
> safe-sounding direction.** `roles/firebase.developAdmin` — granted in this step —
> already contains **all 11 `firebaserules.*` permissions**, which is the complete set
> `roles/firebaserules.admin` confers (that curated role adds only
> `resourcemanager.projects.get`/`.list`, which she holds anyway). Enumerated from
> `gcloud iam roles describe`, not assumed:
> `firebaserules.rulesets.{create,delete,get,list,test}` and
> `firebaserules.releases.{create,delete,get,getExecutable,list,update}`.
>
> **Donna can publish Firestore and Storage Rules.** Withholding `firebaserules.admin`
> bought nothing; it was redundant with a role already granted. A bare `firebase deploy`
> from her machine would publish rules **successfully**, and from a stale worktree it
> would publish *stale* rules.

The explicit-target habit is therefore **the only control**, not a backstop to a role
boundary that does not exist:

```
firebase deploy --only hosting,functions
```

She must also be briefed on `scripts/deploy/guard-no-rollback.js`: deploy rights mean a
stale worktree can roll production back, and the guard is the control that prevents it.

**Open decision for the owner.** If Rules publishing must genuinely be withheld, it cannot
be done by omitting `firebaserules.admin`. It requires either replacing
`firebase.developAdmin` with a narrower custom role that excludes `firebaserules.*`, or
accepting that Rules publication is within Donna's authority and relying on the deploy
discipline plus the `guard-rules-lineage.js` / `build-firestore-rules.js` predeploy hooks.
Not decided here; recorded so the choice is made deliberately rather than assumed.

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

### 2026-09-06 — Donna (`donna@adg.io`) — Step 3: billing administration

**Decision.** Grant `roles/billing.admin` on billing account `016742-7E2122-8406F7`
("Firebase Payment"). Explicitly authorized by the owner on 2026-09-06.

This role was on the **withheld** list from Step 1 and was released only by this separate,
specific authorization — not reflexively, and not as a consequence of Step 2. The withheld
list otherwise stands unchanged.

**Ownership boundary is intact.** `roles/billing.admin` is a **billing-account** role, not
a project role. It confers no authority over `sokoni-aeb26` — no `roles/owner`, no IAM
administration, no ability to grant itself or anything else on the project. Donna can
administer the billing account (payment methods, budgets, billing IAM, linking projects);
she cannot become a project owner through it.

**Existing permissions preserved.** `roles/billing.viewer` was retained rather than
replaced, per the owner's instruction. It is now redundant in capability but was not
removed.

**Applied.**

```
gcloud billing accounts add-iam-policy-binding 016742-7E2122-8406F7 \
  --member="user:donna@adg.io" --role="roles/billing.admin"
```

**Evidence — before, from a fresh read (etag `BwZay3MLobE=`):**

```
user:alexochieng3030@gmail.com  ->  roles/billing.admin
user:donna@adg.io               ->  roles/billing.viewer
```

**After (etag `BwZa0pmPKlQ=`), re-read independently rather than taken from the mutation's
own output:**

```
user:alexochieng3030@gmail.com  ->  roles/billing.admin
user:donna@adg.io               ->  roles/billing.admin
user:donna@adg.io               ->  roles/billing.viewer
```

Line-level diff of before vs after: **exactly one line added**, none removed —
`user:donna@adg.io -> roles/billing.admin`. Comparator proven non-empty (2 lines in,
3 lines out); a first attempt at this diff used `python`, which is not on PATH on this
workstation, and both sides came back empty — it "passed" vacuously and was discarded.

**Verified independently:**

| Check | Result |
|---|---|
| Donna holds `roles/billing.admin` | ✅ `roles/billing.admin`, `roles/billing.viewer` |
| Existing billing permissions preserved | ✅ nothing removed |
| No project `roles/owner` granted | ✅ Donna's project roles unchanged — the same six from Step 2 |
| Alex remains sole project Owner | ✅ `roles/owner` on `sokoni-aeb26` = `user:alexochieng3030@gmail.com`, single binding |

**Reversal.**

```
gcloud billing accounts remove-iam-policy-binding 016742-7E2122-8406F7 \
  --member="user:donna@adg.io" --role="roles/billing.admin"
```

---

### 2026-09-06 — Donna (`dreamgirl254`) — Step 4: GitHub Write — **APPLIED, INVITATION PENDING**

**Decision.** Grant `dreamgirl254` **Write/push** on `ogutualex824-sketch/Sokoni`. Admin,
Maintain and Owner withheld. Repository visibility unchanged (remains public). Authorized
by the owner 2026-09-06.

**Authentication.** `gh` was unauthenticated on this workstation and had no credential
anywhere — no `hosts.yml` under the user profile, no `GH_TOKEN`/`GITHUB_TOKEN`, and
`gh auth token` returned *no oauth token found*. Being signed in to github.com in a
**browser** is not the same credential: the CLI keeps its own token and inherits nothing
from browser, VS Code or GitHub Desktop sessions. Resolved by an OAuth **device flow**,
which runs without a TTY — the owner entered the one-time code and authorized. No token
was read from a file or from the Windows Credential Manager, per standing instruction.

Authenticated as `ogutualex824-sketch` (keyring), scopes `gist`, `read:org`, `repo`.

> The first device attempt returned `access_denied`, and a `/login/device` 404 was reported.
> Cause: a bounded 20-second probe had already consumed and killed an earlier code, and that
> dead code was the one entered. Codes are single-use and die with the process that issued
> them — issue the code from the same long-lived process that will complete the flow.

**Applied.**

```
gh api -X PUT repos/ogutualex824-sketch/Sokoni/collaborators/dreamgirl254 \
  -f permission=push
```

Response: invitation `331925079` created — invitee `Dreamgirl254`, permission `write`,
inviter `ogutualex824-sketch`, `2026-09-06T16:14:15Z`.

**Before-state (captured before the change):**

```
visibility: public   private: false   owner: ogutualex824-sketch (User)
collaborators (direct): ogutualex824-sketch  role_name=admin  admin=true maintain=true push=true
pending invitations: (none)
```

**STATUS: `pending invitation — permission: push`. NOT active access.**

This is the material distinction, and the two API views disagree by design:

| View | Result |
|---|---|
| `/invitations` | `Dreamgirl254` — **permission=write**, id `331925079` |
| `/collaborators/dreamgirl254/permission` | `role_name=read`, `permission=read`, `push=false` |

The second is the **effective** permission, and it reads `read` only because the repository
is public — that is the baseline every anonymous visitor already has, not a grant. Donna
holds **no write capability until she accepts the invitation.** Do not report her as having
Write access before acceptance; re-run the permission probe afterwards, at which point it
must read `role_name=write`, `push=true`.

**Verified independently after applying:**

| Check | Result |
|---|---|
| Donna = Write/Push | ⏳ invitation `permission=write`; effective still `read` — **pending acceptance** |
| Donna ≠ Admin | ✅ `admin=false` |
| Donna ≠ Maintain | ✅ `maintain=false` |
| Repository visibility unchanged | ✅ `public` / `private=false`, before and after |
| No other collaborator permissions changed | ✅ before/after diff empty (comparator proven non-empty: 1 line in, 1 line out) |
| Alex remains sole repository Owner | ✅ owner `ogutualex824-sketch` (User); admin count **1** |

**Post-acceptance verification (run when she accepts):**

```
gh api repos/ogutualex824-sketch/Sokoni/collaborators/dreamgirl254/permission \
  --jq '{role: .role_name, admin: .user.permissions.admin, maintain: .user.permissions.maintain}'
# expect: role=write, admin=false, maintain=false
```

**Reversal.**

```
gh api -X DELETE repos/ogutualex824-sketch/Sokoni/invitations/331925079      # before acceptance
gh api -X DELETE repos/ogutualex824-sketch/Sokoni/collaborators/dreamgirl254 # after acceptance
```

**Scope note.** This grant is repository push only. It confers nothing in GCP, and the two
systems remain disjoint per *Structural fact 2*. Donna's deploy capability comes from her
Step 2 project roles, not from this.

---

## Open items

- **GitHub source access — APPLIED 2026-09-06, AWAITING ACCEPTANCE.** Invitation
  `331925079` issued to `dreamgirl254` with `permission=write`. **Her effective permission
  is still `read` until she accepts** — and that `read` is the public-repo baseline, not a
  grant. See *Step 4* for evidence and the post-acceptance probe. Close this item only
  after the probe returns `role_name=write`, `push=true`, `admin=false`, `maintain=false`.
  The invitation expires after 7 days; re-issue with the same command if it lapses.
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
