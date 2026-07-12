# App Check

How SOKONI attests its web client, why the debug-token strategy is what it is, and how to fix the 403 that silently breaks authentication.

Related: [[Authentication]] · [[SECURITY]] · [[RELEASE_v1.0.0_GO_NOGO]]

---

## The one thing to know

**A failed App Check token blocks every Firebase Auth request *before it is sent*.**

When App Check cannot mint a token, the Auth SDK aborts the request in the browser — no `identitytoolkit` call is ever made. Sign-in, phone OTP and password reset all surface as:

```
auth/network-request-failed
```

which looks like a network problem and sends you hunting in the wrong place. It is not a network problem. **If every auth method fails at once with `network-request-failed`, check App Check first.** This was verified by A/B experiment: with App Check failing, `identitytoolkit` received *zero* requests; with App Check removed, the identical calls succeeded.

---

## How it works

| Environment | Attestation | Debug token |
|---|---|---|
| `localhost`, `127.0.0.1`, `[::1]` | debug provider | **required** — must be registered *and* pinned |
| `mysokoni.co.ke`, `www.mysokoni.co.ke`, `sokoni-aeb26.web.app` | **reCAPTCHA v3** | **never** — must not be present |

Both SDK paths are kept in lock-step:

- [`firebase.js`](../firebase.js) — modular SDK (most pages)
- [`sokoni-appcheck.js`](../sokoni-appcheck.js) — compat SDK (42 pages)

App Check is initialised **before** `getAuth()`. That ordering is deliberate and must not change.

---

## Why `FIREBASE_APPCHECK_DEBUG_TOKEN = true` is not a dev workflow

Setting the flag to `true` tells the SDK to **mint a brand-new random debug token**. That token is not registered with Firebase, so attestation returns:

```
403  App attestation failed.  (PERMISSION_DENIED)
```

and — per the section above — authentication dies with it.

The trap is that the token is stored per browser profile. Register it once and *your* browser works, so it looks fixed. But every **new profile, incognito window, teammate, CI run, and cleared-storage session mints a different token** and gets a fresh 403. It is a bootstrap mechanism, not a workflow.

**So: `true` is only ever used to print a token you are about to register. The pinned token is the workflow.**

---

## First-run setup (once per browser)

1. Load any page on `localhost`. The console shows a **FIRST-RUN BOOTSTRAP** warning, and Firebase prints a token:

   ```
   App Check debug token: 123e4567-e89b-42d3-a456-426614174000
   ```

2. Register it: **Firebase Console → App Check → Apps → *Sokoni website* → ⋮ → Manage debug tokens → Add debug token.** Give it a name you will recognise (e.g. `Alex — laptop`).

3. **Pin it** so it is reused and never regenerated:

   ```js
   localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', '123e4567-e89b-42d3-a456-426614174000')
   ```

4. Reload. The console should show:

   ```
   [SOKONI] App Check OK — token exchanged.
   ```

Once pinned, the token is used verbatim and is never overwritten or regenerated.

---

## Rotating a debug token

Rotate if a token leaks, a laptop is lost, or someone leaves the team.

1. **Firebase Console → App Check → Manage debug tokens → delete** the old entry. It stops working immediately.
2. In each affected browser, clear the pin and reload to bootstrap a new one:

   ```js
   localStorage.removeItem('SOKONI_APPCHECK_DEBUG_TOKEN')  // then reload
   ```
3. Register and pin the new token (steps above).

Tokens are per-developer. Never share one, and never commit one — a debug token bypasses App Check for the whole project. `scripts/verify-appcheck.js` fails the build if a token UUID is ever hardcoded.

---

## Troubleshooting HTTP 403

**Symptom:** `403 App attestation failed` on `exchangeDebugToken`, and/or every auth method failing with `auth/network-request-failed`.

Work down this list:

1. **Is a token pinned?**
   ```js
   localStorage.getItem('SOKONI_APPCHECK_DEBUG_TOKEN')
   ```
   `null` → you are on the bootstrap path. Register + pin the printed token.

2. **Is the pinned token actually registered?** Compare it against Firebase Console → Manage debug tokens. The console shows the *name* you gave it, not the secret — if you are unsure, delete it and re-bootstrap. The client prints `The pinned debug token is INVALID or NOT REGISTERED` in this case.

3. **Fresh profile / incognito / new machine?** Expected — each needs its own registered, pinned token.

4. **Are you actually on localhost?** The debug path only runs on `localhost`, `127.0.0.1`, `[::1]`. A LAN IP (e.g. `192.168.x.x`) takes the **production** path and will fail reCAPTCHA attestation. Use `localhost`.

5. **Still 403 on production?** Then it is reCAPTCHA, not the debug path. Check, in order:
   - the site key in `firebase.js` matches Firebase Console → App Check → reCAPTCHA v3;
   - the origin is on the reCAPTCHA key's **allowed domains** (the apex `mysokoni.co.ke` and `www.` are *separate* entries — listing only `www` will 403 the apex, and vice versa);
   - `minValidScore` (currently **0.5**) is not rejecting legitimate traffic.

---

## Do not try to verify production App Check with an automated browser

reCAPTCHA v3 scores traffic for bot-likeness, and the app rejects anything below `minValidScore` (**0.5**). **Headless *and* headed automation score below that**, so `exchangeRecaptchaV3Token` returns **403 non-deterministically** — it may pass one run and fail the next on the same URL.

This is a measurement artifact, **not** evidence of a broken deployment — and equally, **a passing automated run is not evidence that production works.** Treat every automated production attestation result as noise in both directions.

**Verify production by hand:** open the site in a normal browser → DevTools → Network → filter `firebaseappcheck` → confirm `exchangeRecaptchaV3Token` returns **200**, then sign in.

What *can* be checked automatically on production is that **no debug token is ever used** — `scripts/verify-appcheck.js --live` asserts exactly that, and nothing more.

A 403 never retries in a loop — the client probes once and reports. If you see the diagnostic, fix the cause; it will not resolve itself.

---

## Failure behaviour

| | Developer (localhost) | End user (production) |
|---|---|---|
| Message | Full diagnostic: reason, the offending token, exact remediation, link here | `Security verification failed. Please refresh and try again.` |
| Internals exposed | yes (intended) | **never** |
| Retries | one probe, no loop | one probe, no loop |

---

## Automated guard

```bash
node scripts/verify-appcheck.js          # static checks
node scripts/verify-appcheck.js --live   # + real browser check of production origins
```

It fails (exit 1) if a debug-token assignment is not localhost-gated, if a token UUID is hardcoded, or if any production origin sets a debug token or calls `exchangeDebugToken` — verified by loading the real pages under each production origin with a debug token deliberately pinned, and asserting it is ignored.
