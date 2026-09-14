# Fingerprint / Shift-Start — Phase 0 audit

> # 🔴 **The chain does NOT exist. Do not build a fingerprint button.**
>
> Not because one would be fake — but because **one already exists, and it is already wired to
> refunds, voids, price overrides, stock adjustments and shift close.**
>
> `pos-manager-auth.js` grants manager approval on the strength of a JavaScript object being
> truthy in the browser. **No server ever sees the assertion.** There is no WebAuthn
> verification anywhere in `functions/`.

**Date:** 2026-09-10
**Mode:** Phase 0 audit — **read-only. No implementation, no fix attempted.**
**Subject:** `pos-manager-auth.js`, verified **clean and identical at committed `HEAD` (`c6a1e68`)** —
this is RC code, not a working-tree experiment.

Related: [[B1_PRODUCTION_ONLY_FUNCTIONS_DISPOSITION]] · [[B3_CLEAN_PROVENANCE_GATE]] · [[project_manager_auth]]

---

## 1. The chain, link by link

The question was whether SOKONI has:
`employee → registered credential → challenge → biometric assertion → server verification → shift authorization`

| # | Link | State | Evidence |
|---|---|---|---|
| 1 | employee → registered credential | 🟡 **Device-local, and structurally unverifiable** | `enrollBiometric` stores **only** `webAuthnCredId = _ab2b64url(cred.rawId)` (`:426`). The **public key is never captured** — `attestationObject` / `getPublicKey()` is never read |
| 2 | challenge | 🔴 **Client-generated** | `challenge: crypto.getRandomValues(new Uint8Array(32))` — in the browser, at **both** enrol (`:413`) and verify (`:958`). Never issued by a server, never stored, never compared |
| 3 | biometric assertion | ✅ **Real** | `navigator.credentials.get(...)` with `userVerification: 'required'` — the platform authenticator genuinely gates on a user gesture |
| 4 | server verification | 🔴 **ABSENT** | No WebAuthn verification exists anywhere in `functions/`. A search returns only `auth-email-challenge.js`, an unrelated email-OTP model |
| 5 | shift authorization | 🔴 **Client-asserted** | `if (assertion) _closeModal({ approved: true, manager: mgr, method: 'biometric' });` (`:966`) |

**Verified at HEAD:** the verify path (`:953–970`) contains **zero** `httpsCallable`, `fetch`,
`db.` or `firestore` calls. The approval never leaves the browser.

### The two defects that make this unfixable in place

1. **No public key was ever stored.** Only the credential *ID*. A signature can only be verified
   against the public key from registration — so **no server, now or later, can verify an
   assertion from an existing enrolment.** Every currently-enrolled manager must re-enrol under
   any real implementation. This is not a wiring gap; it is missing data.
2. **The challenge is chosen by the party being challenged.** A challenge the client generates
   provides no replay protection and no proof of freshness. It satisfies the browser API and
   nothing else.

---

## 2. What the current flow actually proves

> It proves that **a** platform authenticator on **this device** completed **a** user-verification
> gesture, and that a credential whose ID matches one in **this device's IndexedDB** exists.
>
> It does **not** prove that SOKONI authenticated any particular employee.

Exactly the distinction drawn when this slice was scoped — and the code sits on the wrong side of it.

---

## 3. Reachability — this is live code, not a dormant path

Confirmed reachable; grep alone would not settle this, so callers were traced:

* **Loaded by four served pages:** `pos.html`, `pos-checkout.html`, `manager-auth.html`, `commissioning.html`
* **Hosting publishes it** — a root-level `.js`, matched by no `hosting.ignore` pattern
* **7 call sites in `pos.js`, present at committed HEAD** (verified against `HEAD`, not the dirty working copy):

| Line | Operation gated |
|---|---|
| `pos.js:1068` | `requestPriceOverride` — price override |
| `pos.js:1229` | `large_discount` |
| `pos.js:2377` | `stock_adjustment` |
| `pos.js:2891` | `shift_close` |
| `pos.js:3443` | **`refund`** |
| `pos.js:3593` | **`void`** |

Refunds, voids, discounts and stock adjustments — money and inventory — are gated by an approval
the server never sees and could not verify if it did.

---

## 4. The wider finding: manager authority is device-trust, not just biometric

All manager records live in **IndexedDB on the till** (`_openDB` → `_dbPut`/`_dbGet`, `:173–217`),
holding `pinHash`, `pinSalt`, `qrHash`, `nfcUidHash` and `webAuthnCredId`. Four of the five
approval methods — PIN, QR badge, NFC card, biometric — are therefore **entirely device-local**.
Clearing site data resets manager authority. The offline audit trail is `localStorage`
(`sokoni_offline_auth_audit`, `:798–808`) and never reaches a server.

**One method is different.** *Mobile approval* has a genuine server rail — `managerAuthRequests`
with `functions/manager-auth.js` and `cleanupAuthRequests` re-exported at `functions/index.js:11078`.
It is the only one of the five where a second party's decision is recorded off-device.

> ### ⚖️ A fair reading of why
>
> A POS **must** keep selling when the network drops, and device-local approval is a legitimate
> answer to that constraint. This audit does not call the offline-first model a mistake.
>
> The defect is narrower and real: the biometric method **claims the strongest identity assurance
> of the five and delivers the weakest**. PIN at least requires a shared secret. Biometric
> requires only that *some* enrolled finger on *this* device passes a *local* check — and the
> result is then trusted for refunds. It is the one method whose appearance and substance diverge.

---

## 5. What Phase 1 would have to establish (NOT started)

1. **Decide the trust model first**, per operation. Which of the seven gated actions may be
   approved offline on device trust, and which must have a server-verified approval? Refund and
   void are the obvious candidates for the second group.
2. **Server-issued challenge**, stored with a TTL and single use.
3. **Capture the public key at registration** (`attestationObject`), server-side, bound to a
   *server-known* employee identity — not to an IndexedDB row.
4. **Server-side assertion verification**: signature, challenge match, `rpIdHash`, origin, and
   the signature counter for cloned-authenticator detection.
5. **Bind to employment**, using the canonical authority — noting the standing finding that
   `sellers/{uid}` is forgeable and the two employment stores are not converged.
6. **Re-enrolment migration.** Existing `webAuthnCredId` values are unusable (§1). Every enrolled
   manager re-enrols; plan for it rather than discovering it.

---

## 6. Scope and boundaries observed

* ✅ Read-only. **No implementation, no fix, no file modified** outside this document.
* ✅ Reachability traced to real callers at committed HEAD, not inferred from grep or from
  `commissioning.html`'s self-assertions (which were checked against `pos.js` directly and agreed).
* ❌ **Not exploited or tested on a device.** The claims here are code-path facts; no live till was
  driven, and nothing was verified against production behaviour.
* ❌ Loyalty untouched. Payment, wallet/ledger and commission code untouched.
* ❌ **Deployed device-security fixes untouched** — no device registration, heartbeat, tenant
  binding or `posDevices` code was modified or reverted.
* ⚠️ **Device/peripheral convergence audit not yet started** — it is the next slice, separate from this one.
