# Admin credential inputs — risk report

**Date:** 2026-08-02 · **Scope:** `newPin`, `newAdminPw`, `patternCanvasNew`
**Status:** audit only. **No authentication code was changed.**

Related: [[Three Security Layers]] · [[Admin Console Integrity]] · [[Standing Security Rules]]

---

## Severity depends entirely on what this lock protects — so establish that first

`admin.html` has **two independent gates**, and conflating them would make every finding below sound
either far worse or far better than it is:

| gate | mechanism | protects |
|---|---|---|
| **Firebase claim check** | `getIdTokenResult(true)` → `claims.admin \|\| claims.superAdmin`, plus `firestore.rules isAdmin()` | **all data.** Server-side, unaffected by anything in this report |
| **Manager lock** | PIN / pattern / password hashed into `localStorage` | **the console UI on this device** |

The second is the subject of this report. **It is a local convenience lock, not platform
authorization.** Defeating it reveals the admin console *shell*; every read and write inside still
requires a valid ID token carrying an admin claim, which the lock cannot grant.

That is the correct architecture, and it caps the blast radius of everything below. It does not make
the findings acceptable.

---

## Findings

### 1. Unsalted, single-round SHA-256 — **HIGH** (within the lock's scope)

```js
async function _sha256(text) {
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
localStorage.setItem(CRED_KEYS.pin, h);
```

- **No salt**, **no iteration count**, **no KDF**.
- A **4-digit PIN has 10,000 possible values.** Every SHA-256 of `0000`–`9999` can be precomputed in
  well under a second. The stored hash is equivalent to storing the PIN.
- The pattern hash has the same property over a small pattern space.
- A 6-character password is weakly protected; SHA-256 is designed to be *fast*, which is the opposite
  of what password storage needs.

**Correct fix when this is scheduled:** PBKDF2 via `crypto.subtle.deriveBits` with a per-install random
salt and a high iteration count. `crypto.subtle` is already imported, so this is a contained change —
but it invalidates existing hashes and needs a re-enrolment path, which is why it is not being done
inside an audit.

### 2. The hash is readable by anything running on the origin — **HIGH**

`localStorage` is readable by any script on `mysokoni.co.ke`. Combined with finding 1, an XSS foothold
or physical device access yields the PIN itself, not merely a hash.

Mitigating: the platform has a CSP and an XSS-escaping discipline, and the claim gate still stands
behind this.

### 3. Minimum strengths are low — **MEDIUM**

`newPin` accepts exactly 4 digits (`/^\d{4}$/`); `newAdminPw` accepts 6 characters
(`v.length < 6`). No complexity, no reuse check, no rate limit on the unlock attempt itself.

### 4. No re-authentication before changing a credential — **MEDIUM**

`changePin()` and `changePassword()` write the new hash immediately. **Neither asks for the current
credential.** Anyone at an unlocked console can silently replace the lock — including an ordinary
staff member borrowing an admin's open laptop.

This one is cheap to fix and does not invalidate stored hashes.

### 5. Duplicated credential inputs — **RESOLVED 2026-08-02** (`631b632`)

`newPin`, `newAdminPw` and `patternCanvasNew` were each declared **twice**, because
`#adm-pane-settings` itself was duplicated. `getElementById` resolved to the first copy, so the second
set was unreachable and never read by any handler — **latent, not active**. Removing the unreachable
pane reduced all three to a single declaration.

Worth recording *why* it mattered: a second password field that no handler reads becomes active the
moment someone adds a nav entry pointing at it, and a user typing into it would see a field that
accepts input and silently changes nothing.

---

## What is already correct

- **`autocomplete="new-password"`** is set on both inputs — the right attribute. It stops a password
  manager offering the site password and stops the browser storing the admin PIN as one.
- **Values are cleared after submit** (`document.getElementById('newPin').value = ''`), so the
  credential does not linger in the DOM for a later reader or a screenshot.
- **The raw value is never logged.** No `console.log` of the input, and no credential in any toast.
- **No hardcoded default credentials.** `DEFAULTS = {}` with the comment *"Default credentials removed
  from source"*, and `_checkFirstRunSetup()` forces enrolment when no hash exists. A shipped default
  PIN would have been the worst finding here and it is absent.
- **Inputs are `type="password"`**, so values are masked and excluded from ordinary form
  serialisation.

## Not applicable / no evidence

- **Clipboard exposure** — no `navigator.clipboard` or copy handler touches these fields.
- **Browser cache** — `type="password"` fields are not cached by browsers, and the page is not form-posted.
- **Logging** — checked; nothing writes these values anywhere.
- **Password-manager compatibility** — `new-password` is the correct signal; a manager will offer to
  generate and save, which is desirable for `newAdminPw` and irrelevant for a 4-digit PIN.

---

## Recommended order, when this is scheduled

1. **Re-authentication before a credential change** (finding 4) — cheapest, no migration, closes the
   "borrowed laptop" path.
2. **PBKDF2 + per-install salt** (findings 1–2) — needs a re-enrolment flow for existing hashes.
3. **Raise minimum strengths and rate-limit unlock attempts** (finding 3).

**Nothing above has been implemented.** The only change made was removing the unreachable duplicate
pane, which was Phase 1 pane 5 and is reported there.
