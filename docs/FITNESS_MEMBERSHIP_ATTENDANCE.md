# Fitness membership attendance — QR check-in ledger

**Status:** BUILT on `feat/fitness-attendance-on-8bbfb34` (based on commercial-fn `57fe896`; merged 2f `df88d4b`). **NOT deployed.**
**Owner rules:** 2026-10-03, "server-authoritative attendance ledger" and OWNER POLICY #2 (QR check-in).
**Modules:** `functions/fitness-attendance.js` · `functions/fitness-gym-memberships.js` (§11) · `functions/fitness-membership-create.js` · `functions/shared/membership-offer.js` (§10) · `functions/workforce-identity.js` (`attendance` key, §6).
**Tests:** `scripts/test-fitness-attendance.js` · `scripts/test-fitness-membership-create.js`.
**API contract (exact response shapes):** [[FITNESS_MEMBERSHIP_API]] · fixtures `scripts/fixtures/fitness-api-fixtures.json`, generated from the real handlers by `scripts/gen-fitness-api-fixtures.js`.
**Related:** [[COMMERCIAL_CONVERGENCE_2026-09-30]] §13 / §13.1 (membership money, sokoni-2f) · [[Payments]] · [[Events]] (credential signing) · [[Authentication]]

---

## 1. Why

The owner's rules for this ledger:

- **Usage is proven by the server.** "The membership system should have a server-authoritative attendance ledger so the gym can prove whether a member actually used the membership, and refunds can be determined from that record … Do not make attendance a browser checkbox."
- **One session ends refundability.**
  - Zero attended sessions → the membership may be refundable (2f's refund authority).
  - **One valid check-in → NON-REFUNDABLE.** This happens server-side, immediately and irreversibly.
  - Nobody (customer, browser, staff or provider) may reset attendance to regain refund eligibility.
- **A check-in is not a payment.** It IDENTIFIES and AUTHORIZES attendance; it is not PAYMENT PROOF. It only unlocks 2f's release of money that a verified webhook already holds.

## 2. Four separate state machines

`PAID ≠ CHECKED-IN ≠ COMPLETED ≠ SETTLED`

| Machine | Owner | States | Writer |
|---|---|---|---|
| Membership / payment | sokoni-2f | `pending_payment` → `active` (paid_held) → `refund_requested` → `refunded` / back to `active`; `payment_review`; plus `expired`, `cancelled`, `suspended` | webhook `holdMembershipPayment`, `membership-settlement.js` |
| Attendance (check-in) | **this module** | none → `checked_in` | `fitnessCheckIn` |
| Session completion | **this module** | `checked_in` → `completed` | `fitnessCompleteSession` |
| Correction | **this module** (admin) | `checked_in` / `completed` → `voided_by_admin` | `fitnessCorrectAttendance` |
| Settlement | sokoni-2f | releases/{index}, `partially_released` → `released` | `releaseDueSlices`, `membershipReleaseSweep` |

**Check-in vs completion.**
- **Check-in counts.** Per the contract, the first valid CHECK-IN locks refunds, not the first completion.
- **Completion** is a separate fact on the ledger row. It does not touch the membership, the refund lock or money.

## 3. Data

### `providerMemberships/{membershipId}`: fields written ONLY by this module

| Field | Meaning |
|---|---|
| `attendedSessions` | Integer ≥ 0, incremented per new check-in. **Never decreases**, even after an admin correction. |
| `firstAttendedAt` | Server timestamp, set once on the first check-in. |
| `refundEligible` | `false` from the first check-in. Never set back. If a later check-in finds it not `false`, it heals it to `false`. |
| `lastAttendedAt` | Server timestamp of the latest check-in. |
| `voidedSessions` | Integer ≥ 0, incremented by admin corrections. Restores **entitlement only** (`used = attendedSessions − voidedSessions` against a session cap). **Never** restores refund eligibility. |

Read only (2f's or creation fields):
- `providerId`, `buyerUid`, `status`, `paymentStatus`, `startAt`, `periodCount`, `periodUnit`
- `sessionsIncluded`: an optional session cap. Absent means unlimited within the period.

### `providerMemberships/{id}/attendance/{attId}`: the append-only ledger

- **Document id:** `d_<YYYY-MM-DD Africa/Nairobi>`, or `s_<sessionRef>` when the scanner names a session. This is the idempotency key, created with `create()` semantics.
- **Fields:**
  - `{ membershipId, memberUid, providerId, sessionRef, checkedInAt (server), method:'qr', actorUid, actorRole, status:'checked_in', completedAt:null, correlationId }`
  - completion adds `completedAt`, `completedBy`, `completedByRole`;
  - a correction adds `voidedAt`, `voidedBy`, `voidReason`.

### `providerMemberships/{id}/attendanceCorrections/{attId}`

One correction record per row: `{ previousStatus, status:'voided_by_admin', reason, actorUid, actorRole:'admin', correctedAt, correlationId, note }`. Nothing is ever deleted.

### Audit: `adminAudit` (the AdminOS log; rules: admin read, write false)

- **Actions:** `fitness_checkin`, `fitness_checkin_duplicate`, `fitness_session_completed` and `fitness_attendance_corrected`. Each has `outcome: ok | refused` plus `reason`.
- **Every row carries:** `performedBy`, `actorRole`, `membershipId`, `attendanceId`, `providerId`, `correlationId`, `hub:'fitness'`.
- **Never stored:** member PII or the token.
- **Failure handling:** an audit failure is logged and never fails the operation.

## 4. Callables (us-central1; NOT deployed)

### `fitnessMembershipQr({ membershipId })`

- **Who:** the buyer only (`auth.uid === buyerUid`). Any other caller gets `not_found`, so another person's membership is never confirmed.
- **Refusal:** the same reasons as check-in when the membership is not checkable (for example, not `active`).
- **Returns:** `{ token, expiresAt, ttlSeconds: 300 }`.
- **Token:** `fm1.<base64url(JSON{m,b,p,iat,exp})>.<hex HMAC>`. It carries ids and times only (no name, phone or email).

### `fitnessCheckIn({ token, sessionRef? })`: server order of checks

1. Signature, then expiry. Forged or modified → `token_invalid`; expired → `token_expired`.
2. Membership exists.
3. **Scanner authorization:**
   - the scanner must be the gym owner (`uid === providerId`);
   - if not, the staff seam is tried; it is BLOCKED (§6);
   - otherwise the result is `other_gym` (the caller is a provider) or `no_permission`;
   - an owner checking in their own membership → `self_scan`.
4. Token gym equals the record's gym (`other_gym`) and token member equals the record's member (`wrong_member`).
5. **Transaction, reads before writes:**
   - re-read the membership and the attendance doc;
   - an existing attendance doc → **return the existing result unchanged** (`duplicate: true`).
6. **Inside the transaction, on the fresh record:**
   - `status === 'active'`, otherwise:
     - `expired`, `cancelled` or `suspended` by name;
     - `pending_payment`, `payment_review`, `refund_requested`, `refunded` or `disputed` → `not_covered`;
   - `paymentStatus ∈ {paid_held, partially_released, released}` (defence in depth);
   - the period window `startAt ≤ now < membership-settlement.endsAt(m)`;
   - the session cap, if any.
7. **Writes:**
   - `create()` the ledger row;
   - `attendedSessions + 1`;
   - on the first check-in, `firstAttendedAt` and `refundEligible: false` in the same commit.
8. After the commit, on the first check-in only: `membership-settlement.releaseDueSlices(id)` inside try/catch. A failure is logged and the 06:00 `membershipReleaseSweep` is the fallback.

**Client input.** Only `token` and `sessionRef` (`[A-Za-z0-9_-]{1,64}`) are read. Everything else the client sends is ignored, including `attendedSessions`, `refundEligible`, timestamps, ownership and status.

**Race.** Because step 6 runs on the transaction's own read, a refund request that commits mid-check-in forces a re-run and a refusal. A check-in that commits mid-refund-request makes 2f's refund re-run and refuse `used`. Test A21 proves both orders.

### `fitnessCompleteSession({ membershipId, attendanceId })`

- **Who:** the same scanner authorization as check-in.
- **Effect:** `checked_in → completed`.
- **Idempotent:** completing an already-completed row returns it unchanged.
- **Refusals:** a voided row → `not_checked_in`.

### `fitnessCorrectAttendance({ membershipId, attendanceId, reason })`

- **Who:** ADMIN only, using the AdminOS predicate `token.admin === true || token.superAdmin === true`.
- **Effect:**
  - voids the row;
  - writes the correction record;
  - `voidedSessions + 1`.
- **Never** changes `refundEligible`, `firstAttendedAt` or `attendedSessions`.
- **Refund exceptions** are AdminOS-approved through 2f's `membershipRequestException` / `membershipDecideRefund`, never here.
- **Idempotent.**

### Reject list (owner) → `details.reason`

| Reason | Message |
|---|---|
| `expired` | This membership has expired. |
| `cancelled` | This membership has been cancelled. |
| `suspended` | This membership is suspended. |
| `wrong_member` | This QR code does not belong to this membership holder. |
| `not_covered` | This membership does not cover a session right now. |
| `other_gym` | This membership is not for your gym. |
| `entitlement_exhausted` | All sessions on this membership have been used. |
| `no_permission` | You don't have permission to record attendance for this gym. |
| `token_invalid` / `token_expired` | Ask the member to refresh the QR in their app. |
| `self_scan` | You cannot check yourself in. |

Refusals carry no other membership data, so another gym's data is never leaked.

## 5. Reuse decisions (census: STEP 0)

| Need | Reused | Not reused (why) |
|---|---|---|
| QR signing | `event-ops.credentialHash` uses the platform credential secret `SOKONI_HMAC_KEY` (delivery PIN, event ticket PIN, entertainment booking PIN) with its domain-prefix convention (`fitmem1\|`). In Cloud Functions it fails closed without the key. No new secret, no new HMAC helper. | `sokoni-qr-authority` has a closed type list and no expiry, and it is a money-path module. `qr.js` (`generateSecureQR`/`verifyQRCode`) is stateful and its verifier is unauthenticated. `pos-qr` is payment-specific. The service booking PIN is kept separate by owner rule. |
| Gym ownership | `providers/{uid}`: `providerId === uid` (the provider-ops convention; `business-workspace.workspaceFor`) | — |
| Staff permission | `workforce-identity._assertBusinessPermission(uid, <gym's linked business>, 'attendance')`, imported (§6). No third guard is written. | `merchant-authority` (no permission keys), `business-bootstrap._assertMerchantAccess` (posStaff, de-authorized) |
| Admin check | AdminOS `_requireAdmin` predicate (same as membership-settlement) | `admin-claim.isAdmin` accepts legacy spellings, so the narrower check is used. |
| Audit | `adminAudit` | per-module audit collections |
| Period window | `membership-settlement.endsAt` (the one period computation) | — |

## 6. Staff authorization and business linkage (FINAL RELEASE, 2026-10-03)

Owner rule: scanners are the gym owner, an authorized manager, or "staff WITH attendance permission via the existing role/permission authority". Cashier, trainer and employee roles are **not** automatic.

Full census: scratchpad `fitness-business-linkage.md`. Related: [[Authentication]], [[Payments]].

### 6.1 Linkage census (THIS tree, live c7e26b6 / f66f2c1, 5b 13f74f3 / cbbce0c, b2 4ab4eb7)

- **No canonical provider → business link exists on any tree**, and no branch is building one.
  - `business-workspace` marks the provider `staff` module `NOT_IMPLEMENTED: BUSINESS_IDENTITY_PENDING`. The identity is the owner-deferred "SOK-ID business identity" (2026-09-28).
  - Closing it = an owner decision + sokoni-5b (business-workspace, application-lifecycle).
- **Approval provisioning** (`application-lifecycle.applyDecision`):
  - a driver gets a `SOK-…` business (`_ensureBusinessForOwner`, D1-A);
  - a seller gets the `businesses/{uid}` directory row;
  - **a provider (a gym) gets none**.
- **Neither of these can be reused to find "the gym's business"**: `_ensureBusinessForOwner` and `tenant-identity.resolveMerchantIdForOwner` both answer "the owner's (one) business". An owner with a shop or a delivery business would have the gym linked to it. That is inventing the bridge, which is forbidden.
- **`workforce-identity`** is byte-identical on every lineage (blob `9cf3cb46`) and **unowned**.
  - `_assertBusinessPermission`:
    1. `businesses/{id}` must exist;
    2. `ownerId === caller` is allowed;
    3. otherwise it needs an active `workspaceMemberships{uid, businessId, status:'active'}` with `permissions[]` containing the key.
  - Permission keys: `ALL_PERMISSIONS` (now 18). Role defaults: `ROLE_PERMISSIONS`; the `owner` role = all.

### 6.2 What is built (fitness-attendance.js)

`resolveGymBusiness(providerId)` reads ONLY `providers/{providerId}.linkedBusinessId`. It accepts the link only if all of these hold:
- `businesses/{id}` exists;
- `ownerId === providerId`;
- `merchantId`, when present, `=== id`;
- `status` is absent or `active`.

Otherwise it returns **`BUSINESS_LINK_MISSING`**.

**Scanner authorization, `assertScanner(uid, membership)`:**
1. `uid === providerId`: **owner** (self-scan refused).
2. Otherwise, staff:
   - `resolveGymBusiness(providerId)`, then `workforce-identity._assertBusinessPermission(uid, businessId, 'attendance')`, imported;
   - an active membership with the explicit key in **that** business is required;
   - a revoked or inactive membership, another business, or a missing key is refused.
3. A refused caller is told:
   - `other_gym` if they are a provider;
   - `business_link_missing` ONLY if they hold `attendance` in a business this gym's owner owns;
   - `no_permission` otherwise.

   The link state is never revealed to strangers or to the member scanning their own code.
4. **Gym gate** (owner and staff):
   - `providers/{providerId}` approved (`active|approved`, not suspended). Otherwise `not_approved`.
   - `business-workspace.assertModule(db, providerId, 'memberships', HttpsError)`, imported. Otherwise `module_unavailable`.
     - **PENDING on this tree:** `MODULES` has no `memberships` key yet. Calling `assertModule` with an unknown key would refuse every gym.
     - `moduleGate` therefore reports `state:'pending'` and engages automatically once 5b ships the key (§13.2).

**`workforce-identity`:** `'attendance'` was added to `ALL_PERMISSIONS`, in **no role default** (d00dadb). It is the scan permission **and** the view permission for the gym read callables (§11): whoever admits members must see whom they admit. Cashier `customers` and receptionist `bookings` grant nothing here.

**In practice today staff scanning refuses with `BUSINESS_LINK_MISSING`.** Nothing writes `linkedBusinessId` yet. Rows S1–S5 prove the full path with a seeded link.

### 6.3 Provisioning change needed (NOT applied; owner decision + owners named)

| Step | File | Owner | Change |
|---|---|---|---|
| 1 | `functions/business-bootstrap.js` | unowned (POS lineage) | add `_ensureProviderBusiness({uid, businessName, category, …})`:<br>- **kind-scoped** claim `posProvisioning/{uid}__provider`;<br>- returns the existing `linkedBusinessId` when present;<br>- otherwise `_createBusiness(__businessKind:'provider')`, then writes `providers/{uid}.linkedBusinessId`;<br>- releases the claim on failure.<br>Also skip the seller subscription for `__businessKind === 'provider'`, as is done for `'delivery'`. Exact text: scratchpad `fitness-business-linkage.md` §1. |
| 2 | `functions/application-lifecycle.js` projectProvider (approved branch, after `await ref.set(doc, { merge: true })`) | **sokoni-5b** (cbbce0c edits this file; live = f66f2c1) | for `categoryOf(...) === 'fitness_studio'`, call step 1 and add `business` to the receipt. Idempotent. |
| 3 | admin backfill script | owner approval | approved fitness_studio providers → step 1. Dry-run by default. |
| 4 | `firestore.rules` providers create/update protected keys | f3 (rules candidate) | add `'linkedBusinessId'`, `'linkedBusinessAt'` next to `'business'`. **Today a provider can write its own `linkedBusinessId`** (served f259c0b5 and tree). The resolver's `ownerId` check bounds this to the provider's OWN businesses: served `businesses` create is false, and `ownerId` is not on the served update allow-list. |

**PRE-EXISTING, flagged to f3.** THIS tree's (not served) `businesses` create rule does not pin `ownerId` (`uid == auth.uid && noAdminFields()`).
- A user could create `businesses/X {ownerId:<victim>}`.
- `_ensureBusinessForOwner` and `tenant-identity` would then trust that doc.
- Served rules (create false) are safe. The tree's rule must not ship as written.

## 7. Security matrix (`scripts/test-fitness-attendance.js`: 47/0, controls 9/9)

| Row | Case |
|---|---|
| A1 | Buyer-only QR; payload has ids/times only; others get not_found; anonymous refused |
| A2 | Forged token (other key), junk → token_invalid |
| A3 | Modified token (membership/expiry/gym swapped, signature kept) → token_invalid |
| A4 | Expired token → token_expired |
| A5 | Other gym's scanner → other_gym, no data leak, nothing written |
| A6 | Other membership (cannot mint) / member changed → wrong_member |
| A7, A7b | Cashier and trainer (active staff, no key) → no_permission, with or without a link; the staff seam's denial holds |
| A8 | Buyer self-scan → no_permission; owner with own membership → self_scan |
| A9, A9b | First scan sets attendedSessions 1 + firstAttendedAt + refundEligible false; ledger row shape |
| A10 | Duplicate scan → existing result; membership and ledger byte-identical |
| A11 | Later scans increment only; firstAttendedAt unchanged |
| A12, A12b | pending_payment / payment_review / refund_requested / refunded / expired / cancelled / suspended / disputed refused with nothing written; no QR issued when not active |
| A13 | Active but unpaid (pending / refund_requested / missing / unpaid) refused |
| A14 | Before startAt → not_covered; at the end → expired |
| A15 | Session cap → entitlement_exhausted; malformed sessionRef refused |
| A16 | Client attendedSessions / refundEligible / timestamps / ownership / status ignored |
| A17, A17b, A17c | Correction is admin-only, needs a reason, appends and voids, is idempotent; **never resets the refund lock** (2f `isUsed` and `refundDecision` still say used); restores entitlement only |
| A18 | Completion is separate, other gym refused, idempotent, voided rows cannot complete |
| A19, A19b, A19c | releaseDueSlices is called once (first check-in only); its failure does not fail the check-in; with the REAL releaseDueSlices, both elapsed months release |
| A20 | adminAudit row for every refusal / check-in / duplicate / completion / correction; no PII |
| A21 | Check-in vs refund request, each committed inside the other's transaction: exactly one wins in both orders |
| S1 | Staff of the SAME (linked) business with explicit `attendance` records attendance; ledger actorRole staff |
| S2 | Staff WITHOUT the key (cashier) and a non-member → no_permission |
| S3 | Staff of business B (attendance at gym B) scanning a gym A member → refused |
| S4 | No link / mislinked to another owner's business / link to a missing, inactive or malformed business → BUSINESS_LINK_MISSING. An owned business without a link is **never inferred**. |
| S5 | Revoked workspace membership (even holding `attendance`) → refused |
| S6 | Suspended gym → not_approved (owner and staff); closed module → module_unavailable; real module gate on this tree = PENDING |
| S7 | `attendance` is in `ALL_PERMISSIONS` and in no role default |
| N1 | Member notified on EACH recorded check-in (the first says it is no longer refundable), never on a duplicate; dedupeKey per ledger row |
| N2 | Notification failure never fails the check-in |
| N3 | Check-in response: displayName (sanitised), title, checkedInAt, Unlimited; no member uid/phone/email |
| A22 | Check-in response contract: success AND duplicate carry the exact same key set (membershipId, attendanceId, member.displayName, title, ISO checkedInAt, attendedSessions after, sessionsIncluded|null, duplicate, firstCheckIn) — [[FITNESS_MEMBERSHIP_API]] §3 |
| G1 | List: the owner sees only its own gym; client providerId/businessId ignored |
| G2 | Detail of another gym's membership → not_found; non-gym caller → permission-denied; anonymous refused |
| G3 | limit capped at 50 (query ≤51); cursor paging newest-first without overlap; foreign cursor / limit 0 / unknown tab → invalid-argument |
| G4 | remaining = cap − (attended − voided); uncapped → null; unknown attendance → null (never 0); pending → no start/end |
| G5 | displayName only; no member uid / phone / email anywhere in the response |
| G6 | Staff list: attendance staff → its gym; cashier → NO_PERMISSION; unlinked → BUSINESS_LINK_MISSING; two gyms → MULTIPLE_GYMS |
| G7 | Detail: ≤100 attendance rows newest-first without uids; settlement = providerPayouts sourceType membership for THIS membership AND gym only |
| SS1 | fitnessScannerStatus: owner / staff / NOT_APPROVED / BUSINESS_LINK_MISSING / NO_PERMISSION / MODULE_NOT_AVAILABLE; anonymous refused |

**Negative controls** (in-memory source mutation; each must fail its named row):

| Control | Mutation | Named row that fails |
|---|---|---|
| NC-a | Ownership check skipped | A5 |
| NC-b | refundEligible only on the 2nd scan | A9 |
| NC-c | Client refundEligible accepted | A16 |
| NC-d | State decided on the pre-transaction read (TOCTOU) | A21 |
| NC-e | Staff business-match skipped (any business the caller works at) | S3 |
| NC-f | Workforce permission check skipped | S2 |
| NC-g | Client providerId accepted by fitnessGymMemberships | G1 |
| NC-h | Duplicate-scan idempotency dropped | A10 (and N1) |
| NC-i | membershipId dropped from the check-in response | A22 |

The suite loads the REAL `workforce-identity.js`. Its `admin.firestore()` is bound to the fake db, so `_assertBusinessPermission` itself decides every staff row.

**Run:** `NODE_PATH=<functions/node_modules> NODE_OPTIONS=--require <block-admin.js> node scripts/test-fitness-attendance.js`. The suite stubs `firebase-admin` itself; any real Firestore call throws.

**Emulator / runtime proof: QUEUED.** Free RAM was below the 512 MB floor, so an in-memory Firestore fake with transaction re-run semantics was used.

## 8. Required Firestore rules (separate lane — NOT edited here)

```
match /providerMemberships/{id} {
  allow read: if isAdmin() || (isAuthed() && (resource.data.buyerUid == request.auth.uid
                                               || resource.data.providerId == request.auth.uid));
  allow write: if false;                               // server only (2f + this module)
  match /attendance/{attId} {                          // member sees own history; gym sees its members
    allow read: if isAdmin() || (isAuthed() && (get(/databases/$(database)/documents/providerMemberships/$(id)).data.buyerUid == request.auth.uid
                                                 || get(/databases/$(database)/documents/providerMemberships/$(id)).data.providerId == request.auth.uid));
    allow write: if false;
  }
  match /attendanceCorrections/{attId} { allow read: if isAdmin() || <gym owner as above>; allow write: if false; }
  match /events/{e}   { allow read: if isAdmin() || <gym owner>; allow write: if false; }   // 2f
  match /releases/{r} { allow read: if isAdmin() || <gym owner>; allow write: if false; }   // 2f
}
```

- Staff reads go through callables only.
- `adminAudit` already exists (admin read, write false).
- Check brace depth against duplicate-match OR semantics before merging (memory: served rules duplicate paths).

## 9. NOT built / open

- **`fitnessCreateMembership`: BUILT** (§10). The owner decided on 2026-10-03 that a gym publishes its membership offers **in its provider services**. A provider still **cannot publish** an offer until sokoni-5b's providerDispatch release carries the writer hook (§10.4), and the hosting form (§10.6) exists.
- **Staff scanning:** BUILT. It refuses `BUSINESS_LINK_MISSING` until the provisioning change (§6.3) lands. Owner decision + sokoni-5b.
- **Rules:** §8 and §10.5, a separate lane.
- **Hosting:**
  - gym "SCAN MEMBER QR" scanner UI (camera; offline → "unavailable, retry"; success card only after the server returns);
  - member QR / history screen;
  - provider Active Members / Attendance / Today's Sessions dashboard.
  - None of these exist.
- **AdminOS view:** the "why refund locked" attendance view ("Membership attended: N sessions") is not built. The data is ready: `attendedSessions`, the ledger, and `adminAudit`.
- **Super Admin platform settings** (TTL, per-gym policy): not built. The TTL is a 5-minute constant.
- **No-show policy:** none exists, so a booked no-show is NOT attendance (owner: "do not invent that policy").
- **Booked → Started lifecycle (owner §5):** only check-in and completion exist; no booking linkage.
- **Payment purpose / hold / refund execution:** built by 2f at `57fe896` (`fitness_membership`, `holdMembershipPayment`, `membershipDecideRefund`), not here.
- **Emulator proof:** QUEUED.
- **Deploy:** NOT deployed.
  - Needs `SOKONI_HMAC_KEY` bound (it already exists).
  - `enforceAppCheck: true`, so the scanner page needs App Check.
  - Scoped `--only functions:fitnessMembershipQr,fitnessCheckIn,fitnessCompleteSession,fitnessCorrectAttendance,fitnessCreateMembership,fitnessGymMemberships,fitnessGymMembership,fitnessScannerStatus` (plus the two `providerMemberships` composite indexes, §11), after 2f's membership functions **and** after sokoni-5b's providerDispatch release carrying §10.4. Before that release, `fitnessCreateMembership` refuses every service, because no record can carry `serviceKind:'membership'`. That is safe, but it is useless.

## 10. Membership offers in provider services + `fitnessCreateMembership` (owner 2026-10-03)

**Owner decision (verbatim):** "a gym publishes its membership offers IN ITS PROVIDER SERVICES".

**Files:**
- `functions/shared/membership-offer.js` (pure)
- `functions/fitness-membership-create.js`
- `scripts/test-fitness-membership-create.js`

### 10.1 Census: who owns `providerServices`

This tree and the live providerDispatch lineage `c7e26b6` match. The full census is in scratchpad `fitness-attendance-reuse.md`, under "STEP 0 (membership offers)".

**The record:**
- **Path:** `providerServices/{autoId}`. Legal uses `legal_consult_<uid>`.
- **Owner field:** `providerId`.
- **`price`** is **integer cents**: provider-ops `_cents = max(0, round(Number(v)||0))`.
- **`priceType`** is `fixed | hourly | quotation`. It is a pricing mode, not a kind.
- **`active` / `removedAt`** handle soft delete.
- **No kind or type field existed.**

**Writers.** All are server-side, in `provider-ops.js` behind **providerDispatch**, which is sokoni-5b's ONE reconciliation release:
- `providerAddService`
- `providerUpdateService`
- `providerToggleService`
- `providerRemoveService`
- `providerDuplicateService`
- `providerUpdateServicePricing`
- plus `ent-availability` (`availability{}`) and `legal-verification` (its own doc).

Their field whitelists drop `serviceKind` / `periodCount`.

**Rules** (tree and served `f259c0b5`): `allow read: if isAuthed()`, with no write rule, so **client writes are denied**.

**Reader:** `bookingCreateService` prices `Math.round(Number(svc.price))` cents after a provider gate of `status ∈ {active, approved} && acceptsBookings !== false`.

### 10.2 Offer shape

These fields are added to the EXISTING record. Nothing else changes.

| Field | Value |
|---|---|
| `serviceKind` | `'membership'`. This is a new field, because there was no existing kind field to reuse. |
| `periodCount` | integer 1..60 (months) |
| `periodUnit` | `'month'` |
| `price` | The EXISTING field, in integer cents. It must be **whole shillings** (`% 100 === 0`) within KES 1..150,000. The reason: `priceFor` rounds to KES, and `holdMembershipPayment` requires paid KES × 100 === `priceCents`. A cents remainder would park every payment in `payment_review`. |
| `priceType` | `'fixed'`. The hook forces it, because `providerAddService` defaults to `'quotation'`. A rate-card `pricing{}` is refused. |

`validateMembershipOffer(doc)` returns `{ok, providerId, priceCents, periodCount, periodUnit, title}` or `{ok:false, reason, message}`. It **refuses rather than coerces**: a missing, zero, negative, string, fractional or out-of-range price is not an offer. The price "conversion" is the booking one (`price` is already integer cents). It is validated as an integer and never rounded.

### 10.3 `fitnessCreateMembership({ serviceId })` (us-central1, App Check; NOT deployed)

**Server order of checks:**
1. auth
   - then **the sales flag** (owner 2026-10-03): `featureFlags/fitness_membership_sales.enabled === true`, read server-side; anything else, or a read error → `failed-precondition` `SALES_DISABLED` "Memberships aren't on sale yet." Details and the AdminOS writer: [[FITNESS_MEMBERSHIP_API]] §1.
2. `providerServices/{serviceId}` is read server-side, then `validateMembershipOffer`
3. buyer ≠ provider (`self_purchase`)
4. `providers/{providerId}` passes these checks:
   - `status ∈ {active, approved}` (the booking gate);
   - not `suspended`;
   - `acceptsBookings !== false`;
   - **`business-category.categoryOf(...) === 'fitness_studio'`**. The ids gym, yoga-studio, martial-arts, dance-fitness and spinning map to this category at approval. A free-text `category` is never trusted.
5. single-flight transaction on `fitnessMembershipClaims/{sha256(buyer|service)}`:
   - a `pending_payment`/`pending` membership for the same buyer+service that is **< 30 min old is returned** (`reused:true`);
   - otherwise a new `providerMemberships/{autoId}` is created with `create()`.

**Created doc (EXACT; the suite asserts the key set):**
```
{ providerId, buyerUid, priceCents, periodCount, periodUnit:'month', startAt, payBy, category:'fitness', title,
  paymentStatus:'pending', status:'pending_payment', serviceId, createdAt }
```

**Snapshot (2f constraint).** At creation, `priceCents` / `periodCount` / `periodUnit` / `title` are **copied** from the offer. They are immutable on the membership. `payment-purposes.fitness_membership` prices from the membership doc and never re-reads the offer. So a later offer edit changes nothing already created (suite row C12; negative control NC-d).

**2f pricer check.** On this tree, the pricer reads only `buyerUid`, `paymentStatus`, `status`, `priceCents`, `providerId` and (as metadata) `periodCount`. All of them are in the create shape, so **no extra fields are needed**.

**`startAt` = server time at creation = the REQUESTED start.** sokoni-2f (df88d4b §13.2) moves it to the PAYMENT time in `holdMembershipPayment`, unless it lies in the future. 2f keeps the creation value as `requestedStartAt`. This path never writes `requestedStartAt`.

**`payBy` = creation + `PAY_BY_MS` (5 min).** `payment-purposes.fitness_membership` refuses a NEW intent after `payBy` (2f, S3); a payment already in flight is honoured.
- `PAY_BY_MS` is the platform pre-payment hold window: `booking-service.js` `HOLD_MS`.
- That constant is not exported (5b's file), so the VALUE is reused. Suite row C17 pins it to that source line and fails on drift.
- **Hand-off to 5b:** export `HOLD_MS`, and this module will import it.

The double-tap reuse (30 min) applies only while `now < payBy`. Reuse never returns an expired membership, and a record without `payBy` is never reused.

**Returns:** `{ membershipId, reused, priceCents, periodCount, periodUnit, title, payBy }` (`payBy` as an ISO string, for the UI countdown).

**Client next step:** `createPaymentIntent({ purpose:'fitness_membership', membershipId })`.

### 10.4 Hook for sokoni-5b's providerDispatch reconciliation release (NOT applied on this branch)

`provider-ops.js` / `booking-service.js` are NOT edited here. The release must also ship `functions/shared/membership-offer.js`. Each hook is a call into the pure module:

```js
// providerAddService: build the object first (const doc = { providerId: uid, name, … }), then before .add(doc):
const mo = require('./shared/membership-offer').applyToServiceWrite('create', d, null, doc);
if (!mo.ok) throw new HttpsError('invalid-argument', mo.message, { reason: mo.reason });

// providerUpdateService: before `await ref.update(patch)`:
const mo = require('./shared/membership-offer').applyToServiceWrite('update', d, snap.data(), patch);
if (!mo.ok) throw new HttpsError('invalid-argument', mo.message, { reason: mo.reason });

// providerDuplicateService: build `const doc = {…}`, then before .add(doc):
const mo = require('./shared/membership-offer').applyToServiceWrite('duplicate', null, s, doc);
if (!mo.ok) throw new HttpsError('invalid-argument', mo.message, { reason: mo.reason });

// providerUpdateServicePricing: after the ownership check (a membership has a fixed price, never a rate card):
if (require('./shared/membership-offer').isMembershipOffer(snap.data())) throw new HttpsError('failed-precondition', 'A membership has a fixed price.');

// booking-service.bookingCreateService: after the `svc.active === false || svc.removedAt` check:
if (require('./shared/membership-offer').isMembershipOffer(svc)) throw new HttpsError('failed-precondition', 'This is a membership. Buy it from the gym page.', { code: 'MEMBERSHIP_NOT_BOOKABLE' });
```

**Why the booking hook matters.** Without it, a membership offer is slot-bookable at the membership price.

**What the writer hook does** (suite row C14):
- It forces `priceType:'fixed'` and `periodUnit:'month'`.
- It validates the RESULTING record, so an edit cannot leave an unsellable offer listed.
- It refuses `periodCount` on a non-membership service and refuses unknown kinds.
- A duplicate keeps the kind.

### 10.5 Rules for the rules lane

- **`providerServices`:** **no change.** Client writes are already denied (served `f259c0b5` and the tree), and every writer is a server callable. Membership validation therefore lives in the hook, not in rules.
- **`fitnessMembershipClaims/{id}`:** new and server-only. No rule is needed (default deny). Add an explicit one if the lane prefers:
  ```
  match /fitnessMembershipClaims/{id} { allow read, write: if false; }
  ```
- **`providerMemberships`:** as in §8 (buyer / gym / admin read, no client writes).

### 10.6 Still open

- **Provider dashboard form (hosting).** `provider-dashboard.html` needs a "Membership" kind and a months field that send `serviceKind:'membership', periodCount` to `providerAddService` / `providerUpdateService`. It also needs a member-facing "Buy membership" button that calls `fitnessCreateMembership`, then `createPaymentIntent`. Not built.
- **Abandoned pending memberships.**
  - A pending membership older than 30 min is not reused, but it stays `pending_payment` and payable by its id. The 2f pricer has no age limit.
  - The status fields belong to 2f, so this module never writes them.
  - An expiry or cancel of stale pending memberships is a 2f / owner decision.
- **`startAt` at creation.** A member who pays late loses those days. The alternative (start at payment) would be a 2f hold change.
- **Live lineage differences** (`c7e26b6` vs this tree):
  - the service cap source: live reads `providerSubscriptions.limits.listings`, this tree uses `_serviceCapFor`;
  - the toggle re-activation cap.
  - Neither affects the hook, but 5b ports the hook onto the live text.

### 10.7 Tests: `scripts/test-fitness-membership-create.js` (18/0, negative controls 8/8)

| Row | What it covers |
|---|---|
| C1 | unauthenticated |
| C2 | missing / malformed serviceId |
| C3 | non-membership / inactive / deleted / wrong-case kind |
| C4 | periodCount 0 / 61 / 2.5 / "3" / null / -1 / NaN, and unit week |
| C5 | price missing / negative / string / 0 / cents remainder / fraction / > max / NaN, and quotation / rate card |
| C6 | provider pending / rejected / suspended (status or flag) / not selling / missing; active accepted |
| C7 | salon, and unclassified free-text "gym" |
| C8 | buyer == provider |
| C9 | client fields ignored |
| C10 | sequential and concurrent double tap → one; other buyer; ≥30 min; paid → new |
| C11 | exact doc shape |
| C12 | offer edit after creation changes neither the doc nor the charge |
| C13 | end to end: create → 2f `priceFor` → 2f `holdMembershipPayment` (real; `initialSettlementFields`) → QR check-in locks the refund (`refundDecision` → `used`) |
| C14 | writer hook |
| C15 | payBy is set server-side (creation + 5 min); a client payBy is ignored; 2f's purpose refuses a new intent after it |
| C16 | reused 1 ms before payBy; a new one AT payBy (inside 30 min); a record without payBy is never reused |
| C17 | PAY_BY_MS equals booking-service `HOLD_MS` (drift fails) |
| C18 | Sales flag: `featureFlags/fitness_membership_sales` missing / no field / false / `'true'` / 1 / read error → `SALES_DISABLED`, nothing written; `enabled === true` → created; `salesEnabled(db)` agrees with an explicit db |

**Negative controls.** Each one fails its named row:

| Control | Mutation | Row that fails |
|---|---|---|
| NC-a | client price accepted | C9 |
| NC-b | approval check skipped | C6 (and C7) |
| NC-c | idempotency dropped | C10 |
| NC-d | pricer re-reads the offer at pay time | C12 |
| NC-e | reuse ignores payBy | C16 |
| NC-f | payBy not written | C15 |
| NC-g | sales-flag check removed | C18 |
| NC-h | sales flag compared truthy (`'true'` / 1 accepted) | C18 |

**Regression (after merging 2f df88d4b):**
- test-fitness-attendance 47/0 (9/9)
- test-membership-settlement 53/0
- test-membership-offer-module 6/0
- C12/C13 run on the real clock, because the purpose's payBy check reads `Date.now()`.

**Emulator:** QUEUED.

## 11. Gym read callables (FINAL RELEASE; `functions/fitness-gym-memberships.js`; us-central1, App Check; NOT deployed)

All three use ONE authorization path with the check-in: `fitness-attendance.resolveGymScope(uid)`.

**Who is in scope:**
- **Owner:** `providers/{uid}` exists, so the gym is `uid`. An owner never reads another gym through a staff membership.
- **Staff:**
  - discovery: active `workspaceMemberships` holding `attendance` (≤10), whose business is the LINKED business of an existing provider;
  - authorization: `_staffAuthority` (the workforce guard);
  - several such gyms → `MULTIPLE_GYMS`. No gym selector is accepted from the client; this is a documented limitation.
- Then the gym gate (approved + `memberships` module).
- **The request never names the gym.** `providerId` / `businessId` in the payload are ignored (row G1; control NC-g).

| Callable | Input | Output |
|---|---|---|
| `fitnessGymMemberships` | `{status?: active\|pending\|expired\|refund\|all, limit? (1..50, default 20), cursor?}` | `{rows:[row], nextCursor}` |
| `fitnessGymMembership` | `{membershipId}` | `{membership: row, attendance:[≤100], attendanceTruncated, settlement:{releases, releasedPeriods, releasedCents, netSettledCents}}` |
| `fitnessScannerStatus` | — | `{canScan, role: owner\|staff\|null, reason?}` |

**`fitnessGymMemberships` query:** `where providerId == <resolved>` [`where status in <tab>`] `orderBy createdAt desc`, `startAfter(cursor doc)`, `limit(n+1)`.
- The cursor is a membership id. It must belong to the same gym, otherwise `invalid-argument`.
- Tabs map to statuses:
  - active → `active`;
  - pending → `pending_payment`;
  - expired → `expired`;
  - refund → `refund_requested` and `refunded`.

**`fitnessGymMembership`:**
- Another gym's id → `not-found`, indistinguishable from a missing one.
- Attendance: `orderBy checkedInAt desc limit 100`. Rows carry `{attendanceId, checkedInAt, status, method, actorRole, sessionRef, completedAt}`, with no actor or member uid.
- Settlement: `providerPayouts where sourceType=='membership' && membershipId==id && providerId==<gym>` (≤60, sorted by periodIndex). Rows carry `{periodIndex, grossCents, commissionCents, netCents, status, settledAt}`.

**`fitnessScannerStatus` reasons:**
- `NOT_APPROVED`, `BUSINESS_LINK_MISSING`, `NO_PERMISSION` (contract);
- `MODULE_NOT_AVAILABLE` (once 5b's key ships) and `MULTIPLE_GYMS`, added by this lane — the UI should show them verbatim as configuration errors.

**Row fields:** `membershipId, member:{displayName|null}, title, periodCount, periodUnit, startAt, endsAt, sessionsIncluded|null, attendedSessions, remaining|null, lastAttendedAt|null, status, paymentStatus, refundState|null, refundEligible, releasedPeriods, releasedCents`.

**What is returned and why (data minimisation):**
- **member.displayName only** (`users/{buyerUid}.displayName || name`, stripped of markup, ≤60 chars), so the gym can recognise who is at the door. The member's uid, phone and email are never returned (G5).
- `startAt` / `endsAt` only once paid (before payment the start is only requested).
- `attendedSessions`:
  - absent and no `firstAttendedAt` → `0`. The check-in path is the only writer, so the ledger is empty by construction: a canonical zero.
  - absent with a `firstAttendedAt` → `null` (unknown).
- `remaining = sessionsIncluded − (attendedSessions − voidedSessions)` when capped, else `null` (UI: "Unlimited").
- `refundEligible` = `false` once used, `true` at zero use, `null` when unknown.
- Unknown is always `null`, never `0`.

**Reads per call:**
- list: 1 query + ≤50 `users` gets, plus a cursor get;
- detail: 1 + 1 + 1 query + 1 user;
- scope: 1–4 small reads (owner: 1 provider read + gate).

**Indexes (added to `firestore.indexes.json`):**
- `providerMemberships (providerId ASC, createdAt DESC)`;
- `providerMemberships (providerId ASC, status ASC, createdAt DESC)`.

No composite index is needed for the other queries:
- attendance: single-field orderBy;
- providerPayouts and workspaceMemberships: equality-only (merged single-field indexes).

## 12. Notifications

**Census.** `functions/notify.js` `notify({uid, type, title, body, dedupeKey, …})` is the ONE sender (in-app + push; SMS per type).
- 2f's `membership-settlement._notify` wraps it.
- It is best-effort, `awaitDelivery:false`, and uses **existing registered types**.

**This lane** sends to the member after EACH recorded check-in:
- when: after commit, never on a duplicate scan;
- type `booking_confirmed` (commerce/orders, no SMS template);
- `dedupeKey = membership_checkin_<membershipId>_<attendanceId>`;
- body: plan title + "Session N of M" / "Unlimited sessions";
- the FIRST check-in adds "Your membership is now in use, so it can no longer be refunded."
- A notify failure never fails the check-in (N2). Logs carry ids only, never PII.

**Payment / refund / settlement notifications (2f's lane, df88d4b). Existing:**

| Event | Recipient | Type |
|---|---|---|
| Paid + held (active) | member | `subscription_activated` |
| Paid + held | gym | `booking_new` |
| Months released | gym | `wallet_credit` |
| Membership ended | member | `subscription_expired` |
| Refund requested | member + gym | `booking_refund` |
| Refund declined | member | `booking_refund` |
| Refunded | member | `refund_processed` |

**Hand-off to 2f — missing, NOT written here:**
1. `payment_review` (amount mismatch / binding): member "Payment under review" + `admin_alert` to AdminOS.
2. Refund EXECUTED: tell the gym (its held money left).
3. `membershipRequestException` filed: AdminOS `admin_alert`.
4. Refund approved but wallet credit failed: member + `admin_alert`.
5. Optional: `payBy` passed without payment (the member can start again) — only if the owner wants it.

**Hand-off to notify.js:** a dedicated `membership_attendance` type (commerce, category `orders`, `smsTemplate:null`) if the owner wants attendance notices tunable apart from bookings. The call site changes one string.

## 13. Hand-offs (exact text; NOT applied by this lane)

### 13.1 sokoni-5b / owner: provider business identity

See §6.3. Exact code is in scratchpad `fitness-business-linkage.md`.

### 13.2 sokoni-5b: the `memberships` workspace module

`business-workspace.assertModule` exists; the key does not.

1. `functions/business-workspace.js` MODULES:
   `memberships:   { label: 'Memberships',         section: 'memberships',  implemented: true },`
2. `functions/shared/service-capabilities.js` (13f74f3+):
   - `CAPABILITIES.MEMBERSHIPS = { label: 'Memberships', vertical: 'fitness' }`;
   - `FROM_BUSINESS_ID`: `'gym': ['MEMBERSHIPS'], 'yoga-studio': ['MEMBERSHIPS'], 'martial-arts': ['MEMBERSHIPS'], 'dance-fitness': ['MEMBERSHIPS'], 'spinning': ['MEMBERSHIPS']`;
   - `MODULES_OF.MEMBERSHIPS = { provider: ['memberships'] }`.
3. Export `HOLD_MS` from `booking-service.js` (`module.exports = { _h, _prepareSlot, HOLD_MS }`). fitness-membership-create will then import it instead of pinning the value.

### 13.3 Hosting (e3 UI lane): `sokoni-workspace.js` PERMISSIONS mirror

```js
    SETTINGS:        'settings',
    ATTENDANCE:      'attendance',   // fitness: scan member QR + view memberships — explicit grant only, no role default
```

Do not add it to any `ROLE_PERMISSIONS` entry there. `owner` is `Object.values(PERMISSIONS)` and picks it up automatically.

### 13.4 f3: rules

- Protect `providers.linkedBusinessId` / `linkedBusinessAt` (§6.3 step 4).
- The pre-existing tree `businesses` create rule (§6.3).

### 13.5 2f

Notifications (§12).

**Sales flag, defence in depth (2026-10-03):** `payment-purposes.fitness_membership` should ALSO refuse a new intent while `featureFlags/fitness_membership_sales` is not `enabled === true`, by calling e3's exported `salesEnabled(db())`. The exact insertion text is in [[FITNESS_MEMBERSHIP_API]] §1 "Hand-off to sokoni-2f". It is NOT applied here, because that file belongs to 2f.
