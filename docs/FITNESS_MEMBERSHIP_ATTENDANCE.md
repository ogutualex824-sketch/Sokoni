# Fitness membership attendance — QR check-in ledger

**Status:** BUILT on `feat/fitness-attendance-on-8bbfb34` (based on commercial-fn `57fe896`). **NOT deployed.**
**Owner rules:** 2026-10-03, "server-authoritative attendance ledger" and OWNER POLICY #2 (QR check-in).
**Modules:** `functions/fitness-attendance.js` · `functions/fitness-membership-create.js` · `functions/shared/membership-offer.js` (§10).
**Tests:** `scripts/test-fitness-attendance.js` · `scripts/test-fitness-membership-create.js`.
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
| Staff permission | **BLOCKED** (§6). No third guard is written. | — |
| Admin check | AdminOS `_requireAdmin` predicate (same as membership-settlement) | `admin-claim.isAdmin` accepts legacy spellings, so the narrower check is used. |
| Audit | `adminAudit` | per-module audit collections |
| Period window | `membership-settlement.endsAt` (the one period computation) | — |

## 6. BLOCKED: staff scanning

The owner allows "staff WITH attendance permission via the existing role/permission authority".

**What exists today:**
- `merchant-authority` (owner/adminUids only; no permission keys);
- `business-bootstrap._assertMerchantAccess` (posStaff; de-authorized);
- `workforce-identity._assertBusinessPermission` (permission keys via `workspaceMemberships`).

All three are keyed on `businesses/{merchantId}`. A gym is `providers/{uid}`, and no provider → business bridge exists:
- `tenant-identity.js` documents the two unlinked spaces;
- `business-workspace` marks the provider `staff` module `NOT_IMPLEMENTED: BUSINESS_IDENTITY_PENDING`.

**Built now:** a single seam `_staffAuthority(uid, providerId)` that **denies by default**. Cashiers, trainers and receptionists are all refused.

**Unblock:**
1. BUSINESS_IDENTITY lands: a provider gets a canonical business id.
2. Add `'attendance'` to workforce-identity `ALL_PERMISSIONS` (and `sokoni-workspace.js PERMISSIONS`) and to **no** role default.
3. Make `_staffAuthority` call `_assertBusinessPermission(uid, businessId, 'attendance')`.

## 7. Security matrix (`scripts/test-fitness-attendance.js`: 28/0, controls 4/4)

| Row | Case |
|---|---|
| A1 | Buyer-only QR; payload has ids/times only; others get not_found; anonymous refused |
| A2 | Forged token (other key), junk → token_invalid |
| A3 | Modified token (membership/expiry/gym swapped, signature kept) → token_invalid |
| A4 | Expired token → token_expired |
| A5 | Other gym's scanner → other_gym, no data leak, nothing written |
| A6 | Other membership (cannot mint) / member changed → wrong_member |
| A7, A7b | Cashier and trainer (active staff, no key) → no_permission; the staff seam's denial holds |
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

**Negative controls** (in-memory source mutation; each must fail its named row):

| Control | Mutation | Named row that fails |
|---|---|---|
| NC-a | Ownership check skipped | A5 |
| NC-b | refundEligible only on the 2nd scan | A9 |
| NC-c | Client refundEligible accepted | A16 |
| NC-d | State decided on the pre-transaction read (TOCTOU) | A21 |

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
- **Staff scanning:** BLOCKED (§6).
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
  - Scoped `--only functions:fitnessMembershipQr,fitnessCheckIn,fitnessCompleteSession,fitnessCorrectAttendance,fitnessCreateMembership`, after 2f's membership functions **and** after sokoni-5b's providerDispatch release carrying §10.4. Before that release, `fitnessCreateMembership` refuses every service, because no record can carry `serviceKind:'membership'`. That is safe, but it is useless.

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
{ providerId, buyerUid, priceCents, periodCount, periodUnit:'month', startAt, category:'fitness', title,
  paymentStatus:'pending', status:'pending_payment', serviceId, createdAt }
```

**Snapshot (2f constraint).** At creation, `priceCents` / `periodCount` / `periodUnit` / `title` are **copied** from the offer. They are immutable on the membership. `payment-purposes.fitness_membership` prices from the membership doc and never re-reads the offer. So a later offer edit changes nothing already created (suite row C12; negative control NC-d).

**2f pricer check.** On this tree, the pricer reads only `buyerUid`, `paymentStatus`, `status`, `priceCents`, `providerId` and (as metadata) `periodCount`. All of them are in the create shape, so **no extra fields are needed**.

**`startAt` = server time at creation (purchase time).** The months run from here, not from payment or first visit, unless the owner decides otherwise.

**Returns:** `{ membershipId, reused, priceCents, periodCount, periodUnit, title }`.

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

### 10.7 Tests: `scripts/test-fitness-membership-create.js` (14/0, negative controls 4/4)

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

**Negative controls.** Each one fails its named row:

| Control | Mutation | Row that fails |
|---|---|---|
| NC-a | client price accepted | C9 |
| NC-b | approval check skipped | C6 (and C7) |
| NC-c | idempotency dropped | C10 |
| NC-d | pricer re-reads the offer at pay time | C12 |

**Regression:**
- test-fitness-attendance 28/0 (4/4)
- test-membership-settlement 45/0

**Emulator:** QUEUED.
