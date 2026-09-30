# SOKONI Secure Release — two-key withdrawals

**Status:** server implemented and committed locally on `feat/secure-release-on-45a837d`, based on 45a837d, the
deployed payout paid-state guard. **NOT deployed. NOT pushed.**
**Date:** 2026-09-30
**Related:** [[Payments]] · [[Wallet]] · [[IN_PROFILE_WALLET]] · FC-1 payout controls (45a837d, 4259b92, 61098e9)

## Owner decision

> "Admin approval authorizes the withdrawal. The wallet owner performs the final release. Money does not move until
> both approvals exist."

On 2026-09-30 the owner chose to build this on the 45a837d payout-guard line. It is merged into the convergence line
later, as one reviewed step.

## One withdrawal authority

Buyer, merchant-owner and provider personal wallets (`wallets/{uid}`) all withdraw through the **existing**
`requestSellerPayout`. Secure Release extends that authority and the **one** wallet PIN authority (`wallet-engine`).
No second payout path exists.

```
ACCOUNT (signed in)
   ↓
WALLET PIN ── requestSellerPayout: required, salted verifier, counted, locks at 5/hour
   ↓           amount RESERVED (balance − / pendingPayout +), status pending, nothing sent
ADMIN APPROVAL ── adminProcessPayout 'approved': moves NOTHING; records approval
   ↓                {amount, destinationKey, sellerUid, approvedBy, approvedAt, expiresAt (72h)}
OWNER RELEASE ── confirmPayoutRelease (PIN again) → owner_confirmed
   ↓
MONEY MOVES ── automatic (IntaSend B2C, M-PESA): approving → processing → paid, or outcome_unknown (never re-sent)
               manual (autoB2C off): SOKONI pays by hand; Mark Paid accepts ONLY owner_confirmed
```

### What the owner's release re-verifies (`confirmPayoutRelease`)

All of these are checked on the server, inside one transaction where it matters:

- the caller is signed in and the request is theirs (another person's request answers `not-found`);
- the request is a Secure Release request and is `approved`;
- the amount, destination and wallet **exactly match** the approval fingerprint, so a changed approval can never be
  released;
- the approval has not expired (expired → cancelled, funds returned);
- the destination is past its **cooling period** (default 24h from its first use; the refusal says until when);
- the wallet PIN is correct (through the one PIN authority, counted and locking);
- the wallet is not frozen or locked;
- the reserved funds still exist.

A repeat or concurrent release reports the current status and never authorizes or sends twice.

### States

| State | Meaning |
|---|---|
| `pending` | Requested with PIN; funds held; waiting for SOKONI review |
| `approved` | Admin approved (key 2); waiting for the owner; nothing sent |
| `owner_confirmed` | Owner released (key 3); SOKONI pays by hand (auto off). Admin may still decline. |
| `approving` → `processing` → `paid` | Automatic M-PESA disbursement (existing B2C path) |
| `outcome_unknown` | Provider answer unknown; funds held; resolved only with evidence (`adminResolvePayoutOutcome`) |
| `cancelled` | Owner cancelled before releasing; funds returned |
| `expired` | Approval not released in time (on release, or by the 30-minute sweep); funds returned |
| `rejected` / `failed` / `settled_manually` / `reversed` | Unchanged from 45a837d |

### Owner cancel

`cancelPayoutRequest` works from `pending` or `approved` only. After the owner's release, the withdrawal is SOKONI's
to complete or decline.

### Wallet PIN

- **Storage.** A salted **scrypt** verifier (`pinVerifier`: per-wallet random salt, N=16384). Comparisons are
  constant-time. The PIN itself is never stored.
- **Legacy PINs.** A legacy `sha256(pin+uid)` still verifies, and is **upgraded** to a verifier on its next
  successful use; the weak hash is then deleted.
- **Format.** 4–6 digits.
- **Changing an existing PIN** needs the current PIN, **or** a sign-in within the last 5 minutes (the "Forgot PIN"
  path: sign in again). A session alone cannot re-PIN the wallet.
- **Wrong PINs** are counted; 5 in an hour locks and freezes the wallet (existing behaviour, now used everywhere).

### Config (`config/payouts`, admin-only)

| Key | Default | Meaning |
|---|---|---|
| `secureRelease` | `true` | `false` restores the previous one-key flow (proven unchanged by SR18 and the 62-check outcome suite) |
| `releaseWindowHours` | 72 | How long the owner has to release after approval |
| `newDestinationCoolingHours` | 24 | Delay before a first-time destination can receive a release |
| `maxPerRequest` | 150000 | KES cap per request |

### Notifications (in-app via `notify`)

Every step is notified:

- requested (money held);
- ready to release ("No money has been sent yet");
- release confirmed;
- cancelled;
- not approved;
- expired;
- outcome being confirmed;
- paid and failed (existing).

## Evidence

| Check | Result |
|---|---|
| `scripts/test-secure-release.js` (SR1–SR18; transactional fake Firestore, counting fake B2C, SMS stubbed to throw) | 18/0 ×3 |
| Mutation controls | 15/15 caught |
| `test-payout-outcome-unknown` (one-key mechanics, config pinned `secureRelease:false`) | 62/0 |
| `test-payout-idempotency` | 11/11 |
| `test-admin-bulk-payout` | 14/0 |
| `test-payout-paid-status-guard` (Firestore emulator) | 26/0 |
| `scripts/test-secure-release-browser.js` (SB1–SB8; real Chromium, real wallet page, real callables) | 8/0 ×3 |
| UI mutation controls | 7/7 caught |
| `scripts/test-secure-release-admin-browser.js` (AdminOS + super-admin, real pages; write-trapping fixture) | 11/0 ×3 |

## The owner's side — the premium wallet (`wallet.html` + `sokoni-wallet-v2.js`)

- **Withdraw sheet**
  - "🔐 Protected by SOKONI Secure Release — your PIN, SOKONI's review, then YOUR final confirmation."
  - With no PIN, it shows "⚠ Wallet security incomplete — Set your Wallet PIN before withdrawing" and
    **Secure my wallet**; nothing is sent.
  - The button reads **🔐 Request release**. The PIN is always asked.
  - Success reads "Money held for you … Nothing is sent before you confirm".
- **Dashboard banner:** "🔐 Your money is ready to be released — … No money has been sent yet". It uses the server's
  list, never a guess.
- **Your withdrawals:** each Secure Release request has a timeline — Requested ✓ → Wallet PIN verified ✓ →
  SOKONI approved ✓ → **Waiting for YOUR confirmation** → Sent → Completed. An ended request says the funds are back.
  - When approved: **🔐 CONFIRM & RELEASE KSh X**, then "By confirming, you authorize SOKONI to release this exact
    amount to 07•• … Confirm before <expiry>", then the PIN, then the server.
  - Cancel is offered while pending or approved.
- **Changing a PIN** asks for the current PIN first, as the server now requires.
- **Notifications** deep-link to `wallet.html?open=payouts`.
- **PIN pad:** stays 4 digits, so existing users keep their PINs. The server accepts 4–6, so a 6-digit pad is a UI
  follow-up.

## The admin side — AdminOS + super-admin (ports the 4259b92 manual queue)

**AdminOS → Financial → Payouts** shows three queues, under a banner: "Approving sends NO money — the owner then
confirms the release with their PIN".

| Queue | Contents | Actions |
|---|---|---|
| Awaiting review | `pending` | Approve / Reject |
| 🔐 Approved — awaiting the owner's release | Approved Secure Release requests (reserved amount, destination, approval time, "owner must confirm by") | **Reject only**, never Mark Paid |
| Ready to pay — released by the owner | `owner_confirmed`, plus legacy approved requests from before Secure Release | Mark Paid (4259b92's evidence form: reference + attestation required; exactly one call; the server's recorded state is read back) / Reject |

Admin behaviour:

- **Approve** reports the server's answer: "Approved — no money was sent. The owner must now confirm the release with
  their PIN."
- **Reject** now calls the live `adminProcessPayout('rejected')`. It used to call the retired `finosRequestBankPayout`,
  so it always failed.
- **Mark Paid on an unreleased payout** is refused in the UI before any call, and on the server too.
- **The UI never writes Firestore.**

**super-admin:**

- Mark Paid is removed from pending rows and from gateway (ops) rows; the server refuses both.
- A "Released by the owner — ready to pay" list is added.
- Mark Paid asks for the reference and the attestation the server requires. It used to send neither, so every Mark
  Paid was refused.
- Reject sends a reason.

## Not done yet / known
- **Business wallet** (`businessWallets/{shopId}`, cents) has its own dormant draw path. It is not part of this
  authority yet.
- **Bank payouts** from the wallet page never send `bankCode` (a pre-existing client bug).
- **Deploy** needs the functions (`requestSellerPayout`, `adminProcessPayout`, `confirmPayoutRelease`,
  `cancelPayoutRequest`, `reconcilePayouts`, the wallet-engine PIN callables) and hosting. Each only on explicit
  owner authorisation, after the AR KEEP re-verification.
- **Deploy order:** the UI must ship with, or before, the server. Otherwise owners have no Release button and
  approved withdrawals simply expire (funds returned).
- `scripts/predeploy-payout-gate.js` reads **production** (read-only). `owner_confirmed` was added to its in-flight
  set, so holds are not misreported.

## Integration into `slice/c4-convergence` (2026-09-30)

Secure Release was built on `feat/secure-release-on-45a837d` (a556bd0 → c701224 → c1ecdb8). On the owner's
instruction it was brought onto the convergence line as **one reviewed integration step**.

**Not a branch merge.** A merge would have imported 25 unrelated POS-lineage commits, including the L-1…L-9 ports
and 6a/6b. Instead, each file was merged three ways (`git merge-file`) from the base that isolates only the payout
work:

| Files | Base | Why |
|---|---|---|
| `functions/wallet.js`, `wallet-engine.js`, `scripts/reconcile-payouts.js`, `scripts/test-payout-outcome-unknown.js` | 61098e9 | convergence already contains 61098e9, and 45a837d ported it before extending it |
| `sokoni-wallet-v2.js`, `wallet.html`, `sokoni-aos.js`, `super-admin.html`, `admin-os.html` | 8183694 | these carry the in-profile wallet work and convergence's own AdminOS changes, which are preserved |

Four files needed hand resolution:

| File | Resolution |
|---|---|
| `wallet-engine.js` | Both export blocks kept |
| `wallet.html` | The in-profile CSS and the Secure Release CSS both kept |
| `sokoni-wallet-v2.js` | Convergence's once-per-withdrawal idempotency key **and** the required PIN (the PIN is asked first, so a wallet without one never reserves a key). The `outcome_unknown` success message is kept alongside "Money held for you". |
| `sokoni-aos.js` | Rebuilt from convergence's file with the Secure Release AdminOS edit re-applied. Convergence's **Outcome unknown** section and Super Admin resolve form are kept below the new queues. |

**This carries 45a837d's paid-state guard onto convergence.** That guard is the deployed `adminProcessPayout` in
production. Deploying convergence's previous `wallet.js` would have removed it.

### What the integration adds on this line

- **Release notifications** deep-link to **`/profile.html#wallet:payouts`**: the profile Wallet tab, on "Your
  withdrawals". Profile's hosted wallet accepts `withdraw` and `payouts` actions, and the wallet has **one**
  deep-link handler, which runs after the user loads.
- **A deep link lands on the wallet.** It is scrolled into view. It previously opened on the profile header with the
  wallet 750px below.

### End-to-end proof

`scripts/test-secure-release-e2e-browser.js` runs the real profile page (hosted wallet) and the real AdminOS page
against the real callables and one database:

1. Owner requests with the PIN (money held).
2. AdminOS approves (no money sent; notification → `profile.html#wallet:payouts`).
3. The link opens "Your withdrawals" with the wallet in view; **CONFIRM & RELEASE** + PIN sends the payment
   **exactly once**; a repeat sends nothing; the provider's COMPLETED → paid → timeline Completed.
4. Manual mode: the owner releases; AdminOS "Ready to pay"; Mark Paid with evidence → settled_manually.

### One withdrawal UI (owner decision, 2026-09-30)

merchant-v2 Payments, the provider dashboard and `seller-earnings` withdraw from the **same** personal wallet
(`wallets/{uid}`). Their own forms had no PIN and no release step, so Secure Release would have refused them. Their
**Withdraw** buttons now open the one flow at **`/profile.html#wallet:withdraw`**. The merchant withdrawals list shows
the Secure Release states, and links an approved request to "Release it in your Wallet"
(`profile.html#wallet:payouts`). `seller-earnings`' old call was already malformed (`amountKES`/`phoneNumber`).

Two suites assert one-key behaviour. `test-withdrawal-browser` (premium-wallet idempotency, with a PIN) and
`test-creator-withdrawal` run with `config/payouts.secureRelease = false`, so "one provider execution per request"
stays measurable. The two-key flow is certified by `test-secure-release*.js`.
