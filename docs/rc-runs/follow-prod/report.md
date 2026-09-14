# RC1 Run — follow-prod

- Backend: `production(admin)`
- Started: 2026-08-15T09:10:24.753Z
- Privileged claims: allowed
- Summary: **0 pass · 0 fail · 10 blocked**

## Release Candidate Coverage

| Suite | Result |
|---|---|
| RC-11 Follow — end-to-end through a signed-in browser | BLOCKED (Auth/Backend) |

```
PASS:    0
FAIL:    0
BLOCKED: 10
```

**Untested capabilities:**

- Follow: control validity
- Follow: create
- Follow: persistence
- Follow: delete
- Follow: recreate
- Follow: race
- Follow: cross-device convergence
- Follow: multi-entity
- Follow: minishop rail
- Follow: unauthenticated

## RC-11 — Follow — end-to-end through a signed-in browser  →  BLOCKED

- ⊘ **NEGATIVE CONTROL: signed-in user can read their own users/{uid} doc** — BLOCKED: control refused (permission-denied) — a signed-in user cannot read their own users doc, which the rules explicitly allow. Client ops are blanket-denied (App Che
    - `control`: {"type":"control","uid":"uKV3G82KOUWxXDsgnEUb3CfEJet1","ok":false,"code":"permission-denied"}
- ⊘ **1-3. Follow Shop A → Firestore document created, button reads Following** — BLOCKED: negative control invalid — client Firestore ops are blanket-denied before rules are evaluated (App Check rejects headless Chromium). Follow results here would b
- ⊘ **4-5. Reload → still Following (document persists, button hydrates)** — BLOCKED: negative control invalid — client Firestore ops are blanket-denied before rules are evaluated (App Check rejects headless Chromium). Follow results here would b
- ⊘ **6-7. Unfollow → document DELETED, and stays deleted after reload** — BLOCKED: negative control invalid — client Firestore ops are blanket-denied before rules are evaluated (App Check rejects headless Chromium). Follow results here would b
- ⊘ **8. Follow again after unfollow → document recreated** — BLOCKED: negative control invalid — client Firestore ops are blanket-denied before rules are evaluated (App Check rejects headless Chromium). Follow results here would b
- ⊘ **9. Rapid double-tap → in-flight guard holds, exactly one document, no error toast** — BLOCKED: negative control invalid — client Firestore ops are blanket-denied before rules are evaluated (App Check rejects headless Chromium). Follow results here would b
- ⊘ **10. CROSS-DEVICE re-follow → second session converges, no permission error** — BLOCKED: negative control invalid — client Firestore ops are blanket-denied before rules are evaluated (App Check rejects headless Chromium). Follow results here would b
- ⊘ **11. Follow a DIFFERENT entity → independent document, first one untouched** — BLOCKED: negative control invalid — client Firestore ops are blanket-denied before rules are evaluated (App Check rejects headless Chromium). Follow results here would b
- ⊘ **12. MINISHOP Follow → writes follows/{uid}--shop--{shopId} (was a non-existent CF)** — BLOCKED: negative control invalid — client Firestore ops are blanket-denied before rules are evaluated (App Check rejects headless Chromium). Follow results here would b
- ⊘ **Logged-out Follow → no document written, sign-in prompted** — BLOCKED: negative control invalid — client Firestore ops are blanket-denied before rules are evaluated (App Check rejects headless Chromium). Follow results here would b
