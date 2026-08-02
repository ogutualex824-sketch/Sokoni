# Release matrix — what may deploy, and what blocks it

**Date:** 2026-08-02 · **Production: `8ab9f33`**

Related: [[DEPLOYMENT_GUIDE]] · [[Release Validation Standard]] · [[ADR-011]]

---

## Matrix

| Area | Deploy allowed | Blocked by |
|---|---|---|
| Hosting — docs / ADRs | ✅ | none |
| Hosting — UI, static assets | ✅ | none |
| Water Supplier template | ✅ | none (no production merchant record is created) |
| Delivery engine + `darajaSTKPush` | ✅ | none technically — deploy, then monitor before merchant config rollout |
| Admin UI | ⚠️ | 11 authenticated admin regression checks |
| Checkout delivery migration | ❌ | authenticated merchant + 10-scenario matrix |
| Inventory (`inventory*`) | ❌ | **JDK 21** — concurrency + oversell proof unexecuted |
| Landlord write path | ❌ | **JDK 21** — 26 rule assertions unexecuted |
| Receipt rename | ❌ | Phase 7 — real merchant, every receipt path |
| POS / multi-till / printer / cash drawer | ❌ | Phase 7 — physical hardware verification |

**⚠️ means the code is ready and the verification is not.** It is not a softer ❌ — nothing in that row
ships until the check passes.

## Why the inventory gate no longer blocks everything

`gate-inventory.js` sat unconditionally in the hosting predeploy chain, so a documentation-only
release was refused because the Firestore emulator (JDK 21) was unavailable. **The gate is unchanged
in strength; only its scope narrowed.**

It now runs whenever a changed path matches `inventory`, `functions/shared/`, `functions/index.js`,
`firestore.rules`, or `firestore.indexes.json` — and **fail-closed**: if the baseline cannot be
established (no network, no git, live commit absent locally) **the gate runs**. Absence of evidence is
never evidence of safety.

Markdown and `docs/` never trigger it — `docs/INVENTORY_SUBTYPE_DESIGN.md` matching the word
"inventory" was itself part of the bottleneck, and documentation cannot change runtime behaviour.

Force it any time with `SOKONI_FORCE_INVENTORY_GATE=1`.

## Functions: never deploy blanket

```bash
# WRONG — inventoryTransferSubtype is already exported and would ship unverified
firebase deploy --only functions

# RIGHT — generate the command, which refuses blocked names
node scripts/deploy/functions-allowlist.js darajaSTKPush
```

There are ~1468 exports; an "allowlist of everything safe" is neither deployable nor meaningful. **The
unit of release is what changed, minus what is blocked.**

## Sequence, once JDK 21 exists

1. Run landlord rules (26), inventory concurrency, oversell proof, movement audit.
2. Run the inventory gate; confirm the artifact reports **PASS**, not `BLOCKED`.
3. Generate the functions allowlist.
4. Deploy the approved functions.
5. Deploy hosting.
6. Monitor `delivery_fee_unverified`, delivery-fee mismatch rejections, dispute automation, refund
   automation.

**`delivery_fee_unverified` should be non-zero immediately after `darajaSTKPush` ships** — no merchant
has a `deliveryConfig` yet. Silence means the recompute path is not executing, and that is a defect,
not a clean result.
