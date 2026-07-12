# OAT — Notification Engine (v1.0 Release Gate)

**Status:** 0 / 7 PASSED
**Owner:** human tester. Not automatable.
**Related:** [[Communication Engine]] · [[Release v1.0.0]]

---

## Why these cannot be automated

Everything below has been verified in code and by static test (`scripts/test-notify.js`,
26 checks). **None of that proves a notification arrived.**

The defect this release fixes is precisely a case where the code looked correct, the
tests would have passed, the logs showed a successful send — and **no human being ever
received anything**, for as long as the feature had existed. `sendEachForMulticast()`
called with an empty token array returns success. It reports `successCount: 0` and no
error. Every dashboard stayed green.

So: a green log is not evidence. **A phone in a hand is evidence.** Do not mark any row
below as passed on the basis of terminal output, a Cloud Logging entry, code inspection,
or my say-so.

---

## Preconditions

- A real Android device and (ideally) a real iOS device. Not an emulator.
- Push permission **granted** in the browser on that device.
- Confirm a token actually exists before starting — otherwise you will be testing nothing:
  ```
  Firestore → users/{yourUid} → expect `fcmToken` (string) or `fcmTokens` (array)
  ```
  If both are absent, the device never registered. **Stop and fix that first** — every test
  below would "pass" silently against zero tokens, which is the exact bug we are fixing.

---

## The tests

| # | Test | Trigger | Expected on the device | Result |
| --- | --- | --- | --- | --- |
| 1 | **Merchant receives order notification** | Place a real order against a seller account you control | Seller's device shows "Order Received". Tapping it opens **that order**, not the homepage | ☐ |
| 2 | **Buyer receives payment notification** | Complete a real M-Pesa payment | Buyer's device shows "✅ Payment Confirmed". Copy says **SOKONI**, never Bravilex | ☐ |
| 3 | **Driver receives delivery notification** | Assign a rider to an order | Driver's device shows "Rider Assigned" | ☐ |
| 4 | **Wallet debit notification** | Spend from wallet balance | Device shows the debit. This is `critical` — it must arrive **even with all notification preferences switched off, and at 2am** | ☐ |
| 5 | **OTP delivery** | Request a login OTP | SMS arrives. Time it. It must arrive **during quiet hours too** — a user locked out at 11pm is the whole reason critical ignores preferences | ☐ |
| 6 | **Password reset** | Request a password reset | Reset message arrives and the link works | ☐ |
| 7 | **Notification arrives on a real device** | Any of the above, phone **locked, app closed** | The notification appears on the lock screen. Tapping it deep-links to the right screen | ☐ |

---

## Evidence to capture

For each row: **a photo or screen recording of the actual phone**, showing the notification.
A screenshot of a Cloud Logging entry is not evidence — that is precisely what was green
throughout the entire period in which push reached nobody.

Also record, per test:
- Device + OS version
- Seconds from trigger to arrival
- Whether the deep link opened the correct screen (test 1, 2, 7)

---

## Known-unproven (state honestly in the release report)

**Push delivery has never been confirmed on a real device — not once, before or after this
fix.** The token plumbing is now correct and guarded by tests, but *correct* and *arrived*
are different claims, and this subsystem has already demonstrated that the gap between
them can persist indefinitely without anyone noticing.

Until test 7 passes with a photograph attached, the honest status of push notifications on
SOKONI is **unverified**, not working.

---

## If a test fails

Do not reopen the token plumbing first — check in this order:

1. **Does a token exist for that uid?** (see Preconditions.) By far the most likely cause.
2. **Is the notification in `notifications` (in-app)?** If yes, the engine ran and push
   specifically failed — that is a token/permission problem, not an engine problem.
3. **Is there a row in `notifyLog`?** If not, `notify()` was never called — the *caller* is
   the bug, not the engine.
4. **`status: 'deduped'` in `notifyLog`?** The event was suppressed as a duplicate. Expected
   on a retry; a bug if the two notifications were genuinely different.
