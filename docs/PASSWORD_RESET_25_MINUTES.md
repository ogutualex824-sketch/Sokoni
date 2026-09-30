# Password reset — 25-minute, single-use link

**Owner requirement (2026-10-01):** a password-reset link stops working 25 minutes after it is issued.
**Related:** [[Authentication]] · [[SECURITY_PRIVACY_GAP_CENSUS_2026-10-01]] · [[SECURITY]]

## Why SOKONI enforces it

Firebase's reset action codes (`sendPasswordResetEmail`, `generatePasswordResetLink`) last a fixed
hour. Their lifetime cannot be configured. Before this change the site used them directly, and its only
rate limit was a sessionStorage counter in the browser.

## Flow

```
login.html "Forgot password" ──► authRequestPasswordReset({email})
   App Check · limits (email 3/15 min, client 10/15 min, global 300/h; fail CLOSED)
   same answer for every email ─┬─ unknown / disabled account → nothing else happens
                                └─ account → token = 32 random bytes (base64url)
                                             passwordResetTokens/{sha256(token)} {uid, issuedAt,
                                               expiresAt = issuedAt + 25 min, usedAt: null}
                                             passwordResetState/{uid} {latestHash}  (revokes older links)
                                             email: https://mysokoni.co.ke/reset-password?t=<token>
                                               (category "security": never click-tracked; body not logged)

reset-password.html ──► authCompletePasswordReset({token, newPassword})
   App Check · client limit 10/15 min · password rules (8–128, a letter and a number; never altered)
   transaction: token exists · unused · now < expiresAt · still the user's latest → mark used
   updateUser(password) → revokeRefreshTokens(uid) → owner notified → securityEvents row
   any refusal: one message — "This reset link is invalid or has expired. Request a new one."
```

## Properties and evidence

| Property | Evidence |
|---|---|
| Stops at 25 minutes | `scripts/test-password-reset-25m.js`: 24m59s works, 25m01s refused, password unchanged. Sabotage (expiry check removed) fails that case. |
| Single use; newer link revokes older | Test sections C1, C2 |
| Only a SHA-256 is stored; no plaintext token or email in Firestore | Test sections A4, A7, E4 |
| No account enumeration | Test A1: identical response for existing and unknown emails |
| Rate limited, fail closed | Test F1 (4th request → `resource-exhausted` + `retryAfterSeconds`), F4 (limiter error → `unavailable`) |
| Sessions revoked, owner notified, audited | Test sections E1–E3 |
| Collections server-only | No rule matches them, and Firestore default-deny applies (test H3) |

## Residual — owner or config action

- **Native Firebase codes.** Firebase's native reset endpoint (`sendOobCode`) can still email a 1-hour link to the mailbox owner if someone calls the Identity Toolkit API directly. To close it:
  - switch reCAPTCHA email/password protection from AUDIT to ENFORCE, or
  - set the email action handler to a SOKONI page that refuses `mode=resetPassword`.

  Both are production Auth configuration changes, and neither is made here.
- **Admin-invitation set-password links** (`invitations-core.js`, `admin-invitations.js`) still use 1-hour Firebase codes. Moving them onto this gate is a follow-up.
- **TTL policy.** No TTL policy is set on `passwordResetTokens.ttlAt` or `passwordResetRate.expiresAt`. The documents are tiny and expired ones are inert. Adding the policies is a config step.

## Deploy

1. Functions: `firebase deploy --only functions:authRequestPasswordReset,functions:authCompletePasswordReset` from branch `port/password-reset-25m-on-shell-gate`. These are new names, so no live function changes.
2. Then hosting: the login flow and `reset-password.html`. Deploying hosting first would point users at callables that do not exist yet.
