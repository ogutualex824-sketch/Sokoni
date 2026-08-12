# Auth verification — activation runbook

**Related:** [[AUTH_EMAIL_VERIFICATION]] · [[Release Roadmap]] · [[Security]]

The implementation is complete and **enforcement is OFF**. This is the ordered procedure for
turning it on. Nothing here has been executed.

---

## The decision, recorded

**`CUTOFF_ISO` = the exact timestamp at which enforcement is intentionally activated.**

* Accounts created **before** it are grandfathered — they retain access, and nothing about
  their Firebase record is modified.
* Accounts created **at or after** it must complete email-code verification before they get
  an application session. The boundary is half-open `[cutoff, ∞)`.
* Google and phone accounts are exempt at any cutoff.
* Unknown or unparseable creation time is grandfathered.

**Not a historical date.** The measurement clustered in July and August, and picking one of
those months would convert a rollout policy into a retroactive restriction on accounts the
grandfathering decision exists to protect. `scripts/auth-activate-cutoff.js` refuses any
timestamp earlier than the measurement for exactly this reason.

**Not a guessed date committed in advance.** If `2026-08-20T00:00:00.000Z` is committed today
and the release happens on the 22nd, two days of signups are gated by a timestamp nobody chose
for them. **Set the cutoff immediately before the coordinated release.**

---

## Why the measurement-to-activation window is intentional

The production measurement ran on **2026-08-12**. Signups did not stop. Every password account
created between then and activation is also grandfathered, because it precedes the cutoff.

That is the policy working, not a leak: the grandfathered population at activation will be
**larger than the 87 measured**, by however many sign up in between. Those accounts still
receive the legacy verification link at signup — Slice 6C suppresses it only when an account
is actually gated — so they have a path to verification, they are simply not required to take
it. Shortening the window shrinks that set; it changes nothing about correctness on either
side of the line.

---

## Procedure

### 0 · Before the release window

```bash
node scripts/auth-activate-cutoff.js --check      # expect: both sentinel, enforcement OFF
```

### 1 · Set the cutoff — immediately before the release, not days ahead

```bash
node scripts/auth-activate-cutoff.js 2026-09-04T13:00:00.000Z            # dry, prints intent
node scripts/auth-activate-cutoff.js 2026-09-04T13:00:00.000Z --confirm  # writes BOTH files
```

One input, both files, or neither. The cutoff lives in two places because a functions deploy
uploads only `functions/` and the deployed code cannot require the client copy; hand-editing
two constants under release pressure is precisely where one gets missed.

The script refuses, always with a non-zero exit:

| input | why |
|---|---|
| `2026-09-04T13:00:00.000+03:00` | an offset is not UTC — local here is UTC+3 |
| `2026-09-04T13:00:00` | no zone at all |
| `2026-09-04T13:00:00Z` | no milliseconds |
| `2026-09-04 13:00:00.000Z` | space instead of `T` |
| two timestamps | ambiguous |
| `--confrm` and other unknown flags | a typo must fail, not run quietly as a dry-run |
| a historical timestamp | retroactive restriction |
| more than 90 days out | a sentinel wearing a real date |
| no `--confirm` | prints intent only |

**Deliberately strict about the zone.** Local time is UTC+3, so a wall-clock reading written
without an explicit zone is exactly the ambiguity that moves the cutoff by hours. The tool
rejects it rather than reinterpreting what an operator meant. The residual error is also
fail-safe: an EAT reading written with `Z` lands the cutoff three hours *later* than intended,
which grandfathers more accounts, never fewer.

### 2 · Pre-activation dry-run, with the real timestamp

```bash
node scripts/auth-cutoff-dry-run.js 2026-09-04T13:00:00.000Z
```

Must print **`STATE: ARMED`** and **`DRY-RUN CLEAN`**. It fails deliberately if the timestamp
you pass is not the one the files carry — a dry-run against a value that will not deploy
proves nothing.

### 3 · Full suite

```bash
node scripts/test-auth-verify-policy.js          node scripts/test-auth-policy-server.js
node scripts/test-auth-verify-gate.js            node scripts/test-auth-verify-screen.js
node scripts/test-auth-session-transitions.js    node scripts/test-auth-signup-gate.js
node scripts/test-auth-verify-landing.js

npx firebase emulators:exec --only firestore,auth \
  "node scripts/test-auth-email-challenge.js && node scripts/test-auth-dispatch.js"
```

### 4 · Commit

The cutoff change is its own commit, reviewed on its own. Reverting it is one line.

### 5 · Deploy — hosting AND functions, together

**Never the gate alone.** The gate without the screen strands every held user; the screen
without `authDispatch` gives them a code entry with no server to answer it.

```
hosting    sokoni-verify-policy.js · sokoni-verify-gate.js · sokoni-verify-screen.js
           sokoni-otp.js · auth.js · auth.css · firebase.js · login.html · signup.html
functions  authDispatch  (auth-dispatch.js · auth-policy.js · auth-email-challenge.js)
```

`authDispatch` is a **new** Cloud Function and has never been deployed. `sokoniChat`
(`db1789f`) is also pending. Deploy from the latest commit only — the predeploy guard aborts a
deploy whose tree is behind live.

### 6 · Post-deploy verification

* `curl -s https://mysokoni.co.ke/version.json` shows the deployed commit.
* `curl -s "https://mysokoni.co.ke/sokoni-verify-policy.js?cb=$RANDOM" | grep CUTOFF_ISO`
  shows the chosen timestamp, not the sentinel.
* Sign in with an existing account → straight through, no challenge.
* Create a new account → held, code arrives, verification completes, session granted.
* Re-run the population measurement and confirm `GATED under the live policy` matches
  expectation (near zero immediately after activation, rising only with new signups).

---

## Rollback

```bash
node scripts/auth-activate-cutoff.js --revert --confirm   # back to the sentinel
```

Then redeploy hosting and functions. Enforcement stops for everyone; no account is left in a
broken state, because nothing about any user record was ever modified — grandfathering is an
access policy, and `emailVerified` was never written except by a genuine code verification.

---

## Standing constraints

* `firestore.rules` stays at `ca9e8924`. Nothing in this work needs a rules change.
* No user record is modified at activation. `emailVerified` remains the only verification fact.
* Stories remain untouched and out of scope.
* The 66–67 legacy accounts keep access indefinitely until a separate re-verification campaign
  retires that state. `issue()` and `verify()` deliberately work for grandfathered accounts, so
  that campaign needs no new endpoint.
