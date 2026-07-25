# Authentication Validation Plan

Repo-specific execution guide for validating every SOKONI sign-in journey end
to end. This is **static prep** — it maps the implementation as it exists today
so runtime validation is a single pass once project access is restored. It
records **no PASS/FAIL verdicts**; every flow's Firestore-dependent portion is
**BLOCKED** until it can be observed under real production conditions.

Related: [[Authentication]] · [[APPCHECK_INVESTIGATION_PLAN]] · [[RELEASE_ACCEPTANCE]] · [[reference-local-browser-evidence]]

---

## The one fact that shapes every flow

App Check enforcement, observed live on the project (2026-07):

| Service | Enforcement | Consequence for auth |
|---|---|---|
| `identitytoolkit.googleapis.com` | **UNENFORCED** | The sign-in call itself (Google/phone/email) completes without an App Check token. |
| `firestore.googleapis.com` | **ENFORCED** | Every post-sign-in profile read/write needs a valid App Check token. |
| `firebasestorage.googleapis.com` | **ENFORCED** | Avatar/KYC uploads need a valid token. |

So a sign-in can **succeed at the Auth layer and still leave the user on a
broken page**, because `onAuthStateChanged` immediately reads `users/{uid}` from
Firestore ([firebase.js](../firebase.js) line 587+). That read is the boundary
between OBSERVABLE-NOW and BLOCKED-UNTIL-APPCHECK. Every flow below is split on
exactly that line.

Headless Chromium cannot pass reCAPTCHA v3, so any runtime run needs an App
Check **debug token** injected before init (see
[[reference-local-browser-evidence]] and `scripts/probe-provider-directory.js`
for the working harness). Without it, the Firestore-dependent half is BLOCKED,
not FAIL.

---

## Shared post-auth path (every flow funnels through this)

`onAuthStateChanged(auth, ...)` — [firebase.js](../firebase.js) L587:
1. `getDoc(doc(db, "users", user.uid))` — **Firestore, App Check ENFORCED**.
2. If the doc exists → load full profile into `localStorage` (source of truth);
   for Google users, merge `photoURL` if previously empty (`setDoc … {merge:true}`).
3. If it does **not** exist → dedup query by email
   (`query(collection(db,"users"), where('email','==',…))`), then create the
   authoritative profile (`setDoc(users/{uid}, {merge:true})`).
4. On failure: `console.warn('[SOKONI Auth] onAuthStateChanged: Firestore
   unreachable', …)` (L773) — this is the App-Check-denied branch.

**Required runtime evidence for the shared path** (applies to all flows):
- Network: the `users/{uid}` read returns 200 (not 403 App Check).
- `localStorage.sokoniUser` populated with the real profile.
- `sokoniAuthReady` / `__sokoniHasSignedIn` signal fired.
- No `Firestore unreachable` warning in console.

Status: **BLOCKED** until an App-Check-registered origin (deploy or debug token).

---

## Flow 1 — Email / Password sign-in

| | |
|---|---|
| Entry point | login form submit → [auth.js](../auth.js) L247 (`[AUTH STEP 2]`), core at L274–430 |
| Provider/API | `signInWithEmailAndPassword` (L287), preceded by `_setPersistenceFromUI()` (L274) |
| Cloud Functions | none directly |
| Firestore after auth | `getDoc(users/{uid})` (L303) → `SokoniSync.init` (L329) |
| Dependencies | App Check (Firestore read), Security Rules (`users` read), persistence choice |
| Expected redirect | `_safeRedir` — same-origin relative only, open-redirect blocked (L425–428); employee path → `seller.html?employee=1` (L395) |

**Observable now (identitytoolkit unenforced):** credential accepted/rejected;
wrong-password error surfaced; rate-limit/lockout behaviour.
**BLOCKED:** the `getDoc(users/{uid})` profile load and redirect landing.

Edge cases to exercise:
- Wrong password → error message, no redirect.
- Unknown email → error message.
- **Account-linking collision**: email already registered via Google →
  `auth/account-exists-with-different-credential` → `GoogleAuthProvider.credentialFromError` + `linkWithCredential` (L348–355). Verify the accounts link rather than dead-end.
- Persistence: "Remember Me" on → `browserLocalPersistence`; off → session only. Verify survival across refresh (see Flow 7).

Success: credential accepted **and** profile loaded **and** landed on `_safeRedir`.
Failure: any of those three missing when App Check is healthy.

---

## Flow 2 — Email / Password sign-up

| | |
|---|---|
| Entry point | signup form → [auth.js](../auth.js) L531 |
| Provider/API | `createUserWithEmailAndPassword` (L539) + `updateProfile` + `sendEmailVerification` |
| Firestore after auth | authoritative profile created by shared `onAuthStateChanged` path |
| Dependencies | App Check (profile write), email deliverability (verification mail) |

Observable now: account created; duplicate-email rejected
(`auth/email-already-in-use`); verification email dispatched.
**BLOCKED:** the `users/{uid}` profile **write** and first landing.

Edge cases: weak password rejection; duplicate email; verification-email
bounce; sign-up then immediate refresh before the profile write commits (does
the shared path recreate it?).

---

## Flow 3 — Google (popup + redirect fallback)

| | |
|---|---|
| Entry point | `onclick="signInWithGoogle()"` → [auth.js](../auth.js) L1040 |
| Provider/API | `GoogleAuthProvider`; **device-aware** (L789–848): Desktop / Android Chrome / regular iOS Safari → `signInWithPopup` (L1133); popup-blocked or ITP/security error, installed PWA, in-app browsers (CriOS/FxiOS) → `signInWithRedirect` |
| Redirect result | `getRedirectResult` → `_handleOAuthResult` (L927+); sets `sokoniAuthRedirectPending` so the Service Worker's `controllerchange` does **not** reload mid-round-trip |
| Firestore after auth | shared path; Google users get `firstName/lastName/photoURL/emailVerified` |
| Dependencies | App Check (Firestore), **Service Worker** (must not reload during redirect), persistence (`browserLocalPersistence` L1163/1182) |

Observable now: popup opens / redirect fires; consent; token returned.
**BLOCKED:** profile creation + landing.

Edge cases — these are the historically fragile ones:
- **Popup blocked** → must fall back to redirect, not dead-end (L820, L899).
- **In-app browser / PWA** → redirect path; verify `getRedirectResult` resolves on return.
- **SW `controllerchange` during redirect** → must be suppressed (guard exists in `sw-register.js`; `sokoniAuthRedirectPending`); verify no reload loop.
- Interrupted redirect (user closes tab mid-flow) → returns cleanly on retry.

---

## Flow 4 — Facebook

| | |
|---|---|
| Entry point | [auth.js](../auth.js) — `FacebookAuthProvider` (4 refs); same popup/redirect machinery as Google |
| Notes | Cross-provider linking shares the `linkWithCredential` path (Flow 1 edge case) |

Observable now: provider dialog. **BLOCKED:** profile load + landing.
Edge case: same email as an existing Google/password account → linking, not a
second account.

---

## Flow 5 — Phone / OTP

| | |
|---|---|
| Entry point | `sendPhoneOTP()` → [auth.js](../auth.js) L1550; verify `verifyPhoneOTP()` L1690 |
| Provider/API | `RecaptchaVerifier` → `signInWithPhoneNumber` → `_phoneConfirmResult.confirm(code)` (L1707) |
| Rate limits | client-side: 3 sends / 5 min / browser (`SokoniSecurity.persistentRateLimit`, L1569); 3 wrong codes → force resend (`_OTP_MAX_ATTEMPTS`, L1538) |
| App Check | OTP **send** does NOT need attestation — identitytoolkit is unenforced (explicit comment L1599) |
| Firestore after auth | shared path; success → `location.href='index.html'` (L~1722) |

Observable now (no App Check needed to send/verify OTP): SMS delivery; correct
code accepted; wrong code counter; resend; client rate-limit message.
**BLOCKED:** the post-verify profile load + landing.

Edge cases — the ones you named, mapped to code:
- **Expired OTP** → `confirm(code)` rejects with `auth/code-expired`; verify a
  clean "code expired, resend" message, not a raw error.
- **Wrong code ×3** → forced resend (L1538–1539).
- **Rate-limited send** → "Too many OTP requests" (L1570), not a silent failure.
- **Network drop between send and verify** → `_phoneConfirmResult` still valid on
  reconnect, or a clear re-request path.

---

## Flow 6 — Password reset

| | |
|---|---|
| Entry point | [auth.js](../auth.js) L744 |
| Provider/API | `sendPasswordResetEmail` (L748) |
| Dependencies | email deliverability only; no Firestore |

Observable now (no App Check dependency): reset email dispatched; unknown-email
handling (Firebase returns success regardless — verify the UI doesn't leak
account existence). Fully testable without project access.

---

## Flow 7 — Session persistence, idle timeout, sign-out

| | |
|---|---|
| Persistence | `_setPersistenceFromUI()` (L274) → `browserLocalPersistence` (Remember Me) vs `browserSessionPersistence` (L1409–1411) |
| Idle timeout | 60 min idle → `_signOutNow()` (L162) → `signOut` (L170) → `login.html?reason=idle` (L173) |
| Sign-out | `signOut(window.firebaseAuth)` clears session |

Observable now: persistence across refresh (local vs session); idle timer fires
sign-out; `?reason=idle` surfaced.
**BLOCKED:** post-refresh profile reload (Firestore).

Edge cases: session survival across **tabs** and across **devices** (local
persistence is per-browser, not cross-device — verify the UI claims match);
**revoked session** (admin disables the account) → next Firestore read denied,
verify graceful sign-out rather than a broken page.

---

## Flow 8 — Redirect handling & the loop guard

The recent redirect-loop fix ([auth.js](../auth.js) L24–99, commit `84a59f9`):
- Captures `?next=` / `?redirect=` into `sessionStorage` (L27–28).
- Validates same-origin relative path before `location.replace` (L71).
- Guards the `wallet → login?redirect=wallet → wallet → …` loop caused by
  `sokoni-wallet-v2.js`'s `onAuthStateChanged` redirecting on transient no-user
  (L76–99).

Test matrix: deep-link to a gated page while signed out → login → land back on
the intended page exactly once (no loop); already-signed-in visit to `login.html`
→ no redirect thrash; malformed/off-origin `?next=` → rejected.

---

## Execution checklist (run once access is restored)

For **each** flow record `PASS / FAIL / BLOCKED` with evidence, using the
`scripts/lib/gate-result.js` gate model (provenance-stamped):

1. Mint an App Check debug token (revoke after) — the Firestore half is
   unobservable without it.
2. Drive each flow in a real browser (harness: `scripts/probe-provider-directory.js`).
3. For each: assert the Auth-layer outcome **and** the shared post-auth path
   (users doc read/write 200, `localStorage.sokoniUser` populated, correct landing).
4. **Do not mark PASS** on any flow whose Firestore-dependent portion was not
   observed — that stays BLOCKED.
5. Capture network HAR + console for each run as evidence.

Suggested evidence file: `docs/release-gates/auth-<commit>.json` via the Gate
helper, one gate per flow, `evidence: production-probe`, `environment: production`.
