# Fitness membership API: response contract

**Status:** NOT deployed. sokoni-e3 functions lane, 2026-10-03.

**Source of truth:** `scripts/fixtures/fitness-api-fixtures.json`. That file is **generated from the real handlers** by `scripts/gen-fitness-api-fixtures.js`, using the in-memory Firestore and fixtures of `scripts/test-fitness-attendance.js`. Nothing in it is hand-written. If this page and the JSON disagree, the JSON wins, and this page is a defect.

```
NODE_PATH=<functions/node_modules> NODE_OPTIONS=--require=<block-admin.js> node scripts/gen-fitness-api-fixtures.js           # regenerate
NODE_PATH=<functions/node_modules> NODE_OPTIONS=--require=<block-admin.js> node scripts/gen-fitness-api-fixtures.js --check   # exit 1 if stale
```

Related: [[FITNESS_MEMBERSHIP_ATTENDANCE]] (design, security matrix, hand-offs), [[Payments]], [[Authentication]].

---

## 0. Conventions (all callables)

- **Callable deployment.** Every function here is `onCall`, region `us-central1`, `enforceAppCheck: true`. Call it with `httpsCallable(functions, '<name>')`.
- **Timestamps.** Every timestamp is an **ISO-8601 UTC string** (`"2026-03-20T07:30:00.000Z"`) or `null`. A Firestore Timestamp is never returned.
- **Money.** Money is **integer cents** (KES × 100). A field named `…Cents` is never a float.
- **Unknown values.** An unknown value is **`null`**. It is never `0`, and it is never invented. A canonical `0` (for example, an empty attendance ledger) is a real `0`. The UI renders `null` as `—`, or as "Unlimited" where noted.
- **Errors.** Errors are `HttpsError`. In the web SDK:
  - `error.code` is `"functions/<code>"` (the fixtures carry both `httpsErrorCode` and `clientErrorCode`);
  - `error.message` is a user-safe sentence that can be shown as-is;
  - `error.details` is `{ reason }` (a machine code to branch on) or `null`.
- **Branch on `details.reason`, never on the message text.** The messages may be reworded.
- **Reason-code casing.** The casing is historical and frozen:
  - `fitnessCheckIn`, `fitnessMembershipQr`, `fitnessCompleteSession` and `fitnessCorrectAttendance` use **lower_snake** reasons.
  - `fitnessScannerStatus`, `fitnessGymMemberships`, `fitnessGymMembership` (scope refusals) and `fitnessCreateMembership`'s `SALES_DISABLED` use **UPPER_SNAKE** reasons.
  - `fitnessCreateMembership`'s offer and provider reasons are **lower_snake**.
- **Unexpected failures.** An unexpected server failure surfaces as `unavailable`, with a generic message. On the attendance callables it also carries `details.correlationId`.

---

## 1. `fitnessCreateMembership({ serviceId })`

The buyer starts a purchase from a gym's published offer. The only input is `serviceId`. The server prices the purchase.

**Server order of checks:**
1. auth
2. `serviceId` format
3. **the sales flag**
4. the offer
5. self-purchase
6. the provider
7. the single-flight transaction

### Success: `created` (new) and `reused` (a double tap within 30 min and before `payBy`)

| Field | Type | Notes |
|---|---|---|
| `membershipId` | string | `providerMemberships/{id}`; pass it to `createPaymentIntent({ purpose:'fitness_membership', membershipId })` |
| `reused` | boolean | `true` = the existing pending membership was returned, and nothing new was written |
| `priceCents` | integer | snapshot from the offer, immutable on the membership |
| `periodCount` | integer 1–60 | months |
| `periodUnit` | `"month"` | |
| `title` | string | the offer name, snapshotted |
| `payBy` | ISO string \| `null` | creation + 5 min. After it, the pricer refuses a NEW intent. `null` only if unreadable (never in practice) |

### Refusals

| `details.reason` | code | message |
|---|---|---|
| `SALES_DISABLED` | failed-precondition | Memberships aren't on sale yet. |
| — | unauthenticated | Sign in required. |
| — | invalid-argument | serviceId is required. |
| `missing` | not-found | Membership offer not found. |
| `not_membership` / `inactive` / `bad_period` / `bad_unit` / `bad_price` / `bad_price_type` | failed-precondition | `membership-offer.js` REASONS |
| `self_purchase` | failed-precondition | You cannot buy a membership at your own gym. |
| `provider_missing` / `provider_not_active` | failed-precondition | This gym isn't currently selling memberships. |
| `not_fitness` | failed-precondition | Memberships can only be bought from a fitness business. |
| — | unavailable | Could not start the membership. Please try again. |

### Sales flag (server-side; owner 2026-10-03)

- **The document.** `featureFlags/fitness_membership_sales`. Sales are open **only** when `enabled === true`, the boolean.
  - These all refuse with `SALES_DISABLED`: a missing doc, a missing field, `false`, the string `"true"`, `1`, or any other value.
  - **A read error also refuses** (fail closed, logged).
- **The UI is not the gate.** The hosting lane reads the same doc to hide the buy button; that read is only a convenience. Suite row C18 covers this check, with negative controls NC-g (check removed) and NC-h (truthy comparison).
- **Who can change it.** This was verified on this tree:
  - **Read:** the rules (`firestore.rules`, `match /featureFlags/{flagId}`) allow `read: if true` and `write: if isAdmin()`.
  - **Write from AdminOS:** `adminUpdateFeatureFlag` (`functions/admin-os.js`) is reached through `adminOsDispatch` (op `adminUpdateFeatureFlag`, `_requireSuperAdmin`). The AdminOS UI calls it from `sokoni-aos.js`.
- **Operator caveat 1.** `adminUpdateFeatureFlag` writes `enabled: enabled ?? true`. A call that **omits `enabled`** (for example, to edit only the description) **turns sales ON**. Always pass `enabled` explicitly.
- **Operator caveat 2.** The handler does not type-check `enabled`. A string `"true"` would be stored, and the server would treat it as OFF (fail closed), so the UI and the server could disagree.
- **Collection sharing.** `business-bootstrap.js` also keeps per-merchant flag docs in `featureFlags/{merchantId}`. The key `fitness_membership_sales` cannot collide with a generated merchant id in practice, but the collection is shared.

### Hand-off to sokoni-2f (defence in depth; NOT applied, their file)

> **sokoni-2f — `functions/payment-purposes.js`, purpose `fitness_membership`.** Please also refuse a NEW intent while membership sales are off, so a membership created before the flag was turned off, or a hand-crafted `membershipId`, cannot be paid.
>
> In `price(uid, data)`, insert this after the `already-exists` check and before the `payBy` check:
>
> ```js
> if (!(await require('./fitness-membership-create').salesEnabled(db())))
>   fail('failed-precondition', "Memberships aren't on sale yet.", { reason: 'SALES_DISABLED' });
> ```
>
> - `salesEnabled(db)` is exported by e3 (`functions/fitness-membership-create.js`) and takes your Firestore handle. It is the ONE reader of `featureFlags/fitness_membership_sales`: `enabled === true` only, and it fails closed on a read error.
> - Do not copy the predicate.
> - A payment already in flight (an intent minted while sales were on) is unaffected, because the webhook path does not price.
> - Suggested suite row: flag missing, `false`, `"true"` or a read error → the purpose refuses `SALES_DISABLED`; flag `true` → it prices; plus a negative control that removes the line.
> - Any suite that drives the purpose end to end needs `featureFlags/fitness_membership_sales: { enabled: true }` in its seed. e3's `scripts/test-fitness-membership-create.js` (C12/C13 call your pricer) already seeds it on this branch, so it will keep passing once you add the line.

---

## 2. `fitnessMembershipQr({ membershipId })`: buyer only

| Field | Type | Notes |
|---|---|---|
| `token` | string | `fm1.<b64url payload>.<hmac hex>`. **Opaque**: render it as a QR and never parse it. The payload holds ids and times only |
| `expiresAt` | ISO string | 5 min after minting |
| `ttlSeconds` | integer | `300`. Refresh before expiry |

**Refusals:**
- `unauthenticated`
- `invalid-argument` (bad id)
- `not_found` (not-found). Also returned for someone else's membership, so a caller never learns that it exists.
- `expired`, `cancelled`, `suspended`, `not_covered`, `entitlement_exhausted` (failed-precondition): the membership cannot be used right now.

---

## 3. `fitnessCheckIn({ token, sessionRef? })`: gym owner or `attendance` staff

`sessionRef` is optional and must match `[A-Za-z0-9_-]{1,64}`. Without it, one check-in per member per **Africa/Nairobi day** is allowed (`attendanceId = d_YYYY-MM-DD`). With it, one check-in per named session (`s_<sessionRef>`).

### Success AND duplicate: the SAME key set (suite row A22 asserts the exact keys; negative control NC-i)

| Field | Type | Notes |
|---|---|---|
| `ok` | `true` | |
| `correlationId` | string | for support and audit (`adminAudit`) |
| `duplicate` | boolean | `true` = this attendance already existed. **Nothing was written**: the existing result is returned unchanged, and no notification is sent |
| `firstCheckIn` | boolean | `true` only for the very first check-in on this membership. The membership is then **no longer refundable**. Always `false` on a duplicate |
| `membershipId` | string | |
| `attendanceId` | string | `d_YYYY-MM-DD` or `s_<sessionRef>` |
| `status` | string | the ledger row's status: `checked_in` on a new scan; on a duplicate, whatever the row holds now (`checked_in` \| `completed` \| `voided_by_admin`) |
| `attendedSessions` | integer ≥ 1 | the membership's count **after** this check-in. On a duplicate it is the current count, which is unchanged by the duplicate |
| `sessionsIncluded` | positive integer \| `null` | the cap; `null` = **Unlimited** |
| `checkedInAt` | ISO string \| `null` | new scan: the server time of this check-in. Duplicate: the original row's time. `null` only if that row's time is unreadable |
| `title` | string \| `null` | the plan title (snapshot) |
| `member.displayName` | string \| `null` | sanitised, max 60 chars. Never the uid, phone or email. `null` = no name on file |

**Sessions used.** The UI's "Session N of M" is `attendedSessions − voidedSessions`. `voidedSessions` is not in this response, so use `attendedSessions` and `sessionsIncluded` as given. The gym detail view (§6) has the corrected `remaining`.

### Refusals (`details.reason` → code → message)

| reason | code | message |
|---|---|---|
| — | unauthenticated | Sign in required. |
| — (bad `sessionRef`) | invalid-argument | sessionRef is invalid. |
| `token_invalid` | invalid-argument | This QR code is not valid. Ask the member to refresh it in their app. |
| `token_expired` | deadline-exceeded | This QR code has expired. Ask the member to refresh it in their app. |
| `not_found` | not-found | Membership not found. |
| `no_permission` | permission-denied | You don't have permission to record attendance for this gym. |
| `other_gym` | permission-denied | This membership is not for your gym. |
| `self_scan` | permission-denied | You cannot check yourself in. |
| `wrong_member` | failed-precondition | This QR code does not belong to this membership holder. |
| `expired` | failed-precondition | This membership has expired. |
| `cancelled` | failed-precondition | This membership has been cancelled. |
| `suspended` | failed-precondition | This membership is suspended. |
| `not_covered` | failed-precondition | This membership does not cover a session right now. (unpaid, pending, refund requested/refunded, disputed, before start) |
| `entitlement_exhausted` | failed-precondition | All sessions on this membership have been used. |
| `business_link_missing` | failed-precondition | Staff attendance isn't set up for this gym yet. Ask the gym owner to scan. (told only to staff who hold `attendance` at a business this gym's owner owns) |
| `not_approved` | failed-precondition | This gym isn't approved to record attendance right now. |
| `module_unavailable` | failed-precondition | Memberships aren't enabled for this business. |
| — (`details.correlationId`) | unavailable | Attendance could not be recorded. Please try again. |

---

## 4. `fitnessCompleteSession({ membershipId, attendanceId })`: gym owner or `attendance` staff

**Success and duplicate:**
`{ ok:true, correlationId:string, attendanceId:string, duplicate:boolean, status:'completed' }`

**Refusals:**
- `invalid-argument`: ids malformed.
- `not-found`: either "Membership not found." (`not_found`) or "Attendance record not found." (no reason).
- `failed-precondition` `not_checked_in`: the row was voided.
- Every scanner refusal from §3: `no_permission`, `other_gym`, `not_approved`, `module_unavailable`, `business_link_missing`.

No money and no refund effect.

## 5. `fitnessCorrectAttendance({ membershipId, attendanceId, reason })`: AdminOS admin only

**Success and duplicate:**
`{ ok:true, correlationId, attendanceId, refundLockUnchanged:true, duplicate:boolean, status:'voided_by_admin' }`

**Refusals:**
- `no_permission` (permission-denied): the caller is not an admin.
- `invalid-argument`: "A correction reason is required." (fewer than 3 chars).
- `not-found`.

---

## 6. Gym reads: scope refusals (`fitnessGymMemberships`, `fitnessGymMembership`)

The gym is resolved from the caller: owner → own gym; staff → the ONE gym where they hold `attendance`. `providerId` and `businessId` in the request are **ignored**.

| `details.reason` | code | message |
|---|---|---|
| `NO_PERMISSION` | permission-denied | You don't have permission to view this gym's memberships. |
| `NOT_APPROVED` | failed-precondition | This gym isn't approved to manage memberships right now. |
| `BUSINESS_LINK_MISSING` | failed-precondition | Staff access isn't set up for this gym yet. |
| `MODULE_NOT_AVAILABLE` | failed-precondition | Memberships aren't enabled for this business. |
| `MULTIPLE_GYMS` | failed-precondition | You are staff at more than one gym. Ask the gym owner for access to this view. |

### `fitnessGymMemberships({ status?, limit?, cursor? })` → `{ rows: Row[], nextCursor: string|null }`

**Request fields:**
- `status`: one of `active` · `pending` (= `pending_payment`) · `expired` · `refund` (= `refund_requested` + `refunded`) · `all` (default).
- `limit`: 1–50, default 20.
- `cursor`: the previous response's `nextCursor`.

**Ordering:** newest first (`createdAt desc`). `nextCursor` is `null` on the last page.

**Refusals:**
- `invalid-argument` for an unknown status, a bad limit, or a bad or foreign cursor;
- the scope refusals above.

**Row** (also `membership` in §6.2):

| Field | Type | Null semantics |
|---|---|---|
| `membershipId` | string | |
| `member.displayName` | string \| null | null = no name on file. No uid, phone or email |
| `title` | string \| null | |
| `periodCount` | integer \| null | |
| `periodUnit` | string \| null | `"month"` |
| `startAt` | ISO \| null | **null until paid**: before payment the start is only requested |
| `endsAt` | ISO \| null | null until paid (`membership-settlement.endsAt`) |
| `sessionsIncluded` | positive integer \| null | null = Unlimited |
| `attendedSessions` | integer \| null | a canonical `0` when the ledger is empty by construction; **null = inconsistent/unknown** (never shown as 0) |
| `remaining` | integer \| null | `sessionsIncluded − (attendedSessions − voidedSessions)`, floored at 0; null when Unlimited or unknown |
| `lastAttendedAt` | ISO \| null | |
| `status` | string \| null | `pending_payment` · `active` · `expired` · `cancelled` · `suspended` · `refund_requested` · `refunded` · … |
| `paymentStatus` | string \| null | `pending` · `paid_held` · `partially_released` · `released` · … |
| `refundState` | string \| null | `refund.state` when a refund exists |
| `refundEligible` | boolean \| null | `false` once used (never set back). `true` only for a **paid** membership with an empty ledger. `null` when unpaid or unknown (there is nothing to refund) |
| `releasedPeriods` | integer \| null | 2f's settlement counter; null before payment |
| `releasedCents` | integer \| null | 2f's settlement counter (gross released); null before payment |

### `fitnessGymMembership({ membershipId })` → `{ membership, attendance, attendanceTruncated, settlement }`

- **`membership`**: a Row, as above.
- **`attendance`**: `[{ attendanceId, checkedInAt: ISO|null, status, method: 'qr'|null, actorRole: 'owner'|'staff'|null, sessionRef: string|null, completedAt: ISO|null }]`.
  - Newest first, at most 100 rows.
  - No actor or member uids.
- **`attendanceTruncated`**: boolean. `true` when 100 rows were returned (more may exist).
- **`settlement`** is an **OBJECT**, not an array:
  ```
  { releases: [{ periodIndex: int|null, grossCents: int|null, commissionCents: int|null, netCents: int|null,
                 status: string|null, settledAt: ISO|null }],      // providerPayouts sourceType 'membership', THIS gym, sorted by periodIndex
    releasedPeriods: int|null,     // from the membership doc
    releasedCents:   int|null,     // from the membership doc (gross)
    netSettledCents: int|null }    // Σ releases[].netCents; null when there are no releases or any netCents is unknown
  ```
- **Refusals:**
  - `invalid-argument`: bad id;
  - `not_found` (not-found): another gym's membership is indistinguishable from a missing one;
  - the scope refusals.

---

## 7. `fitnessScannerStatus()` → never throws for authorization (only `unauthenticated`)

| Case | Response |
|---|---|
| owner of an approved gym | `{ canScan:true, role:'owner' }` |
| staff with `attendance` at exactly one linked gym | `{ canScan:true, role:'staff' }` |
| no gym, or staff without `attendance` | `{ canScan:false, role:null, reason:'NO_PERMISSION' }` |
| staff whose gym has no canonical business link | `{ canScan:false, role:null, reason:'BUSINESS_LINK_MISSING' }` |
| staff at two or more gyms | `{ canScan:false, role:null, reason:'MULTIPLE_GYMS' }` |
| gym not approved, or suspended | `{ canScan:false, role:'owner'\|'staff', reason:'NOT_APPROVED' }` |
| `memberships` module closed (once sokoni-5b ships the key) | `{ canScan:false, role:'owner'\|'staff', reason:'MODULE_NOT_AVAILABLE' }` |

The `reason` key is **absent** when `canScan` is `true`.

---

## 8. Fixture index (`scripts/fixtures/fitness-api-fixtures.json`)

| Key | Contents |
|---|---|
| `fitnessCreateMembership` | `created`, `reused`, `errors.{SALES_DISABLED, unauthenticated, invalid_serviceId, missing, self_purchase, provider_not_active, not_fitness, not_membership, inactive}` |
| `fitnessMembershipQr` | `success`, `errors.{not_found, not_covered, expired}` |
| `fitnessCheckIn` | `success_first`, `duplicate`, `success_staff_named_session`, `success_unlimited`, and `errors` for every reason in §3, plus `unauthenticated`, `invalid_sessionRef` and `unavailable` |
| `fitnessCompleteSession` | `success`, `duplicate`, `errors.{invalid_ids, attendance_not_found, other_gym, not_checked_in}` |
| `fitnessCorrectAttendance` | `success`, `duplicate`, `errors.{no_permission, reason_required}` |
| `fitnessGymMemberships` | `success_all` (capped / unlimited / pending / unknown rows), `success_page1_limit2`, `success_page2`, `success_tab_pending`, `errors` |
| `fitnessGymMembership` | `success` (2 releases → `netSettledCents` 380000), `success_no_payouts`, `errors` |
| `fitnessScannerStatus` | `owner`, `staff`, `NO_PERMISSION`, `NO_PERMISSION_stranger`, `BUSINESS_LINK_MISSING`, `NOT_APPROVED`, `NOT_APPROVED_staff`, `MODULE_NOT_AVAILABLE`, `MULTIPLE_GYMS`, `unauthenticated` |

**Generation details:**
- All fixtures use the fixed instant `2026-03-20T07:30:00.000Z`.
- `correlationId` values are deterministic test ids.
- Each error fixture is `{ httpsErrorCode, clientErrorCode, message, details }`.
