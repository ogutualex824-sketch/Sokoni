# Live Activation — Dependency Chain

**Status:** BLOCKED at Step 1. One action by an operator clears it.
**Verified:** 2026-07-20, against the live `sokoni-aeb26` project.

---

## The blocker, precisely

`seed-bootstrap.js` and every other Admin SDK script fail with:

```
Failed: 2 UNKNOWN: Getting metadata from plugin failed with error: invalid_client
```

That is **not** a code fault and not a permissions fault. It is credential resolution.

### What was checked

| Credential source | State | Evidence |
|---|---|---|
| Application Default Credentials | **stale** | `%APPDATA%\gcloud\application_default_credentials.json` exists, `type: authorized_user`, dated 2026-06-21, gcloud's own `client_id`. Its refresh token is revoked → `invalid_client` |
| `gcloud` CLI | **unusable** | `gcloud --version` → *"Python was not found"*. So `gcloud auth application-default login` cannot be run to refresh the above |
| Firebase CLI | **WORKING** | v15.19.0, `firebase login:list` → `alexochieng3030@gmail.com`, `firebase projects:list` → `sokoni-aeb26 (current)` |
| Service-account key | **absent** | none in the repo, `~/Downloads`, `C:\temp` or `C:\tmp`. The path documented at `functions/scripts/typesense-direct.js:10` no longer exists — correctly, since it is a credential |

### Why the working Firebase CLI is not enough

The CLI holds its own credentials and can reach the project, but the **Admin SDK does not use them**. `admin.initializeApp()` resolves credentials from ADC or `GOOGLE_APPLICATION_CREDENTIALS`, neither of which is currently valid.

The CLI has no single-user lookup, so it cannot answer Step 1 directly. `firebase auth:export` would — but it dumps **every** user's auth record, including PII for the whole user base, to answer a question about two accounts. That is the wrong instrument and was correctly refused.

---

## The one action that clears it

Firebase Console → **Project Settings → Service Accounts → Generate new private key**. Save it outside the repo — `*service-account*.json` and `*firebase-adminsdk*.json` are gitignored (`.gitignore:101-102`), but outside the tree is safer.

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\keys\sokoni-adminsdk.json"
node functions/scripts/seed-bootstrap.js --phone +254705726803 --dry-run
```

The alternative — installing Python so `gcloud auth application-default login` works — reaches the same place with more steps, and gcloud has been broken for the whole of this work.

**A service-account key is a full-project credential.** Keep it out of the repo, out of chat, and revoke it in the Console when the chain below is cleared.

---

## The chain this unblocks

Every remaining production blocker descends from this one. Each step's prerequisite is the step above it.

```
[1] Admin SDK credentials          <-- BLOCKED HERE
      |
[2] Super Admin identity
      seed-bootstrap.js --dry-run
      -> UID, phone, email, existing claims, identity split Y/N
      |  if the phone and email are different UIDs: STOP.
      |  docs/IDENTITY_LINK_MIGRATION.md — do not merge automatically.
      v
[3] Super Admin activation
      seed-bootstrap.js  ->  bootstrap once  ->  sign out / in
      or set-admin-claim.js --phone +254705726803 --super   (one step)
      |
      v
[4] Admin routes runtime-verified
      admin.html, registry, user + merchant management
      |
      v
[5] Search recovery
      backfill-product-status.js --apply   (products have no `status`;
      every retrieval path filters where('status','==','active'))
      then algoliaBackfill  (mapping now targets sokoni_products; records
      already written to products_index do not move on their own)
      -> certify "Peach Grape" in global search, storefront, categories
      |
      v
[6] Merchant activation
      SokoniActivationPreflight -> first blocking stage, with evidence
      open question it will settle: business-bootstrap.js:884 fabricates
      `${merchantId}-main` when a business has no defaultBranchId
      |
      v
[7] POS provisioning on a real device
      |
      v
[8] KASS merchant capabilities
```

---

## What is already fixed and waiting on this

Code-complete, tested, **not** runtime-verified — every one is downstream of Step 1:

| Fix | Commit | Waiting on |
|---|---|---|
| Search index mismatch + missing `status` | `a5201c0` | backfill + reindex (needs admin) |
| 24 auth guards on a claim nothing sets | `ab1dd7e` | a real admin session |
| Bootstrap by UID, not email | `8f38864` | seed + one bootstrap call |
| POS provisioning diagnostics | `74138b7` | a real provisioning attempt |
| Activation preflight | `c8596b5` | a signed-in merchant |

---

## Honest position

Five consecutive sprints have ended at this same wall. The pattern is consistent: a real defect is found and fixed with repository evidence, then certification stops because runtime verification needs a live session.

**More code will not move this.** The next useful output is the result of one `--dry-run`.
