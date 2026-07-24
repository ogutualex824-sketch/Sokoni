# RC1 Run — production-rc04-traced

- Backend: `production(admin)`
- Started: 2026-07-24T06:42:39.415Z
- Privileged claims: refused
- Summary: **1 pass · 0 fail · 4 blocked**

## Release Candidate Coverage

| Suite | Result |
|---|---|
| RC-04 Inventory Journey | PASS (Partial) |

```
PASS:    1
FAIL:    0
BLOCKED: 4
```

**Untested capabilities:**

- Inventory mutation
- Inventory decrement
- Inventory consistency
- Realtime/offline sync

## RC-04 — Inventory Journey  →  PARTIAL

- ✓ **Seed probe product at stock 10** — PASS
    - `firestore`: {"type":"firestore","path":"products/rc-stock-10","stock":10}
- ⊘ **Place order for qty 2 (decrement path)** — BLOCKED: marketplace stock moves on PAYMENT CONFIRMATION, not order placement — the decrement lives in verifyIntasendPayment/darajaSTKCallback (onRequest). Certifying 10
- ⊘ **Stock is now 8** — BLOCKED: stock still 10 — decrement function not exercised here
- ⊘ **Search + seller view agree on 8** — BLOCKED: stock=10; gated on decrement step
- ⊘ **Realtime + offline cache reflect change** — BLOCKED: realtime listener + IndexedDB offline assertion is a later capability
