# Email Verification — server-controlled challenge

**Status:** Slices 1–5 complete, **not deployed**. Firestore rules unchanged (`ca9e8924`).
**Related:** [[Authentication]] · [[Security]] · [[Communication Engine]] · [[Release Roadmap]]

Replaces the old "you are logged in because you typed the right password" model with a
server-issued code that proves the account's email address belongs to whoever is signing in.

---

## The three layers

| Layer | File | What it owns |
|---|---|---|
| Model | `functions/auth-email-challenge.js` | the challenge document, its hash, its lifetime |
| Transport | `functions/auth-dispatch.js` | `authDispatch` — issue / verify / status, App Check enforced |
| Gate | `sokoni-verify-gate.js` | whether an unverified account gets an application session |
| Screen | `sokoni-verify-screen.js` | the challenge the held user actually answers |
| Transitions | `sokoni-verify-gate.js` (watcher) | keeping every tab on the current answer |

### Model — Slice 1

`authEmailChallenges/{uid}`, reachable only through the Admin SDK; there is no rule granting
client access and no `/{document=**}` catch-all in this ruleset, so a browser read is
default-denied.

* the code is stored **salted-SHA-256, never in plaintext**
* single use, enforced inside a `runTransaction` — two simultaneous correct guesses cannot
  both succeed
* `MAX_ATTEMPTS 5` · `TTL 10 min` · `RESEND_COOLDOWN 60 s` · `MAX_SENDS 5`
* comparison is `crypto.timingSafeEqual`
* failures return machine-readable `REASON` codes; the wording is the UI's business

### Transport — Slice 2

`authDispatch`, an `onCall` with `enforceAppCheck: true`.

**The uid is never a parameter** — it comes from `request.auth.uid`. **The email address is
never a parameter either** — it is read from the Firebase Auth record with the Admin SDK.
That second one is the whole attack: sign in with a stolen password, ask for the code to go
to an address you control, and the second factor is yours. The only address this will ever
send to is the one already on the account.

On success the Auth record is marked `emailVerified` by the Admin SDK. That is what makes
verification unforgeable — the flag lives on the Auth record, not in a profile document or a
cached blob, and no client call can produce it.

Two decisions worth remembering:

* **`category` is omitted from the mail.** `email-service._checkPreferences` maps an unknown
  category to `"account"` and returns false when that preference is off — a verification mail
  carrying a category would be silently dropped, locking a user out of their own account via
  a marketing toggle.
* **Rate limited per account AND per IP.** The shared `otp` profile is `byUid:false` and its
  identifier helper can resolve to the literal `'unknown'`. IP-only gives an attacker a fresh
  budget from every address while an office behind one NAT shares one; uid-only lets one
  machine spray many accounts. The shared limiter is called twice rather than replaced.

### Gate — Slice 3

One rule, one choke point: `onAuthStateChanged` in `firebase.js`, consulted **before** the
session flag is written.

The decision comes from the Firebase Auth `User` object and nothing else — never
`localStorage`, never the cached `sokoniUser`, never a client `verified` flag.

* **Refresh where it matters.** A cached `false` may be stale, so nobody is denied without a
  `user.reload()`. A cached `true` needs no reload — the flag only moves false → true — so
  verified users pay no round trip on any page load.
* **Fails closed**, which cannot lock out a verified user because they short-circuit before
  the reload.
* **Password accounts only.** Google/Facebook/Apple assert the address themselves; for a
  phone account the SMS *is* the factor and there is often no email at all.
* **Gated is not signed out.** The challenge is an authenticated call, so the Firebase
  session stays alive while the application session is dismantled.

Why the gate could not live in `auth-guard.js`: that file runs synchronously in `<head>` and
decides from `localStorage.getItem('loggedIn')`. It cannot reach Firebase. And the flag it
reads was written **unconditionally** by `firebase.js` on every page load — so withholding
the flag in the login path alone would have been undone milliseconds later.

**Coverage:** 46 of 48 `data-require-auth` pages. `dispute-portal.html` and
`fleet-monitor.html` load no Firebase at all and have never had authoritative auth on the
page — a pre-existing hole in the localStorage-only guard. `pos-v2.html` carries
`data-require-auth` but omits `auth-guard.js`; also pre-existing.

### Screen — Slice 4

The screen the gate hands off to. It talks to `authDispatch` and nothing else.

**Success is proven, never taken on trust.** `ok:true` means the server marked the record;
the screen then calls `user.reload()` and re-reads `emailVerified` before saying anything.
If the flag is not true it reports failure however encouraging the response looked — a screen
that celebrates and then drops the user back at the gate is the false-success defect class.

**Status before issue.** Opening does not send mail. The screen asks `emailChallengeStatus`
first and resumes a live challenge rather than reissuing, because the code already in the
inbox still works and reissuing would burn one of the 5 sends and start an unasked-for
cooldown.

Covers: code entry (reusing `SokoniOtp`), resend cooldown, invalid, expired, consumed,
attempt ceiling, send ceiling, loading, transport failure, `delivered:false`, and a back
path that signs out and returns to a clean login.

**Not a true change-email.** Changing the address on the Auth record needs a server op that
does not exist and was not authorised here; the back path leaves the account instead. A real
change-email belongs with the R1.1 profile work already on the roadmap.

### Session transitions — Slice 5

**The invariant:** application access is derived from *current* Firebase Auth state, never
from cached verification or session state.

The gate at `onAuthStateChanged` covers every page LOAD — refresh, typed URL, back/forward,
restored tab. It cannot cover an already-open tab, because Firebase fires that callback on
sign-in and sign-out, **not when `emailVerified` flips**. A second tab held at the challenge
would sit there forever after the user verified in the first one: verified, and still locked
out, with nothing on screen suggesting otherwise.

Closed with two triggers into `recheck()`, which asks Firebase: `storage` (another tab
announced a verification, or cleared the session flag) and `visibilitychange`. A verified
user short-circuits before any network call, so tab-switching costs nothing. A tab that
discovers it is no longer held **reloads**, so the session is built by the one existing path
rather than assembled a second, divergent way.

The screen announces only **after the refreshed token agreed** — announcing on the response
alone would turn one tab’s false success into several. `firebase.js` clears the marker and
tears the screen down on sign-out and on an account change, and the watcher takes a
**getter**, not a captured user: an account switch replaces the user, and a captured
reference would go on answering for the account that has left.

`recheck()` with no watcher installed now reports `{unknown:true}` and changes nothing. Not
knowing who is signed in is not the same as knowing nobody is.

---

## ⚠ Rollout risk — read before deploying

`auth.js:611` has always called `sendEmailVerification(cred.user).catch(function(){})` at
signup: **fire-and-forget, failures swallowed, and nothing ever enforced the result.** So the
existing population of password accounts contains an unknown — and probably large — number
with `emailVerified === false`, simply because nobody ever had to click the link.

Turning the gate on before the verification screen exists would hold every one of those
accounts at a challenge with **no way to answer it**. The gate is correct; the rollout order
is what matters:

1. **The gate and the screen deploy TOGETHER, never the gate alone.** Both now exist, so a
   held user gets a code and is through in under a minute — self-service, no support queue.
   Shipping `sokoni-verify-gate.js` without `sokoni-verify-screen.js` and the `login.html`
   mount recreates exactly the lockout this section warns about.
2. **Measure first.** Count `emailVerified === false` among password accounts in production
   before deploying, so the size of the affected population is a number and not a guess.
3. **If that number is large,** decide explicitly between grandfathering accounts created
   before a cutoff and holding everyone. That is a product decision, not an implementation
   detail, and it is deliberately not encoded in the gate.

---

## Testing

| Suite | Assertions |
|---|---|
| `scripts/test-auth-email-challenge.js` | 62 |
| `scripts/test-auth-dispatch.js` | 58 |
| `scripts/test-auth-verify-gate.js` | 117 |
| `scripts/test-auth-verify-screen.js` | 96 |
| `scripts/test-auth-session-transitions.js` | 100 |

The first two run against **real Firestore and Auth emulators**; only the email transport is
substituted, and only after module load, so the preference and address decisions are still
made by the real code. The last three run the shipped client files in a `vm` sandbox and carry
ten **mutation controls** between them — each breaks the code on purpose and requires the
answer to change, because a suite that only ever sees correct code cannot tell "this passes"
from "this asserts nothing". The sharpest of them deletes the screen`s `emailVerified === true`
proof and requires the mutant to celebrate a false success.

## Deployment

`authDispatch` is a **new Cloud Function** and needs a functions deploy when the gate opens
(alongside `sokoniChat`/`db1789f`). New Cloud Functions must be re-exported by name in
`functions/index.js` — done. No rules change, no index change, no hosting-only path.
