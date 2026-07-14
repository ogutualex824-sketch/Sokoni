# Auth Gate Validation — RVS v1.0

**Gate:** `auth`  
**Required state:** 🟢 VERIFIED  
**Current state:** 🟡 ENGINEERING COMPLETE  
**Roles to validate:** buyer · merchant · provider · driver · employer · administrator  
**Register:** `release-gates.json`  
**Enforced by:** `scripts/test-rvs.js`

---

## Pre-conditions

1. The platform is deployed and `mysokoni.co.ke` is live.
2. `auth.mysokoni.co.ke` custom authDomain is active in Firebase Hosting
   and listed in Firebase Auth → Authorized domains (see CHANGELOG 2026-07-14).
3. You have test accounts for all 6 roles (or can create them during the session).
4. You have a physical iPhone and one Android device available.
5. Service worker is the latest version — check the banner at the top of validation.html.

---

## Session Setup

Open the validation session on your primary test device:

```
https://mysokoni.co.ke/login.html?validate=1
```

This sets `localStorage.sokoni_validate = '1'` and activates trace capture across
all CF calls for the rest of the session on that device. Every event is captured
with a Trace ID. Keep the trace ID — you need it in the evidence block.

To view the running trace: `https://mysokoni.co.ke/validation.html`

---

## Test Matrix

Run each row on a **physical iPhone (Safari)** and verify on one Android device.
Record pass/fail, any errors, and the trace events from validation.html.

### A. No-error page load (P0 regression check)

| Step | Action | Expected |
|---|---|---|
| A1 | Open `login.html` fresh (no prior auth) on iPhone Safari | No error banner visible before touching anything |
| A2 | Open `login.html` in Safari Private mode | No error banner |
| A3 | Open `login.html` after a previously failed/cancelled Google sign-in | No error banner |

**Fail condition:** Any error banner visible before the user taps a button.  
This is the P0 that was fixed — if it reappears, the gate fails.

---

### B. Email / password sign-in (role: buyer)

| Step | Action | Expected |
|---|---|---|
| B1 | Enter valid email + password, tap Sign In | `[AUTH STEP 1]` log entry visible in console |
| B2 | Wait for Firestore profile load | `[AUTH STEP 4] Firestore profile loaded OK` |
| B3 | Observe redirect | Lands on `index.html` within 1.5 s |
| B4 | Check localStorage | `loggedIn === "true"`, `sokoniUser` has `roles: ["buyer"]` |
| B5 | Open validation.html | Trace shows `loginUser → signInWithEmailAndPassword → Firestore getDoc → redirect` |

---

### C. Google sign-in — popup path (iPhone Safari, non-PWA)

| Step | Action | Expected |
|---|---|---|
| C1 | Open `login.html?validate=1` on iPhone in regular Safari | No error banner on load |
| C2 | Tap "Continue with Google" | Google sign-in popup opens (or redirect if ITP forces fallback) |
| C3 | Complete Google sign-in | Returns to login.html |
| C4 | Observe result | "Signed in with Google! Taking you home…" message, then redirect to index.html |
| C5 | Check localStorage | `loggedIn === "true"`, `sokoniUser.provider === "google"` |
| C6 | Open validation.html | Trace shows `getRedirectResult → sokoniGoogleRedirectDone → _handleGoogleResult → redirect` |

**If popup was blocked or ITP-triggered redirect:** The fallback path fires
`signInWithRedirect`, the user goes to Google, returns to login.html, and
`getRedirectResult()` resolves normally (now that `authDomain` is `auth.mysokoni.co.ke`).
Confirm trace shows the redirect path completed.

---

### D. Google sign-in — PWA / standalone mode (iPhone)

| Step | Action | Expected |
|---|---|---|
| D1 | Install the PWA (Safari → Share → Add to Home Screen) | PWA installs |
| D2 | Open from home screen, navigate to login | Running as standalone — `window.navigator.standalone === true` |
| D3 | Tap "Continue with Google" | Redirect flow fires (not popup — `_isPopupSupported()` returns false for standalone) |
| D4 | Complete Google sign-in | Returns to login.html via redirect |
| D5 | Observe result | Same as C4 above |

---

### E. Role-specific redirects

Create or use accounts for each role below. Sign in and verify the redirect destination.

| Role | Account type | Expected redirect |
|---|---|---|
| buyer | Regular user | `index.html` |
| merchant | Seller account (`registeredAs.seller = true`) | `seller.html` |
| provider | Service provider | `index.html` (hub selection) |
| driver | Driver account (`registeredAs.driver = true`) | `driver.html` |
| employer | B2B employer | `index.html` |
| administrator | Admin role (`roles: ["admin"]`) | `admin.html` |

For each: check `localStorage.sokoniUser.roles` matches the account type.

---

### F. Session persistence

| Step | Action | Expected |
|---|---|---|
| F1 | Sign in, close browser tab, reopen `mysokoni.co.ke` | Still signed in — `loggedIn === "true"` |
| F2 | On login.html while already signed in | `sokoniAuthReady` fires → immediate redirect (no form shown) |
| F3 | Sign out via profile menu | `loggedIn` removed from localStorage, Firebase session cleared |
| F4 | Reload `mysokoni.co.ke` after sign-out | Not signed in, login prompt shown |

---

### G. Error path validation

| Step | Action | Expected |
|---|---|---|
| G1 | Wrong password | "Wrong email or password. Try again." (not generic) |
| G2 | Non-existent email | "Wrong email or password. Try again." (same — no account enumeration) |
| G3 | Cancel Google sign-in popup | No error shown, button resets to "Continue with Google" |
| G4 | App Check on localhost without pinned token | `auth/network-request-failed` surfaces correctly |

---

## Capturing Evidence

After completing the matrix, capture the following and paste into `release-gates.json`:

```json
"evidence": {
  "timestamp": "2026-07-14T__:__:00+03:00",
  "traceId": "SVL-____________",
  "operator": "Alex Ogutu",
  "environment": "production — mysokoni.co.ke",
  "duration": "__ minutes",
  "logs": "browser console screenshots attached",
  "screenshots": [
    "A1 — no error banner on load",
    "C4 — Google sign-in success",
    "D5 — PWA redirect sign-in success",
    "E — role redirect table completed",
    "F1 — session persistence after tab close"
  ],
  "cfResult": "getRedirectResult resolved; onAuthStateChanged fired; Firestore profile loaded",
  "dbChange": "users/{uid}.lastLogin updated; loggedIn=true in localStorage",
  "userVisibleResult": "Signed in with Google / email. Redirected to correct destination for role."
}
```

Then set `"state": "verified"` and `"rolesVerified": ["buyer","merchant","provider","driver","employer","administrator"]`.

Run `node scripts/test-rvs.js` — it will verify evidence is non-empty before accepting VERIFIED.

---

## Go / No-Go

This gate moves to 🟢 VERIFIED only when:

- All A–G rows pass on iPhone Safari
- All 6 roles confirmed with correct redirects
- Evidence block is non-empty and committed to `release-gates.json`
- `node scripts/test-rvs.js` exits 0

If any row fails: set `"state": "failed"`, document `rootCause` and `regressionTest` in the register, and fix before retesting.
