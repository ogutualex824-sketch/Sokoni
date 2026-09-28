# POS Q0c-2 — `posSendSMS`: a merchant's SMS to their own customers only (main line)

**Branch:** `pos-safety/q0c2-pos-send-sms` (from main Q0c-1 `85e71a1`) · **not deployed**
**Owner authorization (2026-09-27):** Q0c-2 as its own unit.
- **Merchant:** proven with the existing till customer authority (`customers` capability).
- **Recipients:** every one must be a `posCustomer` owned by that merchant. No arbitrary numbers, and no merchant
  identity that bypasses the proof. Foreign customers and unproven merchants are refused.
- **Volume:** 100 recipients per request and 500 per merchant per day, both enforced on the server. The daily limit is
  merchant-scoped and must hold under concurrent requests.
- **Audit:** merchant, caller, protected recipient identifiers, counts, timestamp and outcome — no raw phone numbers.
- **Out of scope:** the broken `pos-modules.js` client contract, `sendPOSReceipt`, `notify.js`/`sms.enqueue()`, and
  Q0c-1. No deployment.

**Related:** [[POS-Q0c1-sms-enqueue-admin]] · [[POS-Q0b1-customer-scope]] · [[POS-Q0b2b-customer-insights]]

## The defect

`posSendSMS` is **deployed** (2026-09-09). It was inline in `index.js`, checked only that the caller was signed in,
and then sent **any text, up to 160 characters, to any number**: `{to}`, or a `bulk` array of up to **100 numbers per
call**. There was no merchant, no customer relationship and no limit — a public SMS relay under SOKONI's sender.

Its only client (`pos-modules.js`) sends `{phones, message, businessId}`, which the handler never read, so no
legitimate path used it. That client contract is **left broken on purpose**; it is a separate later unit.

## The repair

- **`functions/pos-merchant-sms.js` (new)** holds the handler, and `index.js` re-exports it **by the same name**
  (`exports.posSendSMS = require('./pos-merchant-sms').posSendSMS`). The deployed function name is unchanged; the inline
  relay is removed. The request is `{merchantId, customerIds, message}`.
  1. **Merchant proven, before anything is read:** `pos-zero-friction._provenCustomerOwners`, the till customer
     authority (the shop owner or its staff via `resolveActor`, or a business member holding `customers`). It returns
     the proven owner set.
  2. **Recipients are customer ids, never phone numbers.** At most **100**; ids are de-duplicated and must be single
     path segments. Each must be a `posCustomers` record owned by that set (`pos-customer-scope.getOwnedIn`, which
     filters by owner in the query). A foreign, unowned, malformed or missing customer **refuses the whole request
     before anything is sent**, with one message that doesn't reveal existence. The phone used is the one **on
     record** (canonical `254…`); an owned customer with no phone is counted as rejected.
  3. **The daily quota is reserved atomically before any send.** A Firestore **transaction** on
     `smsMerchantQuota/{merchantKey}_{YYYYMMDD}` (Africa/Nairobi day) refuses `resource-exhausted` if
     `used + n > 500`, and nothing is sent. `merchantKey` is a hash of the **proven owner set**, so claiming the same
     merchant by shop id or by business id draws on **one** quota. No client rule matches `smsMerchantQuota` in the main
     or the deployed ruleset, and neither has a catch-all, so only the server can read or write it.
  4. **Audit:** `auditLogs`, type `posSendSMS`, for every request after sign-in. It records the caller, the merchant
     claim, the `merchantKey`, **hashed** recipient references (customer ids can embed phone digits), requested,
     accepted, rejected, sent and failed counts, the day, and the outcome (`sent`, `refused_not_your_customer`,
     `refused_unproven_merchant` or `refused_daily_limit`). **No phone number is stored.**
- `sent` counts **provider acceptances**, not handset delivery. Nothing about delivery is claimed.

## Evidence — `scripts/test-q0c2-pos-send-sms.js`

**Nothing is sent.** Africa's Talking is replaced in-process before any handler loads: the `sokoni-at` send functions
become recording stubs, and the suite refuses to run if the stub is not the function the handler will call. For the old
tree, the suite runs the **real old inline handler**, parsed out of that tree's `index.js`, with the same stub.
Firestore is the emulator.

| tree | result |
|---|---|
| new | **20 / 0** |
| old (`85e71a1`) | **3 / 17 FAIL** |

**Reading the old-tree failures:**
- **The relay itself, R-1, R-1b, R-2:** a raw number was sent to, **any signed-in account with no shop** could send to
  a raw number, and a bulk list of raw numbers went out. S-1 likewise sent to the raw bulk numbers, not to customers.
- **The rest (R-3 to A-1) fail because the old handler does not implement the new contract.** It refuses
  `{merchantId, customerIds}` with "to and message required". Those rows show the contract changed; they are not
  separate evidence of the ownership defect.

**New tree:**

| Area | Result |
|---|---|
| **R** | no raw `to`, no bulk raw numbers, a foreign customer refused, one foreign customer refuses the whole list, missing customers refused alike, a stranger refused, A claiming B refused, a member without `customers` refused, 101 recipients refused, an empty message refused — **nothing sent in any** |
| **S** | the shop owner reaches its own field-owned and composite customers **at the numbers on record**; a no-phone customer counts as rejected; duplicate ids are sent once; a member with `customers` reaches the business's customer; the 160-character cap holds |
| **Q-1** | at 499: two more are refused (count stays 499, nothing sent); one more **via the business claim uses the same quota** → 500; then refused |
| **Q-2** | **two concurrent requests of 30 at 450/500: one served, one refused; the day ends at 480, with 30 sent** |
| **A-1** | audit rows for `sent` and each refusal, with caller, `merchantKey`, hashed recipient refs and counts, and **no phone number anywhere** |

**Mutation check:**

| Reverted | Red |
|---|---|
| proof skipped | R-6, R-7, S-4, Q-1, A-1 |
| ownership lookup unscoped | R-3, R-4 |
| legacy raw `to` accepted | R-1, R-1b |
| per-request cap removed | R-9 |
| daily limit removed | Q-1, Q-2, A-1 |
| **quota not transactional** | Q-1, Q-2, A-1 — Q-2 shows **both requests served, 60 sent** |
| quota keyed on the claim, not the proven merchant | Q-1 |
| audit stores phones | A-1 |

**The concurrency caveat, stated plainly:** the emulator serialises transactions with locks, whereas production Firestore
uses optimistic concurrency with retry. Both give serializable transactions, so the second request re-reads the updated
count and is refused. What the emulator cannot show is the production abort-and-retry path itself.

**Regression floor (vs `85e71a1`):** **50/50 identical**. That is the 49 Q0c-1 suites plus `test-admin-user-messaging`
(101/0), which references `posSendSMS`. `test-notify-booking-types` needs `node_modules` at a fixed path; with the
repository's `node_modules` temporarily linked into both worktrees (git-ignored, removed afterwards, target untouched)
it is **ALL 9 PASSED on both trees**.
**Gates:** `predeploy-syntax-gate` exit 0.

## Production impact (read-only census, 2026-09-27)

- `posSendSMS` is deployed, and its only client already sends a payload the old handler ignored. No legitimate
  production path depended on the relay.
- There are **0** `posSendSMS` audit rows.
- The new contract has **no caller yet**. The client repair is its own unit.

## Boundaries and findings (NOT fixed here)

- **The `pos-modules.js` client contract** (it sends `{phones, message, businessId}`): a separate client unit, as with
  2d.
- **Q0c-3:** `sendPOSReceipt` (SMS and email together).
- **Main's rules do not guard `users.roles`** (recorded at Q0c-1).
- **Notification delivery certification:** a separate workstream after Q0c.
- **Not deployed.**

## L-8 port onto the POS lineage (2026-09-28)

Q0c-2 (a63f6de) is ported with Q0c-3 as reconciliation unit **L-8**, on base `cdd6170` (L-7). See
[[POS-Q0c3-pos-receipt]], [[POS-Q0b1-customer-scope]] and [[POS-Q0b2b-customer-insights]].

- **Clean and line-for-line.**
  - `functions/pos-merchant-sms.js` and `scripts/test-q0c2-pos-send-sms.js` are byte-identical to a63f6de.
  - The `functions/index.js` hunk (the inline relay replaced by a named re-export) applies unmodified to this lineage's differing
    `index.js`.
  - `sokoni-at.js` is byte-identical.
  - The merchant proof is L-7's `_provenCustomerOwners`.
- **Nothing is sent by the suite.** Africa's Talking is stubbed in-process, and the suite refuses to run otherwise. The
  evidence is **authorization to attempt** a send; it is not delivery. Delivery certification remains its own workstream.
- **The client is unchanged, and so is its state.** `pos-modules.js` still sends `{phones, message, businessId}`. The old handler never
  read that shape either, so no working path is broken. The client repair stays a separate unit.
- **Quota storage:** the repo rules and the last fetched served-rules copies have no rule matching
  `smsMerchantQuota`, and no root wildcard, so the collection is server-only. The live ruleset is re-fetched before any deploy.
- **Evidence:**
  - 20/0 on the port vs 3/17 on `cdd6170`, the same profile as the main line.
  - 8 of 8 source mutants are caught. **However**, the Q0c-3 note above shows the source `quota-not-transactional` mutant was malformed.
    The corrected mutant, run on this port, is caught in **4 of 5 runs** (Q-2) and survived 1.
    - The quota IS transactional in code (read and reservation inside one `runTransaction`), and Q-1 catches its removal
      every time.
    - Q-2's concurrency proof is probabilistic, not deterministic.
    - **Closed in L-8 by `scripts/test-l8-q0c2-quota-concurrency.js`** (owner-directed; Q-2 itself is not edited).
      A one-shot barrier holds every `smsMerchantQuota` reader, whether it reads through a transaction or directly, until all
      have read. This forces the race.
      - A POSITIVE CONTROL proves the barrier breaks a non-transactional read-then-write: both requests pass the check.
      - The real handler holds the invariant under the forced race:
        - T-1: two requests of 30 at 450/500 → one served, the day at 480, **30 sends**;
        - T-2: three requests of 20 at 460/500 → two served, the day at 500, **40 sends**.
      - Results: the real handler is **4/0 in 5 of 5 runs**. The corrected non-transactional mutant is **2/2 in 5 of 5 runs**: T-1 and T-2 are red, 60 sends went out, and
        the counter read 480 because of a lost update. The counter alone would have hidden the breach, so the test counts sends.
      - No production quota code was changed.
- **Not deployed.**
