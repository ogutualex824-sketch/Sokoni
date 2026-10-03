# HOTFIX DE-2 — commerceDispatch stops serving the retired digital-download ops

**Status: BUILT + CERTIFIED (hermetic), NOT DEPLOYED.** Branch `hotfix/commerce-dispatch-retire-digital-ops`.
Owner of the file for this hotfix: sokoni-e3. Evidence: DE-0 census (2026-10-03, read-only).
Related: [[Payments]] · [[Marketplace]] · [[Security]]

## Why

DE-0 found two ops LIVE through `commerceDispatch` (revision `commercedispatch-00009-tub`):

| op | what it does live | defect |
|---|---|---|
| `digitalProductPurchase` (marketplace-extensions.js:540-582) | writes `digitalPurchases/{id}` + licence key, increments `salesCount` | **no payment of any kind**; any signed-in caller with App Check gets a licence; also fabricates seller revenue in `digitalProductGetSales` |
| `digitalProductDownload` (:584-611) | signs a 15-min Storage read URL for a purchase | no paid/status check, so it releases the file for an unpaid purchase |

**Owner decision 2026-10-03:** the digital-downloads store is RETIRED. Its pages are paused, its data is kept, and its server code stays dormant.

## The change (one hunk)

`functions/commerce-dispatch.js`, directly after `const _H = _merge(...)`:

```js
const _RETIRED_OPS = ['digitalProductPurchase', 'digitalProductDownload'];
for (const op of _RETIRED_OPS) delete _H[op];
```

Both ops now fall through to the dispatcher's existing unknown-op path: `HttpsError('not-found', 'Unknown commerce operation: …')`.

- The handlers stay defined (dormant) in `marketplace-extensions.js`.
- No other file references them. `index.js` does **not** re-export the module's standalone `onCall`s, so they are not deployable either.
- All other 56 ops are unchanged.

## Lineage: the tree IS the serving archive

No repo ref matches the serving source (archive `gs://gcf-v2-sources-24799054989-us-central1/commerceDispatch/function-source.zip#1787386112495406`, 379 files excluding node_modules):

| candidate base | functions files differing | repo files absent from archive |
|---|---|---|
| `72dca56` (live hosting) | 13 (application-lifecycle, business-bootstrap, commission, device-manager, **index**, legal-agreements, order-settlement, payment-purposes, platform-health, pos-staff-ops, pos-zero-friction, sub-billing, subscription-os) | 5 (pos-commission-collection, pos-mpesa-refs, print-intents, shop-access, tenant-identity) |
| `origin/main` 2ba4cee | 130 | 7 |
| `6326cd3` (last touch of the 4 dispatch files) | 138 | 0 |
| `8e6bb0f` (last touch of marketplace-extensions) | 262 | 1 |
| 80 commits 2026-09-07 … 09-09 12:00 +03 (function updateTime 2026-09-09T06:01:50Z) | best 15 (`9e5609e`) | — |

A deploy from any of these would silently swap modules that the runtime loads, because the container loads all of `index.js`. So the branch is built as follows:

1. `669e5ba`: base 72dca56. `functions/` is overwritten byte-for-byte with the archive, and the 5 extra files are removed. Proof by `git hash-object`: **379/379 identical, 0 extra**.
2. Fix commit: the hunk above, plus non-functions files only:
   - `firebase.json`: the functions block only. Predeploy hooks use the relative `node scripts/X.js` form, because the quoted `$RESOURCE_DIR` form never runs on this machine. `functions.ignore` is added.
   - `scripts/infra/env-parity-check.js`: copied verbatim from `7091029` (blob `1c645f4f…`).
   - `scripts/test-commerce-dispatch-retired-digital.js`, this doc, and CHANGELOG.

   `git diff 669e5ba..<fix> -- functions/` is exactly the one hunk in `commerce-dispatch.js`.

### `.env`

The serving archive **contains** `functions/.env`, and it is byte-identical to the one tracked at 72dca56.

- All 5 names (ALGOLIA_APP_ID, TYPESENSE_NODES, ETIMS_ENV, AT_ENV, AT_SENDER_ID) **match** the live revision's env, compared by SHA-256 prefix. No value was printed.
- The file stays PRESENT and tracked, unmodified, so params resolve. Deleting it was the 2026-09-30 failure: AT_ENV fell back to `sandbox`.
- It is now listed in `functions.ignore`. The new source zip will therefore lack `.env`, which the serving one has. That is intended: values reach the service as env vars at deploy, not from the zip.
- Do **not** copy the main checkout's `functions/.env` over it. The main checkout's copy is locally modified. The tracked copy is the one proven to match live.

`functions.ignore` replaces firebase-tools' defaults, so the defaults are restated: `node_modules`, `.git`, `firebase-debug.log`, `firebase-debug.*.log`, `*.local`, plus `.env` and `.env.*`. The archive contains none of these except `.env`. The upload set is therefore the archive minus `.env`, with `commerce-dispatch.js` changed.

## Certification (hermetic, no network, no Firestore)

`scripts/test-commerce-dispatch-retired-digital.js` stubs firebase-admin and firebase-functions. Every db/storage access is a tripwire. Run with the `block-admin.js` preload.

```
node scripts/test-commerce-dispatch-retired-digital.js --live=<archive dir>
```

- R1: the map lacks both ops.
- R2: each op returns `not-found` "Unknown commerce operation" with 0 db/storage touches.
- R3 CONTROL: live op set (58, parsed from the archive dispatcher's own unknown-op message) minus the two equals the target set (56).
- R4: digitalProductCreate, GetMyLibrary and GetSales are still routed.
- **Result: 12/12.**
- **Negative control** (`--target=<archive>`): 7 FAIL. R1×2 fail. R2×4 fail: the unmodified handler reached `db.collection` and the dispatcher returned `internal`. R3 fails with `added=digitalProductDownload,digitalProductPurchase`.
- `node --check` passes on both edited JS files.

## BLOCKER: the functions safety guard refuses this tree

`scripts/deploy/guard-functions-safety.js` is the first functions predeploy hook. It was run locally against this tree, which is the serving archive and therefore the 2026-09-09 commerceDispatch lineage. Result: **FAILED, 11 protections missing.**

| protection the guard expects |
|---|
| `_normalizeMsisdn` must be defined exactly once |
| all three STK sites must use the canonical normaliser |
| the seller-phone ownership check is fail-closed |
| darajaSTKPush refuses a malformed number |
| darajaSTKPush allows a valid number |
| ownership check fails closed with no stored phone |
| ownership check allows the registered phone |
| the sandbox callback lane allowlist exists |
| the financial engine is gated on `!_isSandbox` |
| `isTest` is propagated to sellerPayments |
| `checkoutId` is validated before `.doc()` |

The same guard **PASSES** on plain `72dca56`.

None of these code paths is reachable through commerceDispatch. Its static require graph is commerce-dispatch, marketplace-extensions, merchant-success, marketing-engine and minishop-config-schema. The guard is tree-wide, though, and must not be bypassed. **This tree cannot be deployed as-is.** The owner must choose:

- **A. Archive tree (this branch).** The upload equals what serves today, except for the one hunk. It needs an explicit, owner-recorded exception to the tree-wide guard for a scoped `--only functions:commerceDispatch` deploy. That means removing the hook in a dedicated deploy config, which the repo rules forbid without authority.
- **B. `hotfix/commerce-dispatch-retire-digital-ops-on-72dca56`.** Same hunk on 72dca56, and the guard passes.
  - The five files in commerceDispatch's require graph are byte-identical to serving.
  - But the container loads the whole `index.js`. The upload therefore swaps 13 modules that are loaded but unreachable from this function: application-lifecycle, business-bootstrap, commission, device-manager, index, legal-agreements, order-settlement, payment-purposes, platform-health, pos-staff-ops, pos-zero-friction, sub-billing, subscription-os.
  - It also adds 5 modules: pos-commission-collection, pos-mpesa-refs, print-intents, shop-access, tenant-identity.
  - Risk: load-time side effects and deploy-time params of those modules, inside the commerceDispatch container only. Other functions are not redeployed by a scoped deploy.

## Deploy (operator; owner-authorised only, after the blocker above is resolved)

Prerequisites:

1. Re-read the AR notice in CLAUDE.md. Make sure no other deploy is running.
2. Use the tree at `C:/temp/sok-cd-hotfix` at the branch tip. Check `git status` is clean.
3. Install deps: `cd functions && npm ci`. node_modules is ignored, and the build installs from package.json and package-lock, which are identical to serving.
4. Confirm `functions/.env` is present: `test -f functions/.env`. Never print it.
5. Record the rollback target: `commercedispatch-00009-tub`.

```
npx firebase deploy --only functions:commerceDispatch --project sokoni-aeb26 --non-interactive
```

Scoped deploy only. The tree still exports functions that were deleted live (Daraja, 2026-10-03). An unscoped deploy would recreate them.

**Acceptance** comes from the deploy log, not the exit code:

- the guard banner "Functions safety guard — payment-path protections" appears;
- the syntax-gate summary appears;
- each other gate prints its own output.

"Finished running predeploy script" with no gate output means the gates did NOT run. Stop.

After the deploy:

1. `gcloud run services describe commercedispatch --region us-central1 --project sokoni-aeb26 --format=json`. Read `status.traffic`: exactly one revision at 100%, the new one, Ready.
2. `node scripts/infra/env-parity-check.js commercedispatch=commercedispatch-00009-tub`. Names and value hashes must match.
   - Secret refs are generated names (`secret-…`). If only a secret *reference name* differs while the secret names in `_OPTS` are unchanged, record that and do not roll back on it alone.
3. **Live verification without calling the function:**
   - Download the new revision's `build-source-location` archive.
   - Unzip it. `git hash-object` every file against this branch's `functions/`.
   - Expect 0 differences, with `.env` absent.
   - Run `node scripts/test-commerce-dispatch-retired-digital.js --target=<new archive> --live=<old archive>`. Expect 12/12.
   - Never invoke `commerceDispatch` to test.

**Rollback:** pin traffic **by name** to the known-good revision, and confirm Ready first:

```
gcloud run services update-traffic commercedispatch --region us-central1 --project sokoni-aeb26 --to-revisions=commercedispatch-00009-tub=100
```

Do not use `gcloud run services update`; it fails and leaves an undeletable revision.

AR note: the new image falls under `firebase-functions-cleanup` plus `sokoni-recovery-protection` (KEEP 10). 00009-tub's own image may already be gone. If it is, a rollback to it can still route traffic, because the revision exists. It cannot create a new revision from it.

## Follow-ups (not in this hotfix)

1. **Owner-authorised, read-only:** count `digitalPurchases` rows (and any active `digitalProducts`). Every row was minted without payment, because the purchase doc has no payment field at all. Decide licence revocation and `salesCount` correction. No reads were made here.
2. If the store is ever revived, the purchase must go through a payment flow:
   - the purchase writes `pending_payment` plus a server-priced IntaSend intent (`payment-purposes.js` already has a digitalProducts purpose);
   - a `crypto.randomBytes` licence and `status:'paid'` are written only by the verified webhook;
   - Download refuses unless `status === 'paid'`, and signs the URL outside the transaction;
   - the duplicate guard uses a deterministic id plus `create()`.
3. Other ops in the same map (separate findings, untouched here):
   - `recordFlashSalePurchase`: any user can exhaust a merchant's flash sale.
   - `createFlashSale`: client-supplied merchantId (F-1).
   - `rentalBook`: unpaid pending booking, by design.
   - `applyCouponCode`: read-only.
   - `updateAcademyProgress`: self-awarded XP.
   - `auctionBid`.
