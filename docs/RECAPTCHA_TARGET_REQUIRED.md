# reCAPTCHA / App Check — TARGET REQUIRED, NO CODE CHANGE

**Status (2026-08-28, candidate `fix/admin-convergence`):** the App Check reCAPTCHA
configuration is **unchanged and left as reCAPTCHA v3**. No provider/key change was made
because inspection found **no authorized target** to change to.

## What is deployed / in the code (current, correct, enforced)
- `firebase.js`: `initializeAppCheck(app, { provider: new ReCaptchaV3Provider('6Lf93Tkt…nsxj'), isTokenAutoRefreshEnabled: true })` — **reCAPTCHA v3 classic**, one site key.
- `sokoni-appcheck.js` (compat): same key via `ReCaptchaV3Provider`.
- Debug token is **localhost-only** (`if (IS_LOCALHOST) self.FIREBASE_APPCHECK_DEBUG_TOKEN = …`); production uses reCAPTCHA v3 attestation with **no debug token**. **No bypass in production.**
- All three lineages (`a9d8dec`/`main`/`0a0d921`) are **byte-identical** on this config — no divergent "intended" App Check key exists in git. No `ReCaptchaEnterpriseProvider`, no `enterprise.js` anywhere.

## Why no change was made
Changing the provider or site key to a value not present in the code would break attestation
(App Check 403 → Firebase Auth fails). Per instruction, **do not weaken App Check**: no key
invented, no switch to Enterprise, no debug bypass, no fresh-session Enterprise checkbox
enabled. The current v3 config is preserved verbatim.

## Why "the intended reCAPTCHA change hasn't taken effect" — two possibilities to resolve SEPARATELY
- **A. Code is correct; console configuration hasn't propagated.** Then the resolution is on the
  Firebase/Google side, not in code: verify production App Check **enforcement**, the **registered
  reCAPTCHA key** for the production domains (`mysokoni.co.ke`, `sokoni-aeb26.web.app`), and domain
  registration. No code change here.
- **B. Intended replacement of v3 with reCAPTCHA Enterprise.** Then the **actual Enterprise site
  key must be provided/identified first**. Only then change `ReCaptchaV3Provider` →
  `ReCaptchaEnterpriseProvider` and load `enterprise.js`. Guessing the key would be dangerous.

## Not to be confused with
The **fresh-session gate** (`sokoni-appcheck-gate.js`, only on `0a0d921`) uses a reCAPTCHA
**Enterprise checkbox** for human verification on the auth gate — a **separate held feature**,
not this App Check attestation config, and **not enabled here**.

**Action item (owner):** provide the intended target (new key + provider) OR confirm this is a
console-side verification. Until then: **RECAPTCHA TARGET REQUIRED — no code change.**
