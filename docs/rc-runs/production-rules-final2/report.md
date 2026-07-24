# RC1 Run — production-rules-final2

- Backend: `production(admin)`
- Started: 2026-07-24T07:13:56.597Z
- Privileged claims: refused
- Summary: **2 pass · 0 fail · 7 blocked**

## Release Candidate Coverage

| Suite | Result |
|---|---|
| RC-09 Firestore Rules (client-side authorization) | PASS (Partial) |

```
PASS:    2
FAIL:    0
BLOCKED: 7
```

**Untested capabilities:**

- Rules: control validity
- Rules: anonymous write
- Rules: cross-seller isolation
- Rules: ownership immutability
- Rules: cross-seller delete
- Rules: buyer isolation
- Rules: admin-only collections

## RC-09 — Firestore Rules (client-side authorization)  →  PARTIAL

- ✓ **Seed: one product owned by the RC seller, one owned by another seller** — PASS: owned by oXrgbq2oBwadJSfsk0NypDCAXVT2, foreign by rc-not-this-seller-uid
    - `assertion`: {"type":"assertion","ownedBy":"oXrgbq2oBwadJSfsk0NypDCAXVT2","foreignBy":"rc-not-this-seller-uid"}
- ✓ **Anonymous direct read of products is denied (deployed posture)** — PASS: denied (permission-denied) — catalogue still served to visitors via another path
    - `rules`: {"type":"rules","label":"anon read product","op":"get","path":"products/rc-rules-owned","expect":"deny","actual":"deny","code":"permission-denied","uid":null}
- ⊘ **NEGATIVE CONTROL: signed-in user CAN read their own users/{uid} doc** — BLOCKED: control refused (permission-denied) — a signed-in user cannot even read their own users doc, which the rules explicitly allow. Client ops are blanket-denied (Ap
    - `rules`: {"type":"rules","label":"self read users doc","op":"get","path":"users/oXrgbq2oBwadJSfsk0NypDCAXVT2","expect":"allow","actual":"deny","code":"permission-denied"
- ⊘ **CONTROL: signed-out write is denied** — BLOCKED: negative control invalid — client operations are blanket-denied before rules are evaluated (App Check rejects the headless browser). Deny results here are NOT r
- ⊘ **Seller CANNOT update another seller's product** — BLOCKED: negative control invalid — client operations are blanket-denied before rules are evaluated (App Check rejects the headless browser). Deny results here are NOT r
- ⊘ **Seller CANNOT reassign ownership (sellerUid is immutable)** — BLOCKED: negative control invalid — client operations are blanket-denied before rules are evaluated (App Check rejects the headless browser). Deny results here are NOT r
- ⊘ **Seller CANNOT delete another seller's product** — BLOCKED: negative control invalid — client operations are blanket-denied before rules are evaluated (App Check rejects the headless browser). Deny results here are NOT r
- ⊘ **Buyer CANNOT write a seller-owned product (control: seller could, above)** — BLOCKED: negative control invalid — client operations are blanket-denied before rules are evaluated (App Check rejects the headless browser). Deny results here are NOT r
- ⊘ **Admin-only collection rejects an ordinary authenticated user** — BLOCKED: negative control invalid — client operations are blanket-denied before rules are evaluated (App Check rejects the headless browser). Deny results here are NOT r
