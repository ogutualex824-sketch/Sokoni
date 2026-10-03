# Fitness membership attendance — QR check-in ledger

**Status:** BUILT on `feat/fitness-attendance-on-8bbfb34` (based on commercial-fn `57fe896`). **NOT deployed.**
**Owner rules:** 2026-10-03, "server-authoritative attendance ledger" and OWNER POLICY #2 (QR check-in).
**Module:** `functions/fitness-attendance.js`.
**Tests:** `scripts/test-fitness-attendance.js`.
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

- **`fitnessCreateMembership`: BLOCKED.**
  - The contract requires price, periodCount and title from a **provider-published server record**. None exists.
  - `providerServices` has `price`/`priceType` but no period semantics.
  - The fitness-hub "Monthly Membership (KES)" field is a browser form.
  - Using either would invent a membership-offer authority. Needs an owner/2f decision on the offer record (e.g. `providerServices` with `priceType:'membership'` + `periodCount`, written by provider-ops).
  - The CREATE shape is fixed by 2f: `{providerId, buyerUid, priceCents, periodCount, periodUnit:'month', startAt, category:'fitness', title, paymentStatus:'pending', status:'pending_payment'}`.
- **Staff scanning:** BLOCKED (§6).
- **Rules:** §8, a separate lane.
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
  - Scoped `--only functions:fitnessMembershipQr,fitnessCheckIn,fitnessCompleteSession,fitnessCorrectAttendance`, after 2f's membership functions.
