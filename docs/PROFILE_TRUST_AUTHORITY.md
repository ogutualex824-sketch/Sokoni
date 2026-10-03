# Profile trust score — only real verifications count (2026-10-03)

**Owner ask:** make sure the profile's verifications and trust score work.
**Server:** `functions/profile-engine.js`, branch `fix/profile-trust-authority-on-72dca56`. **NOT deployed.**
**Client:** `profile.html`, branch `hosting/profile-wallet-instant-on-72dca56`. **NOT deployed.**
**Suites:** `scripts/test-profile-trust-authority.js` (15/0) · client `scripts/test-profile-trust-display.js` (11/0; production fails 10) · `scripts/test-profile-completion-routing.js` (111/0)
**Related:** [[PROFILE_BUYER_ONLY]] · [[Authentication]] · verification-vocabulary.js

## Live evidence (read-only, 2026-10-03)
- The live `profileGetOverview` and `profileGetPublicProfile` archives contain a `profile-engine.js` that is **byte-identical** to 72dca56. The defects below are in production.
- Live Firestore ruleset **f259c0b5**:
  - `users/{uid}.phoneVerified` IS guarded (`noPhoneVerificationForgery`: it must match the token's `phone_number`).
  - `emailVerified` and `legalSigned` are mentioned nowhere, so the owner can write them.
  - `verifications/{uid}` is `write: if false`.
  - `businesses` is `create: if false` (the server creates it).

## Defects fixed

| # | Where | Defect | Fix |
|---|---|---|---|
| 1 | server | `users.emailVerified` (self-writable) earned +15 trust and ticked the email step | Email comes from **Firebase Auth**: the caller's own token, or `getUser` for anyone else. A failed lookup means not verified |
| 2 | server | owning any `businesses` doc earned +15 **"Business Verified"**, a hero badge and `verifications.business = true` | Only an **approved, unexpired business facet** counts. Registered ≠ verified (owner ruling) |
| 3 | server | phone-auth (OTP) accounts weren't credited unless `phoneVerified` was mirrored | An Auth phone number also counts; the guarded `phoneVerified` still counts |
| 4 | client | nine widgets read `ov.trustScore`, which the server never sends, so they **always showed 0 / Bronze** | `_skNormOv` copies `trust.score/level` once onto the cached overview |
| 5 | client | an unknown trust score rendered as `0` / `Bronze` | It now renders `—`. Insights say nothing about level or delta until the score is known; the baseline is per account |
| 6 | client | Identity grid ignored `facetStates`: a submitted ID under review said **"Tap to verify"** | It now shows "Under review" (links to the status page), "Needs attention" (with the reviewer's reason) or "Expired — renew" |
| 7 | client | "Verify email/phone", "Add address" and `#verify` led to display-only pages | Ported from `76fd002`, `58dcda7`, `7f64c30` and `f43da27` (built, never live). They now open the on-page phone OTP, the email-link sender and the inline editor. An empty hash restores Overview (phone Back) |

## Effect on live scores
Scores **fall** for accounts whose points came from a self-written `emailVerified` or from merely owning a business.
They **rise** for phone-auth accounts.
Nothing is written. The score is computed on every read, so no migration is needed.

## Deploy (scoped, one slot, memory gate)
- `--only functions:profileGetOverview,functions:profileGetCompletion`, from this branch. **Diff each function's live archive first** (lineage gate). Today both equal 72dca56 for `profile-engine.js`.
- **`profileGetPublicProfile` is deliberately NOT in the list.** It is the Artifact Registry live specimen in CLAUDE.md ("do not … rebuild"). It shares the fix in source, and its public `trustLevel` updates only when the owner authorises that rebuild.
- The client branch is safe before or after: it reads `trust.score` either way.
