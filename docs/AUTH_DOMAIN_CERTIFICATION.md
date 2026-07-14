# Firebase Authentication — Domain Certification & Production Gate

**Date:** 2026-07-14  
**Auth Domain:** `auth.mysokoni.co.ke`  
**Service Worker:** v74 (`sokoni-20260714-pos-router-v74`)  
**Certification Status:** ENGINEERING COMPLETE — CERTIFIED WITH PENDING PHYSICAL VALIDATION  
**Certification Owner:** Alex Ogutu  
**Validation Procedure:** [[AUTH_GATE_VALIDATION]]

---

## Legend

| Symbol | Meaning |
|---|---|
| ✅ Code Reviewed | Logic verified by reading source; no platform-specific risk identified |
| ✅ Confirmed | Externally confirmed by operator action (console, DNS check, Firebase console) |
| ⏳ Physical Device | Requires physical hardware; cannot be verified by code review alone |
| ❌ Not Applicable | This row does not apply to this environment |

---

## 1. Infrastructure Checklist

All pre-conditions for custom authDomain to function are confirmed.

| Step | Status | Evidence / Notes |
|---|---|---|
| `auth.mysokoni.co.ke` CNAME live in Cloudflare | ✅ Confirmed | DNS Only (not proxied); operator confirmed 2026-07-14 |
| SSL certificate provisioned on `auth.mysokoni.co.ke` | ✅ Confirmed | TLS active; operator confirmed via Firebase Hosting console |
| `/__/auth/iframe` responds correctly | ✅ Confirmed | Returns empty body — correct (scripts only load in iframe context) |
| `/__/auth/handler` reachable | ✅ Confirmed | Firebase Hosting serves `/__/` namespace on every custom domain automatically |
| `auth.mysokoni.co.ke` in Firebase Auth → Authorized Domains | ✅ Confirmed | Operator confirmed 2026-07-14 via Firebase Console |
| `sokoni-aeb26.firebaseapp.com` kept in Authorized Domains | ✅ Required | Existing sessions using the old domain must remain valid during rollout |
| Cloudflare proxy status on `auth.mysokoni.co.ke` | ✅ DNS Only — permanent | Orange cloud MUST remain off; proxying intercepts `/__/auth/handler` responses and can corrupt session-token delivery. Main `mysokoni.co.ke` can remain proxied. |

---

## 2. What the Custom Auth Domain Fixes

### Root Cause — Apple ITP Storage Partitioning

Firebase's default authDomain (`sokoni-aeb26.firebaseapp.com`) is a different registrable
domain from `mysokoni.co.ke`. Apple's Intelligent Tracking Prevention (ITP) partitions
storage by eTLD+1, treating `sokoni-aeb26.firebaseapp.com` as a third party when loaded
from `mysokoni.co.ke`. This blocked the Firebase auth iframe from accessing its own
cookies/IndexedDB, causing:

- `getRedirectResult()` threw `auth/internal-error` on **every page load** in iPhone Safari — even with no pending redirect
- The thrown error dispatched `sokoniGoogleRedirectError` → `auth.js` showed "An unexpected error occurred. Please try again." before the user touched anything

### The Fix

`authDomain = "auth.mysokoni.co.ke"` serves the Firebase auth handler from a subdomain
of `mysokoni.co.ke`. Because `auth.mysokoni.co.ke` and `mysokoni.co.ke` share the same
registrable domain, ITP treats the auth iframe as first-party. Storage partitioning no
longer applies.

### Defense in Depth

Even before the custom domain goes live, the `_redirectWasPending` guard in `firebase.js`
prevents the false error banner from firing. The custom domain is the definitive fix;
the guard is permanent defense-in-depth.

---

## 3. Code Audit — Line-Level Verification

### 3.1 `firebase.js` — Auth Initialization

| Check | Code Location | Status |
|---|---|---|
| `authDomain: "auth.mysokoni.co.ke"` | Line 57 | ✅ Code Reviewed |
| `getRedirectResult()` called on every page load via IIFE | Lines 358–401 | ✅ Code Reviewed |
| `_redirectWasPending` read from sessionStorage BEFORE `getRedirectResult()` call | Lines 359–360 | ✅ Code Reviewed |
| ITP noise suppressed when no redirect pending — no event dispatched | Lines 381–383 | ✅ Code Reviewed |
| Genuinely-pending redirect errors dispatched as `sokoniGoogleRedirectError` + `sokoniOAuthRedirectError` | Lines 397–398 | ✅ Code Reviewed |
| `auth/account-exists-with-different-credential` credential attached for linking flow | Lines 389–395 | ✅ Code Reviewed |
| `sokoniGoogleRedirectDone` and `sokoniOAuthRedirectDone` dispatched on success | Lines 368–370 | ✅ Code Reviewed |
| App Check initialized before `getAuth()` | Lines 111–119 | ✅ Code Reviewed |
| `sokoniAuthReady` event dispatched after Firestore profile loaded | Lines 438–444 | ✅ Code Reviewed |

**Silent error codes** (suppressed even when redirect was pending — known non-failures):
`auth/null-user`, `auth/no-auth-event`, `auth/operation-not-supported-in-this-environment`

### 3.2 `auth.js` — Sign-In Flow

#### Google Sign-In

| Check | Code Location | Status |
|---|---|---|
| `_isPopupSupported()` returns false for Standalone PWA and CriOS/FxiOS | Line 740+ | ✅ Code Reviewed |
| `browserLocalPersistence` set before redirect (honoring Remember Me) | Lines 950, 969 | ✅ Code Reviewed |
| `sokoniAuthRedirectPending` set before `signInWithRedirect()` | Lines 951, 972 | ✅ Code Reviewed |
| `sokoniAuthRedirectPending` cleared on redirect success | Line 991 (`sokoniGoogleRedirectDone`) | ✅ Code Reviewed |
| `sokoniAuthRedirectPending` cleared on redirect error | Line 1006 (`sokoniGoogleRedirectError`) | ✅ Code Reviewed |
| ITP popup errors (`auth/internal-error`, `auth/cors-unsupported`, `auth/web-storage-unsupported`) fall back to redirect | Lines 930–945 | ✅ Code Reviewed |
| `sokoniAuthRedirectPending` set in ITP popup fallback path | Line 951 | ✅ Code Reviewed |

#### Facebook / Universal OAuth (`_signInWithOAuth`)

| Check | Code Location | Status |
|---|---|---|
| `_isPopupSupported()` checked before popup | Line 1163 | ✅ Code Reviewed |
| `sokoniAuthRedirectPending` set before `signInWithRedirect()` in no-popup path | Line 1169 | ✅ Code Reviewed — **fixed 2026-07-14** |
| `sokoniAuthRedirectPending` set in popup-blocked fallback | Line 1174 | ✅ Code Reviewed — **fixed 2026-07-14** |
| `sokoniAuthRedirectPending` cleared on redirect success | Line 995 (`sokoniOAuthRedirectDone`) | ✅ Code Reviewed — **fixed 2026-07-14** |
| `sokoniAuthRedirectPending` cleared on redirect error | Line 1022 (`sokoniOAuthRedirectError`) | ✅ Code Reviewed |
| `auth/popup-closed-by-user` / `auth/cancelled-popup-request` — silent, no error shown | Lines 1178–1182 | ✅ Code Reviewed |
| `auth/account-exists-with-different-credential` — credential linking flow triggered | Lines 1176–1177 | ✅ Code Reviewed |
| ITP comment updated to reference `auth.mysokoni.co.ke` (not old domain) | Lines 730–731 | ✅ Code Reviewed — **fixed 2026-07-14** |

### 3.3 `sw-register.js` — SW Reload Guard During OAuth

| Check | Code Location | Status |
|---|---|---|
| `controllerchange` handler checks `sokoniAuthRedirectPending` before reloading | Lines 183–190 | ✅ Code Reviewed |
| Guard works for Google redirect round-trip | `auth.js` sets flag; `sw-register.js` reads it | ✅ Code Reviewed |
| Guard works for Facebook redirect round-trip | **Fixed 2026-07-14** — flag now set in `_signInWithOAuth` | ✅ Code Reviewed |
| Guard works for any future OAuth provider | Any call to `signInWithRedirect()` must set the flag first | ✅ Pattern established |
| SW registered with `updateViaCache: "none"` | Line 127 | ✅ Code Reviewed — SW file never served from HTTP cache |
| Stale FCM SW proactively unregistered from root scope | Lines 156–165 | ✅ Code Reviewed — prevents competing scope conflict |

### 3.4 `service-worker.js` — Cache Exclusions

**Cache inventory — confirmed auth content never cached:**

| Request type | Cache strategy | SKIP_CACHE_PATTERNS entry |
|---|---|---|
| `/__/auth/handler` | ⛔ Network Only (bypasses SW entirely) | `"/__/"` (line 314) |
| `/__/auth/iframe` | ⛔ Network Only | `"/__/"` (line 314) |
| `googleapis.com/identitytoolkit/*` (Sign-In API) | ⛔ Network Only | `"googleapis.com/identitytoolkit"` |
| `securetoken.googleapis.com/*` (Token refresh) | ⛔ Network Only | `"securetoken.googleapis.com"` |
| Any Firebase SDK URL (`firebaseapp.com`, `firebase*.js`) | ⛔ Network Only | `"firebase"` |
| OAuth redirect callback (POST) | ⛔ Never intercepted | SW only intercepts `GET` (line 370) |
| Firebase IndexedDB session storage | ⛔ Not managed by SW | Firebase SDK owns this storage |
| Firebase Auth tokens / cookies | ⛔ Not cached | HTTP-only cookies / IndexedDB; SW has no access |

**Auth-critical scripts — Network First (always delivered fresh):**

| Script | ALWAYS_FRESH | Notes |
|---|---|---|
| `firebase.js` | ✅ Line 432 | Auth fixes deploy immediately |
| `auth.js` | ✅ Line 432 | Sign-in logic always current |
| `session-manager.js` | ✅ Line 432 | Session state always current |
| `shared-header.js` | ✅ Line 428 | Injected on every page |
| `sw-register.js` | ✅ Line 428 | Reload guard always current |

**Conclusion:** No authentication tokens, OAuth callback responses, session identifiers,
or sensitive headers are stored in any SW cache. The auth pipeline is end-to-end
network-only.

---

## 4. Bugs Fixed During This Audit Cycle (2026-07-14)

### BUG-AUTH-1 — P0: False error banner on iPhone Safari before user interaction

**File:** `firebase.js`  
**Cause:** `getRedirectResult()` IIFE threw `auth/internal-error` (ITP blocking the
`firebaseapp.com` iframe) on every iOS page load. The error was dispatched as
`sokoniGoogleRedirectError` even when no redirect was pending → `auth.js` showed
"An unexpected error occurred. Please try again." before the user touched anything.  
**Fix:** Read `sokoniAuthRedirectPending` from sessionStorage before calling
`getRedirectResult()`. If absent, log the error but do not dispatch any event.  
**Committed:** `1e04e82`

### BUG-AUTH-2 — P2: Facebook redirect missing `sokoniAuthRedirectPending` flag

**File:** `auth.js` — `_signInWithOAuth()`  
**Cause:** The flag was set before Google redirects but NOT before Facebook redirects.
Two consequences: (1) if a SW update fired during a Facebook OAuth round-trip,
`sw-register.js` would reload mid-exchange and lose the redirect result; (2) if
`getRedirectResult()` threw on return from Facebook redirect, `firebase.js` would suppress
the error silently instead of surfacing it.  
**Fix:** Added `sessionStorage.setItem('sokoniAuthRedirectPending', '1')` before both
Facebook `signInWithRedirect()` calls (no-popup path at line 1169; popup-blocked
fallback at line 1174).  
**Committed:** in the cert stabilization commit 2026-07-14

### BUG-AUTH-3 — P2: `sokoniOAuthRedirectDone` did not clear the pending flag

**File:** `auth.js`  
**Cause:** After a successful Facebook redirect, `sokoniAuthRedirectPending` remained set
in sessionStorage. On the next SW `controllerchange` event (any subsequent deploy), the
reload guard suppressed the reload → users would not receive SW updates after a Facebook
sign-in until they next navigated.  
**Fix:** Added `sessionStorage.removeItem('sokoniAuthRedirectPending')` to the
`sokoniOAuthRedirectDone` event listener (line 995).  
**Committed:** in the cert stabilization commit 2026-07-14

### BUG-AUTH-4 — P4: ITP comment referenced old authDomain

**File:** `auth.js` (comments at lines 730–731 and 940–943)  
**Cause:** Explanatory comments described the ITP scenario as
`sokoni-aeb26.firebaseapp.com → mysokoni.co.ke`. With the custom authDomain active this
is no longer the scenario.  
**Fix:** Updated both comments to reference `auth.mysokoni.co.ke` correctly.

---

## 5. Cross-Platform Compatibility Matrix

### Sign-In Methods

| Platform | Google Sign-In | Facebook Sign-In | Email/Password | Phone OTP | Logout | Re-Login |
|---|---|---|---|---|---|---|
| Windows — Chrome | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed |
| Windows — Edge | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed |
| Android — Chrome | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed |
| Android — PWA (installed) | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed |
| iPhone — Safari | ⏳ Physical Device | ⏳ Physical Device | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ⏳ Physical Device |
| iPhone — Safari Private | ⏳ Physical Device | ⏳ Physical Device | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ⏳ Physical Device |
| iPhone — PWA (installed) | ⏳ Physical Device | ⏳ Physical Device | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ⏳ Physical Device |
| iPad — Safari | ⏳ Physical Device | ⏳ Physical Device | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ⏳ Physical Device |

### Session Persistence

| Platform | Session survives tab close | Session survives app background | Session survives browser restart | PWA launch from home screen |
|---|---|---|---|---|
| Windows Chrome | ✅ Code Reviewed | ❌ N/A | ✅ Code Reviewed | ❌ N/A |
| Android Chrome | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ❌ N/A |
| Android PWA | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed |
| iPhone Safari | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ❌ N/A |
| iOS PWA | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device |

### Service Worker Interaction During Auth

| Scenario | Expected Behaviour | Status |
|---|---|---|
| SW update fires while OAuth redirect is in-flight | Reload suppressed — `sokoniAuthRedirectPending` flag prevents `controllerchange` reload | ✅ Code Reviewed |
| SW update fires after successful OAuth, before flag cleared | Cleared immediately in `sokoniGoogleRedirectDone` / `sokoniOAuthRedirectDone` handlers | ✅ Code Reviewed |
| No pending redirect on page load (normal case) | `getRedirectResult()` → null, no event dispatched | ✅ Code Reviewed |
| ITP throws on page load, no pending redirect | Error swallowed silently — no banner | ✅ Code Reviewed |
| ITP throws during a real redirect return | Error dispatched → user sees actionable error message | ✅ Code Reviewed |
| Network lost during redirect | `getRedirectResult()` throws `auth/network-request-failed` → user sees "Check your internet connection" | ✅ Code Reviewed |
| User cancels Google OAuth popup | `auth/cancelled-popup-request` — no error shown, button resets | ✅ Code Reviewed |
| Popup blocked by browser | Falls back to `signInWithRedirect()` | ✅ Code Reviewed |
| iOS popup fails (ITP) | `_isItpError` catch path → fallback to redirect | ✅ Code Reviewed |

### Role-Specific Redirect Map

| Role | Firestore `roles` field | Expected landing page |
|---|---|---|
| buyer | `["buyer"]` | `/` (index.html) |
| merchant | `registeredAs.seller = true` | `/seller` |
| provider | `registeredAs.provider = true` | `/` (hub selection) |
| driver | `registeredAs.driver = true` | `/driver` |
| employer | `registeredAs.employer = true` | `/` |
| administrator | `roles` includes `"admin"` | `/admin` |

All redirect logic lives in `auth.js` `_handleGoogleResult()` → `_finaliseLogin()`. Code reviewed — role map correct.

---

## 6. Physical Device Test Plan

Execute the following on a **physical iPhone** (iOS 16 or later, Safari). Connect iPhone to Mac via USB and open Safari Web Inspector for console access.

### Pre-Test Setup

```
1. Clear Safari website data: Settings → Safari → Clear History and Website Data
2. Open: https://mysokoni.co.ke/login?validate=1
   (sets localStorage.sokoni_validate = '1' — activates trace capture)
3. Confirm SW version in console matches "sokoni-20260714-pos-router-v74" or later
```

### Test Sequence

| ID | Action | Pass Condition | Fail Condition |
|---|---|---|---|
| A1 | Open `login.html` fresh (no prior auth), Safari | No error banner before touching anything | Any error banner visible |
| A2 | Open `login.html` in Safari Private mode | No error banner | Any error banner |
| A3 | Open `login.html` after a previously cancelled Google sign-in | No error banner | Any error banner |
| B1 | Tap "Continue with Google" in regular Safari | Popup opens OR redirect fires (both are correct) | Nothing happens / error shown |
| B2 | Complete Google sign-in | "Signed in with Google! Taking you home…" → redirects | Error shown / stuck |
| B3 | Open `validation.html` | Trace shows `getRedirectResult → sokoniOAuthRedirectDone → Firestore profile loaded → redirect` | Trace shows error events |
| B4 | Check console | No `auth/internal-error`, no `auth/web-storage-unsupported` | Any of these codes appear |
| B5 | Check Safari Privacy Report | No blocked requests from `auth.mysokoni.co.ke` | Blocked cross-site requests listed |
| C1 | Install PWA (Share → Add to Home Screen) | Installs | Install fails |
| C2 | Open PWA from home screen → go to login | Redirect flow fires (popup suppressed for standalone) | Popup fires; error on return |
| C3 | Complete sign-in via redirect | Returns to app, user authenticated | Error or blank screen |
| D1 | Sign in, close Safari completely, reopen | Still signed in | Signed out |
| D2 | Sign in, background app 10 min, foreground | Still signed in | Signed out |
| D3 | Sign out → sign in with same account | Completes cleanly | Error or duplicate account |
| E1 | Sign in with Facebook on iPhone | Popup or redirect completes cleanly | Error shown |
| E2 | After Facebook sign-in, close and reopen | Still signed in | Signed out |
| F1 | Wrong password | "Wrong email or password. Try again." | Generic error or raw Firebase code |
| F2 | Cancel Google popup | No error banner; button resets | Error shown or button stuck |

### Recording Results

After testing, fill in the evidence block in `release-gates.json`:

```json
"evidence": {
  "timestamp": "2026-07-14T__:__:00+03:00",
  "traceId": "SVL-____________",
  "operator": "Alex Ogutu",
  "environment": "production — mysokoni.co.ke",
  "devices": [
    "iPhone [model] — iOS [version] — Safari [version]",
    "Android [model] — Android [version] — Chrome [version]"
  ],
  "duration": "__  minutes",
  "logs": "Safari Web Inspector screenshots attached",
  "screenshots": ["A1 no-error", "B2 Google success", "C3 PWA redirect", "D1 session persistence"],
  "cfResult": "getRedirectResult resolved; onAuthStateChanged fired; Firestore profile loaded",
  "dbChange": "users/{uid}.lastLogin updated; loggedIn=true in localStorage",
  "userVisibleResult": "Signed in with Google on iPhone Safari. No ITP error observed. PWA session persisted."
}
```

Then set:
```json
"state": "verified",
"rolesVerified": ["buyer", "merchant", "provider", "driver", "employer", "administrator"]
```

Run `node scripts/test-rvs.js` — the build passes only when evidence is non-empty.

---

## 7. Known Limitations

| Limitation | Severity | Impact | Mitigation |
|---|---|---|---|
| Physical device tests not yet executed | P0 (gate blocker) | Cannot claim ITP fix verified without iPhone evidence | Schedule device session before Phase 0 go-live |
| Android WebOTP API disabled | Low | Autofill suggestion not triggered on Android | WebOTP wired and feature-detected; fires when Firebase SMS template adds `@host #code` suffix — out of scope for this sprint |
| CriOS (Chrome on iOS) uses redirect flow | Expected | Popup API unavailable in CriOS/FxiOS | `_isPopupSupported()` returns false for these browsers; redirect flow confirmed in code |
| Facebook OAuth requires `facebook.com` App Review for production scopes | External | `email` + `public_profile` are basic scopes but do require App verification | Verify Facebook App is not in test mode before Phase 0 |
| `sokoni-spotlight.js` uses a separate Firebase project | By design | Spotlight search uses a different Firebase project (`AIzaSyBmPL3mFJXFN3LXY_gPuH2HSJY8oWmyOJ4`); not updated to `auth.mysokoni.co.ke` | Spotlight does not do auth — no change needed |
| Cloudflare must remain DNS Only for `auth.mysokoni.co.ke` | Operational | Proxying would intercept `/__/auth/handler` responses | Document this constraint in infra runbook; don't enable proxy |
| `sokoni-aeb26.firebaseapp.com` must remain in Authorized Domains | Operational | Existing sessions signed in via old domain need to remain valid | Keep old domain in the list permanently — no cleanup needed |

---

## 8. Deployment Instructions

### Pre-deploy checklist

- [ ] Firebase Hosting console shows `auth.mysokoni.co.ke` as **Connected** with green SSL indicator
- [ ] Firebase Auth → Settings → Authorized Domains contains `auth.mysokoni.co.ke`
- [ ] No other background `firebase deploy` process is running

### Deploy

```bash
firebase deploy --only hosting
```

### Post-deploy verification (desktop)

```
1. Open https://mysokoni.co.ke/login in a new incognito window
2. Open DevTools → Network tab → filter by "/__/"
3. Sign in with Google
4. Confirm: GET /__/auth/handler loads from auth.mysokoni.co.ke (not sokoni-aeb26.firebaseapp.com)
5. Check: no CSP violations in DevTools Console
6. Check: no auth/ error codes in console
```

---

## 9. Production Readiness Summary

| Dimension | Status |
|---|---|
| Custom authDomain configured in `firebase.js` | ✅ `auth.mysokoni.co.ke` — Committed |
| Custom authDomain propagated to all 54 secondary `initializeApp()` calls | ✅ Committed — 54 files, 0 remaining |
| DNS resolution | ✅ Confirmed by operator |
| SSL certificate | ✅ Active — confirmed by operator |
| Firebase Hosting serving `/__/` on auth subdomain | ✅ Confirmed |
| `auth.mysokoni.co.ke` in Firebase Auth Authorized Domains | ✅ Confirmed by operator |
| `sokoni-aeb26.firebaseapp.com` kept in Authorized Domains | ✅ Maintained |
| `frame-src` CSP updated to include `auth.mysokoni.co.ke` | ✅ `firebase.json` — Both enforce and report-only headers |
| Service Worker excludes `/__/` from all caches | ✅ Code Reviewed |
| `firebase.js` / `auth.js` / `session-manager.js` served Network First | ✅ Code Reviewed — `ALWAYS_FRESH` list |
| `sokoniAuthRedirectPending` flag pattern — Google | ✅ Code Reviewed |
| `sokoniAuthRedirectPending` flag pattern — Facebook | ✅ Fixed 2026-07-14 — Code Reviewed |
| SW reload guard during OAuth round-trip | ✅ Code Reviewed — covers all providers |
| ITP false-error banner suppression guard | ✅ Code Reviewed — defense-in-depth |
| 4 auth bugs identified and fixed | ✅ All committed |
| iPhone Safari ITP fix | ⏳ PENDING physical device validation |
| iOS PWA session persistence | ⏳ PENDING physical device validation |
| Facebook sign-in on iPhone | ⏳ PENDING physical device validation |
| Role-specific redirect matrix executed per-role | ⏳ PENDING physical device validation |

---

## 10. Phase 0 Launch Recommendation

**Recommendation: Conditional Go — one physical device session gates the auth RVS.**

The code is in the best shape it has been. All four auth bugs found during this audit are fixed. The custom authDomain is live. The service worker auth exclusions are verified. The pending-flag pattern now covers Google and Facebook. The false-error banner is suppressed at two independent layers.

**The single remaining gate is physical device evidence for iPhone Safari.** This is not a hedge — it is the specific environment the ITP bug lived in, and evidence of the fix working there is what moves the auth gate from ENGINEERING_COMPLETE to VERIFIED in `release-gates.json`.

**Recommended sequence before Phase 0:**

1. Run the 16-step test sequence in Section 6 on a physical iPhone (≤ 60 minutes)
2. Fill in the `release-gates.json` evidence block
3. Run `node scripts/test-rvs.js` — confirm the auth gate shows VERIFIED
4. `firebase deploy --only hosting`

Once the auth gate is VERIFIED, the overall verdict can move from NO_GO to a partial GO_WITH_CONDITIONS (payments gate remains NOT_EXERCISED — the first real transaction will be SOKONI's first money movement, and that is a separate gate).

**Do not launch before iPhone Safari is tested.** The prior P0 was exactly this scenario — an assumption about iOS that turned out wrong. Thirty minutes on a physical device is the proof.
