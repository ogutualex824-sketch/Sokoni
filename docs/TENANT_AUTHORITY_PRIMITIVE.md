# Merchant authority primitive — what landed, and what is still open

**Branch:** `fix/tenant-merchant-authority` (cut from production functions lineage `de20ba1`)
**Status:** implemented, gated, **NOT DEPLOYED**. Authorization to fix is not authorization to deploy.

Related: [[project-tenant-boundary-merchantid]] · [[project-users-merchantid-forgeable]] ·
[[POS Integrity]] · [[Employee Auth Slice]]

---

## The defect was a missing primitive

Callables took a caller-supplied `merchantId` and used it to select or mutate tenant data.
Three *correct* implementations already existed, each against a **different** authority —
`shops.ownerUid` (sfos-engine), `merchants.ownerId` (crm), `businesses.ownerId` (`ownsBiz`,
rules). With no shared helper, every author invented one and several forgot entirely.

`functions/merchant-authority.js` is now the single answer. Canonical authority
**`businesses/{merchantId}.ownerId`**. It defaults to the caller, bypasses only on
**unforgeable token claims**, verifies against the authoritative document, and **denies when
that document is missing**.

Independent corroboration of the authority choice: `_assertRefundAuthority` in
`pos-zero-friction.js` — the safest POS check in the repo, written separately — resolves against
`businesses.ownerId` too.

### Bound in this change

| module | callables | was |
|---|---|---|
| `pos-peripherals.js` | 3 | trusted `users/{uid}.merchantId` — **a field the user can write** |
| `pos-zero-friction.js` | `posGetQueueMetrics` | **no binding** — `_assertAuth` only proves a uid exists |
| `business-health-score.js` | 3 | **no binding** |
| `crm.js` | — | fail-open corrected (below); keeps its own working authority |

### The `crm.js` fail-open

```js
if (data.ownerId !== uid && data.adminUids && !data.adminUids.includes(uid)) throw;
```

With `adminUids` **absent**, the middle conjunct is `undefined`, the condition is `false`, and a
**non-owner was granted**. Latent only because every existing merchant happens to carry the
field — a data accident, not a guard. Now an explicit
`Array.isArray(x) && x.includes(uid)` test.

### Left alone deliberately

`sfos-engine.js` and `self-heal.js` are already safe. Changing working authorization to route
through a new helper buys nothing and risks a regression.

---

## Blast radius of what landed

Measured against a control (`posCompleteCheckout`, ~15 real client callers):

* the five peripheral callables have **zero** client callers in the tree — docs and manifests only
* `getBusinessHealthScore` / `getHealthScoreHistory` are called by `business-health.html` and
  `commerce-os.html` — owner-facing dashboards, where an owner/adminUids binding is the right one

So the owner-only binding does not narrow any live operator path.

---

## STILL OPEN — do not assume this closed the boundary

### 1. `pos-zero-friction` financial callables are unbound

`posCompleteCheckout`, `posValidateCoupon`, `posLookupCustomer`, `posLogReprint`,
`posCheckPaymentStatus` all take a caller-supplied `merchantId` behind `_assertAuth`, which only
proves a uid exists. `posProcessRefund` is the exception — it uses `_assertRefundAuthority`.

**These were NOT bound here, deliberately.** They run on **cashier devices**, and a cashier is
not an owner. Binding them owner-only would deny every legitimate checkout. The correct guard is
the staff-aware shape `_assertRefundAuthority` already uses: `businesses.ownerId` **OR** an
active `posStaff` membership.

**Blocked on a fact I could not establish:** whether `posStaff` is client-writable. It is absent
from `firestore.rules`, and the served ruleset could not be fetched (`gcloud` token unavailable
in this environment). If `posStaff` is self-mintable — as `shopEmployees` is known to be — then
adding that path would **reopen the hole this change just closed**. Resolve that before binding
the financial path.

### 2. Two more unbound peripheral callables

* `posUpdatePeripheralStatus` — caller `merchantId`, only `requireAuth`; writes status/health into
  **any** merchant's peripheral document
* `posCreateCustomerDisplay` — `requirePosAccess` is a **role** check, not a tenant binding; writes
  `posCustomerDisplays/{sessionId}` with `merge:false` on a caller-supplied `sessionId`, so it can
  overwrite another tenant's display session

Both were found by a post-fix sweep of *every* export, not by the original audit, which had
undercounted. No client callers, so no urgency — but they are the same defect class.

### 3. `procurement.js`

Eight sites behind `_requireManager` — a **role** claim with no merchant binding. Unchanged here.

---

## Verification

`scripts/test-merchant-authority.js` — **26 passed, 0 failed**. The suite **executes** the
primitive against fixtures rather than matching source: earlier in this workstream a regex
assertion passed with the guard condition replaced by `false`, because it only proved a throw was
nearby.

Covered: missing document denies · a document with no `ownerId` denies · absent `adminUids` does
not grant · a non-array `adminUids` cannot grant · a truthy-but-not-`true` admin claim does not
bypass · self-access needs no lookup · an id containing `/` is refused.

**Proved by sabotage — 7 applied, 7 caught, 0 broken probes.** A sabotage that fails to *apply*
is a broken probe, never a pass; that distinction produced two false greens earlier in this
workstream.

| sabotage | result |
|---|---|
| missing doc becomes allow | exit 1, 1 failure |
| reintroduce the `adminUids` fail-open | exit 1, 5 failures |
| accept a truthy admin claim | exit 1, 1 failure |
| drop document-id validation | exit 1, 2 failures |
| remove a `pos-peripherals` binding | exit 1, 1 failure |
| remove the `pos-zero-friction` binding | exit 1, 1 failure |
| revert `crm` to the fail-open conjunct | exit 1, 2 failures |

Baseline and restored both 0 failures.

Gates: `npm run predeploy` exit 0 (93/0) · index governance exit 0 (406 declared, 0 stale).

---

## Also in this change: a separate defect

The `posCheckoutMetrics (branchId, merchantId, saleDate)` composite index was **never declared and
never existed**, so `posGetQueueMetrics` failed `9 FAILED_PRECONDITION` for **every** caller while
`pos-zero-friction.js:812` kept writing that collection. Found while attempting the isolation
test; unrelated to authorization. Declared here, **not deployed**.

---

## Deployment

Nothing was deployed. Cloud Run `run.invoker` for the health-score callables is deliberately
**not** changed — granting `allUsers` to a function *before* its authorization lands is the wrong
order.

The before/after gate is `docs/TENANT_ISOLATION_BASELINE_SNIPPET.md`, unchanged: after this
deploys, every OTHER-TENANT line must read `DENIED permission-denied` and every OWN line must stay
`ALLOWED`.
