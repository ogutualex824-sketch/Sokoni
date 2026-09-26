# Decision record — anonymous (guest) Creator purchase

**ANONYMOUS CREATOR PURCHASE: BLOCKED — PLATFORM AUTHORIZATION REQUIRED**

Status 2026-09-26. Not enabled. No Firebase Auth configuration was changed. Related: [[CREATOR_HUB]] §24.

## What is built (and proven locally)

Behind `config/creatorHub.guestCheckoutEnabled` (default **OFF**, Super Admin only):

```
anonymous Firebase uid ─→ createPaymentIntent(film_access)   intent.uid = the verified anonymous uid
        ─→ payment COMPLETE (webhook)                          nothing is granted before this
        ─→ contentEntitlements bound to that SAME uid
        ─→ "Create your account": linkWithCredential(USER, EmailAuthProvider.credential(...))
        ─→ the SAME uid now has a password credential         no new uid, no copied entitlement
```

Executed in `scripts/test-creator-hub.js` (guest block): intent bound to the anonymous uid; a forged client
uid ignored; nothing before COMPLETE; entitlement only after COMPLETE; another user cannot use it; after the
upgrade the SAME uid owns the film; **no second entitlement**; callback replay after upgrade → still one;
a second device plays. `scripts/test-creator-completion.js` checks the page LINKS (never
`createUserWithEmailAndPassword`). Anonymous tokens are refused for every creator / money op except browse,
purchase-pricing (flag-gated), playback and the viewer's own library.

**Not proven:** the client-side password setup and later login against real Firebase Auth (not run against
production, by design).

## What must be authorized to enable it

Enabling it means turning on the **Anonymous** sign-in provider for the whole Firebase project
`sokoni-aeb26` — a platform decision, not a Creator Hub setting:

1. **Every visitor can obtain a Firebase identity.** Anonymous uids are persisted users in Firebase Auth.
2. **Every `isAuthed()` rule and every `req.auth`-only callable opens to them** — ~740 rule references and
   ~74 function modules treat "signed in" as sufficient today. Each must be reviewed (or the rules must
   distinguish `firebase.sign_in_provider == 'anonymous'`) before the provider is switched on.
3. **Abuse surface changes:** identity becomes free to mint — rate limits keyed on uid stop meaning a
   person; account-lifecycle cleanup (orphaned anonymous users) is needed.
4. **Identity model:** account upgrade/linking (`linkWithCredential`) becomes part of the platform's
   identity model, including the "email already in use" conflict (today the page tells the buyer to sign in
   and contact support — no automatic merge).

Then: Super Admin sets `guestCheckoutEnabled = true` in AdminOS.

## What stays true while it is disabled

Creator purchases require normal authentication (the page says "Sign in to watch"). No anonymous account is
fabricated from client identifiers; the pricer reads only the server-verified uid.
