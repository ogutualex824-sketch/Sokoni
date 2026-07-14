# Seller Dashboard — Authenticated QA Procedure

The Seller Dashboard **cannot be validated while signed out**. Unauthenticated, `seller.html`
redirects to `login.html`, so a headless run measures the login page and reports nothing
useful. Every visual finding in this document was taken from a real, signed-in session.

This is the repeatable procedure.

---

## Why the obvious approaches don't work

| Approach | Why it fails |
|---|---|
| Load `seller.html` headless | Redirects to `login.html` — you measure the login page |
| Stub `window.firebaseAuth` | The app signs the stub out; Firestore reads still fail |
| Sign in against **production** headless | App Check attests via reCAPTCHA v3, which **fails headless** → 403, and Firestore/Functions reject |

## The method that does work

Serve the real repo files on **localhost** and use an App Check **debug token**.

`sokoni-appcheck.js` honours `localStorage.SOKONI_APPCHECK_DEBUG_TOKEN` **only on localhost**.
Production still attests via reCAPTCHA v3 — the debug token does not work off localhost, so
**this does not weaken production App Check**.

### 1. Register a debug token (once)

Firebase Console → App Check → Apps → ⋮ → **Manage debug tokens** → Add.
Name it `sokoni-qa-localhost`. Copy the UUID.

(It can also be registered via the App Check REST API:
`POST https://firebaseappcheck.googleapis.com/v1/projects/sokoni-aeb26/apps/<APP_ID>/debugTokens`
— note the path is `/apps/`, **not** `/webApps/`.)

### 2. The QA seller account

| | |
|---|---|
| Email | `qa.seller.test@mysokoni.co.ke` |
| Purpose | Authenticated Seller Dashboard QA only |
| Marked | `users/{uid}.qaAccount = true` |

**A user cannot promote themselves to seller** — writing `role: "seller"` from the client is
`PERMISSION_DENIED`, which is correct and should stay that way. The QA profile was therefore
provisioned server-side (admin credentials), the same path a real back-office promotion takes.

### 3. Run

```
node scratchpad/qa-session.js     # signs in, opens the dashboard, screenshots
```

The harness:
1. serves the repo on `localhost` (with `cleanUrls`, like Firebase Hosting);
2. pins the debug token via `addInitScript` **before any page script runs**;
3. signs in with `signInWithEmailAndPassword`, forcing `browserLocalPersistence`
   (the app defaults to **session** persistence unless "Remember me" is ticked, and session
   persistence dies with the tab — this is why a second tab lands back on login);
4. navigates the **same page** to `seller.html` and waits for data.

### 4. Log out / clean up

`localStorage.clear()` + `firebaseAuth.signOut()`, or simply discard the browser context.

---

## Known limitations of this harness

- **Sign-in is throttled under repetition.** App Check returns
  `Requests throttled due to 403` after a burst, which surfaces as
  `auth/network-request-failed`. Space runs out, or the run silently measures the *login
  page* instead of the dashboard. **Always assert `location.pathname` contains `seller`
  before trusting any measurement.** Several runs during this sprint were discarded for
  exactly this reason.
- **Accepting the cookie banner reloads the page and drops the session**, so the
  "banner dismissed" steady state could not be measured in the same run.
- Headless Chromium reports `env(safe-area-inset-*)` as `0`. Safe-area behaviour therefore
  **cannot be verified here** — it must be checked on a physical device, or reasoned about
  from the CSS (see `scripts/test-safe-area.js`).

## A trap that already cost a false report

An early harness rewrote `location.href = "login.html"` into `void 0` to stop the redirect.
That produced `window.void 0` — a **syntax error** — so `seller.js` never parsed, and the
harness "proved" the POS button was dead when the harness was what was broken.

If you defuse the redirect, rewrite the **string literal**, keeping the statement valid:

```js
body.replace(/(['"])login\.html[^'"]*\1/g, '$1#stayput$1')
```

**Always assert `seller.js` actually executed** (`typeof window.postStory === 'function'`)
before believing a single thing the page tells you.
