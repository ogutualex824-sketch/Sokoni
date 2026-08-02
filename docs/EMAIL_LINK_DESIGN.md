# Passwordless email-link sign-in — client design

**Date:** 2026-08-02 · **Status:** design. **Not implemented.**
**Provider state: ENABLED on `sokoni-aeb26`. No console change is required to build this.**

Related: [[Universal Auth]] · [[ADR-001]] · [[Account Consistency]] · [[Google Sign-in authDomain]]

---

## A correction worth recording

This document previously would have opened *"Email Link is disabled; enable it first."* **That was
wrong, and it was reported twice.**

The API omits `passwordRequired` when it is `false`, because proto3 JSON drops default-valued fields.
The check tested `=== false` against `undefined` and concluded "disabled". **Absent meant enabled.**

It is recorded here because the same trap will catch the next reader of any Google API config: a
missing field is a *default*, never a *disabled feature*. Assert on the effective value, never on
presence.

## Why passwordless, for this platform specifically

Password auth here already carries the failure modes this removes: a profile↔login loop caused by
gating a session on profile metadata (`isLoggedIn` name loop), password reset over an email channel
whose SendGrid key is unset, and credential reuse across merchant staff accounts sharing one till
login. **The email link is the same channel a password reset already trusts — with one fewer secret
to store, leak, or rotate.**

## Design

### 1. Send

```js
await sendSignInLinkToEmail(auth, email, {
  url: 'https://mysokoni.co.ke/finish-signin',   // MUST be the apex, same-origin
  handleCodeInApp: true,
});
localStorage.setItem('sokoniEmailForSignIn', email);
```

**The `url` must be same-origin apex.** A cross-origin `authDomain` already broke mobile Google
sign-in silently under ITP (fixed in `3204658`); the identical trap applies here and fails the same
way — no error, no session.

### 2. Complete

```js
if (isSignInWithEmailLink(auth, location.href)) {
  let email = localStorage.getItem('sokoniEmailForSignIn');
  if (!email) email = await promptForEmail();      // link opened on another device
  const cred = await signInWithEmailLink(auth, email, location.href);
  localStorage.removeItem('sokoniEmailForSignIn');
  await ensureUserBaseline(cred.user);             // existing CF — do not reimplement
}
```

**The re-prompt is required, not optional.** `localStorage` is per-origin **and per-device**: a link
requested on a phone and opened on a laptop finds nothing. Without the prompt the user hits a dead
end that looks like a broken link. This is the same per-device assumption behind the standing
localStorage elimination work.

### 3. Session convergence

`ensureUserBaseline` (already deployed) is the single write path. **Do not add a second one.** Roles
come from `roles[]` in `users/{uid}` and authorization from **custom claims** — ADR-001. An email-link
session grants no privilege by itself.

## Constraints that must hold

| constraint | why |
|---|---|
| **Do not remove password auth** | founder's explicit instruction; both coexist |
| **Same-origin apex `url`** | ITP silently kills cross-origin completion |
| **Re-prompt for email** | localStorage is per-device |
| **Link is single-use, expires** | Firebase enforces; surface a clear expiry message |
| **Never auto-link accounts by email** | account takeover via an unverified address |
| **No privilege from the link** | claims remain the sole authority |

## Verification, before it is called done

1. Same device, same browser — completes.
2. **Requested on phone, opened on laptop** — re-prompts and completes.
3. Expired link — states it, offers resend.
4. Reused link — refused.
5. Existing password user signs in by link — **same `uid`**, no duplicate record.
6. An admin signing in by link still holds their claims; a non-admin gains none.

**Test 5 is the one that matters** — a second record for the same person splits their orders, wallet
and history, and that is not repairable after the fact.

**Blocked on the same gate as everything else: authenticated end-to-end verification.**
