# Diagnosis — the three production `permission-denied` failures

**Status:** DIAGNOSIS ONLY. **Nothing was changed** — no code, no rules, no queries, no auth, no
production data, no test documents.

**Run:** `test-merchant-v2-certification.js`, MODE PRODUCTION, origin `https://mysokoni.co.ke`,
14 passed / 3 failed.

---

## Headline

**All three failures share one cause, and it is not Firestore security rules.**

The reads were refused by **App Check enforcement**, because a headless browser cannot complete
reCAPTCHA attestation. Every rule governing the three reads is correct and would permit them.

This is a **harness limitation introduced by removing the debug token**, not a defect in Merchant v2
and not a rules mismatch. The instruction's reasoning — that native attestation on the live origin is
the stronger test — is right for a *real* browser; it is unachievable for an automated one.

### Proof, three independent ways

| # | evidence | why it settles it |
|---|---|---|
| 1 | `shops` query in the live v2 page → `permission-denied` | `match /shops/{uid}` is **`allow read: if true`**. No rule can deny it. |
| 2 | `products` query in the same page → `permission-denied` | Also world-readable. Two different collections, same denial = cross-cutting cause. |
| 3 | Firestore **REST** read of `shops/D5Ql2…` with the web API key, unauthenticated → `PERMISSION_DENIED` | Bypasses the SDK entirely and still denied on a world-readable document. |

The historical control is the decisive one: **the same seller, the same collections, the same rules
succeeded at 17/0 when a debug token was supplied.** The only variable changed between that run and
this one is attestation.

---

## Identity (healthy — not the problem)

```
authenticated uid   D5Ql2EYr95bt79IpcGTmOMTK0P83
sellerUid           D5Ql2EYr95bt79IpcGTmOMTK0P83   (derived from auth uid; PASS)
activeShopId        null                            ← consequence, not cause
```

`sellerUid === auth uid` passed. Sign-in, session adoption, refresh survival and re-adoption all
passed. The identity chain is intact up to the point where a Firestore read is required.

---

## Case 1 — active shop resolver

| | |
|---|---|
| **Path** | `shops/D5Ql2EYr95bt79IpcGTmOMTK0P83` |
| **Read** | `getDoc(doc(db, 'shops', S.uid))` — a direct document get, not a query |
| **Site** | `merchant-v2.html:1053`, in `resolveShop()` |
| **Rule** | `match /shops/{uid} { allow read: if true; }` |
| **Verdict** | **The rule permits this unconditionally.** It does not read auth, roles, or ownership. |
| **Observed** | `shopError: "permission-denied"` after 3 attempts with backoff |

`resolveShop()` already carries a comment recording that a *previous* session measured this exact
failure mode against a real seller — the read racing App Check attestation, an empty `catch`
swallowing it, and `activeShopId` staying null for the whole session "even though `shops/{uid}`
existed, was `status:'active'` and is publicly readable." The retry loop was added because of that.
Here it retried three times and attestation never arrived, because in headless it never can.

**Cascade:** `sokoni-merchant-data.js:65` returns `{ ok:false, reason:'no_active_shop' }` when
`shopId` is absent, so a null `activeShopId` disables every shop-scoped read downstream. That is
correct fail-closed behaviour, not a second defect.

**v1 comparison:** `merchant.html:2297` and `:2321` read the same `shops` authority (a query, then
`_get('shops', uid)`). Same collection, same rule, same authority — v1 is not reading anything v2
is missing.

---

## Case 2 — Orders ownership

| | |
|---|---|
| **Path** | `orders` collection |
| **Query** | `query(collection(db,'orders'), where('sellerUid','==', 'D5Ql2EYr95bt79IpcGTmOMTK0P83'), limit(10))` |
| **Site** | the harness's own §7 probe, not shell code |
| **Rule** | `allow read: if isAdmin() \|\| (isAuthed() && resource.data.uid == request.auth.uid) \|\| … \|\| (isAuthed() && resource.data.sellerUid == request.auth.uid) \|\| …` |
| **Verdict** | **The rule permits this.** `isAuthed()` is `request.auth != null` — no email-verification or role gate. The query filters on exactly the field the rule tests, which is the canonical list-safe pattern. |
| **Observed** | `ERR permission-denied` |

An empty result would also have been a valid pass — the assertion requires only that the backend
answered (`fromCache === false`) and that every returned row is this seller's. It never reached the
backend.

---

## Case 3 — Payments ownership

| | |
|---|---|
| **Path** | **`sellerPayments`** — confirmed, **not** buyer-scoped `payments` |
| **Query** | `query(collection(db,'sellerPayments'), where('sellerUid','==','D5Ql2EYr95bt79IpcGTmOMTK0P83'), limit(10))` |
| **Rule** | `match /sellerPayments/{paymentId} { allow read: if isAdmin() \|\| (isAuthed() && resource.data.sellerUid == request.auth.uid) \|\| (isAuthed() && resource.data.callerUid == request.auth.uid); allow write: if false; }` |
| **Verdict** | **The rule permits this.** Same seller-scoped pattern as `orders`. |
| **Observed** | `ERR permission-denied` |

> **`sellerPayments` confirmed.** The client readers of that collection are `index.html`,
> `merchant-v2.html`, `payments.html` and `seller.html`. v2 reads the same authority the v1-era
> surfaces do; it is not reading a buyer-scoped collection.

---

## What this is NOT

- **Not an auth problem.** Sign-in, uid derivation, session persistence and refresh all passed. Do
  not reopen the auth investigation.
- **Not a rules mismatch.** All three rules permit the reads as written.
- **Not a v1↔v2 divergence.** v2 reads `shops/{uid}` exactly as v1 does, and `sellerPayments` exactly
  as `seller.html`/`payments.html` do.
- **Not a defect the cutover should wait on** — but see the caveat below before concluding that.

## Caveats I cannot close from here

1. **The repo ruleset may not be the live ruleset.** `firestore.rules` here is 256,582 bytes and the
   compiled ceiling is 256,000; the release record states the worktree rules cannot be released and
   that live is `e66d77a4`. **Every rule quoted above is from the repo file.** They should be
   confirmed against the live ruleset before anyone acts on them — although the App Check evidence
   makes the rules largely moot for this failure.
2. **The shop document's existence is unconfirmed *today*.** The REST probe was itself blocked by
   App Check, so "the document exists" rests on the earlier session's measurement recorded in
   `resolveShop()`, not on a reading taken now.
3. **Whether a real (non-headless) browser attests successfully on `/merchant-v2` is unproven.** It
   is strongly implied — the shell is served from the attested production origin and ordinary
   merchants use it — but this run cannot demonstrate it.

## Options — not implemented, awaiting your decision

Listed for completeness only. **No rule change appears in any of them, and none should:** the rules
are correct, and weakening them to make a headless test green would be the exact anti-pattern.

- **A — restore the debug token for the certification run only.** Reverts to the mechanism that
  earned 17/0. Cost: attestation is bypassed, so the run proves everything *except* that App Check
  passes. Mint, run, revoke, record.
- **B — run the certification in a headed browser.** Playwright can drive a non-headless Chromium,
  which may satisfy reCAPTCHA. Proves attestation genuinely. Unverified whether it works here.
- **C — a human runs the walk manually** in a real browser and signs the result, as with P58E.
- **D — accept the split**: the unauthenticated smoke (15/0) plus the authenticated rows that *did*
  pass (14), and treat the three data rows as requiring A, B or C.

My recommendation is **B first** — it is the only option that proves attestation rather than
bypassing it, and it costs one run to find out. **A** is the reliable fallback.
