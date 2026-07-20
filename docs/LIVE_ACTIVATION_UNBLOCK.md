# Live Activation — Dependency Chain

**Status:** BLOCKED at Step 1. One operator action clears it.
**Verified:** 2026-07-20 against the live `sokoni-aeb26` project.
**Diagnose anytime:** `node functions/scripts/doctor.js`

---

## The blocker, precisely

`seed-bootstrap.js` and every other Admin SDK script fail with:

```
Failed: 2 UNKNOWN: Getting metadata from plugin failed with error: invalid_client
```

That is **not** a code fault and **not** a permissions fault. It is credential resolution.
`invalid_client` means credentials *exist* and are *revoked* — which reads like a permissions
problem and is not one.

### Environment, as measured

| Component | State | Evidence |
|---|---|---|
| Node.js | **PASS** | v24.15.0 win32/x64 |
| Firebase CLI | **PASS** | 15.19.0, logged in, `projects:list` returns `sokoni-aeb26 (current)` |
| gcloud CLI | **WARN** | Installed — Google Cloud SDK 575.0.0 — but **every subcommand fails**: Python is missing |
| Python | **WARN** | Not installed. This is the single reason gcloud is unusable |
| `GOOGLE_APPLICATION_CREDENTIALS` | **unset** | falls through to ADC |
| Application Default Credentials | **WARN** | File exists, `type: authorized_user`, 28 days old. Presence does not prove validity |
| Admin SDK → Firebase Auth | **FAIL** | `invalid_client` — the stored token is revoked |
| Admin SDK → Firestore | **FAIL** | same |
| `.gitignore` protects keys | **PASS** | `*service-account*.json`, `*firebase-adminsdk*.json` |
| No key inside the repo | **PASS** | none found |

### A correction to an earlier pass

An earlier version of this document recorded gcloud as *absent*. It is not — it is **installed but
crippled**. `gcloud --version` is answered by a shim that needs no Python, so the SDK looks healthy
while every command that does real work fails. `doctor.js` now probes a real subcommand
(`gcloud config list`) rather than `--version`, precisely so it cannot report that false green again.

### Why the working Firebase CLI is not enough

The CLI holds its own credentials and reaches the project fine, but **the Admin SDK does not use
them**. `admin.initializeApp()` resolves from ADC or `GOOGLE_APPLICATION_CREDENTIALS`, neither of
which is currently valid. Note that `initializeApp()` itself *succeeds* — credentials are resolved
lazily on the first authenticated call, which is why only a live probe proves anything.

The CLI has no single-user lookup. `firebase auth:export` would answer Step 1, but it dumps **every**
user's auth record — the whole user base's PII to resolve a question about two accounts. Wrong
instrument; not used.

---

## Two ways to clear it

Run `node functions/scripts/doctor.js` first; it reports which applies.

### Option A — refresh ADC (preferred)

gcloud is already installed. It fails only because Python is missing.

1. Install Python 3 — from python.org, or `winget install Python.Python.3.12`
2. Reopen the shell
3. `gcloud auth application-default login`

This mints **scoped, revocable** credentials tied to your own Google identity and leaves no key file
to leak. Prefer it.

### Option B — service-account key (faster, riskier)

Firebase Console → Project Settings → Service Accounts → **Generate new private key**.
Save it **outside** the repository, then:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\keys\sokoni-adminsdk.json"
node functions/scripts/doctor.js
node functions/scripts/seed-bootstrap.js --phone +254705726803 --dry-run
```

A service-account key is a **full-project credential with no expiry**. Keep it out of the repo, out
of chat, and revoke it in the Console once the chain below is cleared. `.gitignore` covers the usual
filenames, but that is a safety net, not a guarantee — storing it outside the tree is the real
control.

---

## The chain this unblocks

Every remaining production blocker descends from this one.

```
[1] Admin SDK credentials              <-- BLOCKED HERE
      |
[2] Super Admin identity
      seed-bootstrap.js --dry-run
      -> UID, phone, email, existing claims, identity split Y/N
      |  If phone and email are DIFFERENT UIDs: STOP.
      |  docs/IDENTITY_LINK_MIGRATION.md — never merge automatically.
      v
[3] Super Admin activation
      seed-bootstrap.js -> bootstrap once -> sign out / in
      or set-admin-claim.js --phone +254705726803 --super   (one step)
      v
[4] Admin routes runtime-verified
      v
[5] Search recovery
      backfill-product-status.js --apply
        (products carry no `status`; every retrieval path filters
         where('status','==','active'), which never matches an absent field)
      then algoliaBackfill
        (the mapping now targets sokoni_products, but records already written
         to products_index do not move on their own)
      -> certify "Peach Grape" in global search, storefront, categories
      v
[6] Merchant activation
      SokoniActivationPreflight -> first blocking stage, with evidence
      open question it will settle: business-bootstrap.js:884 fabricates
      `${merchantId}-main` when a business has no defaultBranchId
      v
[7] POS provisioning on a real device
      v
[8] KASS merchant capabilities
```

---

## Fixes waiting on this

Code-complete and tested; **none runtime-verified**, all downstream of Step 1.

| Fix | Commit | Waiting on |
|---|---|---|
| Search index mismatch + missing `status` | `a5201c0` | backfill + reindex |
| 24 auth guards on a claim nothing sets | `ab1dd7e` | a real admin session |
| Bootstrap by UID, not email | `8f38864` | seed + one bootstrap call |
| POS provisioning diagnostics | `74138b7` | a real provisioning attempt |
| Activation preflight | `c8596b5` | a signed-in merchant |

---

## Security notes

- `doctor.js` is read-only. It reads no user records, lists no users, and never prints a token, key
  or secret. Its only Auth call is a `listUsers(1)` reachability probe whose result is discarded.
- Never commit a service-account key. If one is ever committed, rotate it — removing the file does
  not remove it from git history.
- Prefer Option A. A revocable user credential beats a permanent project-wide key.

---

## Honest position

Six consecutive sprints have ended at this wall: a real defect found and fixed with repository
evidence, then certification stopped for want of a live session.

**More code will not move this.** The next useful output is one `doctor.js` run showing
`BOOTSTRAP READINESS: READY`, followed by one `--dry-run`.
