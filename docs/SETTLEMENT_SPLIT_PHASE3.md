# Settlement Phase 3 — Split Settlement & Provider Abstraction

**Platform:** SOKONI · **MoR:** Bravilex International Co. Ltd
**Date:** 2026-07-11 · **Status:** Built & unit-verified; **inert by default** (split disabled per gateway)

> Adds native **split settlement** — where the payment provider supports it, the gateway distributes the single customer charge directly (platform commission → Bravilex collection account, seller net → seller's registered payout account). Where a provider can't split, it **automatically falls back** to the existing collect-then-payout workflow. Behaviour is **configured per gateway**, never hardcoded. Ships with split disabled everywhere → current behaviour unchanged.

---

## Architecture

```
computeSettlement (engine)  →  breakdown (commission, seller net, …)
          │
          ▼
resolveSettlementMethod(provider, breakdown, sellerPayoutAccount)
   │                                   │
   ├─ canSplit? (provider supports + enabled + seller has payout account)
   │        │yes                       │no
   ▼        ▼                          ▼
 SPLIT                          COLLECT-THEN-PAYOUT (existing, always available)
 gateway distributes:          SOKONI collects 100% → engine credits seller wallet
   platform → Bravilex           → payout queue disburses
   seller   → seller account
          │
          ▼
 record { settlementMethod, split (masked), ledgerPlan } — accounting/recon/audit
```

## Components (all additive)

| Module | Role |
|--------|------|
| `payment-adapters.js` | Base adapter gains `capabilities()` + `initiateSplitPayment()`. `IntaSendAdapter` declares `supportsSplit:true` and implements the split call (endpoint pending sandbox verification). Other providers inherit the base → throw → fallback. |
| `settlement-providers.js` | Per-gateway capability + config registry (`settlementConfig/providers`). `getProviderSettlement(provider)` → `{ supportsSplit, splitEnabled, canSplit }`. Admin CFs `settlementGetProviders` / `settlementSetProvider` (guards: can't enable split on a non-split provider; audited). |
| `settlement-executor.js` | `resolveSettlementMethod` (split vs fallback), `buildSplitInstructions` (platform→Bravilex, seller→account), `buildLedgerPlan` (method-specific, balanced), `buildSettlementRecord` (stamps `settlementMethod`), `executeSettlement` (calls adapter for split; **auto-falls-back on failure**). Admin preview CF `settlementPreviewMethod`. |

## Provider capability matrix (defaults)

| Gateway | supportsSplit | splitEnabled (default) | Effective |
|---------|---------------|------------------------|-----------|
| intasend | ✅ | ❌ | fallback until enabled + verified |
| card (via intasend) | ✅ | ❌ | fallback |
| mpesa_daraja | ❌ | — | always collect-then-payout |
| wallet / smartpos / qr / bank | ❌ | — | always collect-then-payout |
| subscription | ✅ | ❌ | platform-only; split N/A |

## Accounting reflects the actual method

- **split** ledger (funds distributed at collection, no clearing hold, no separate payout):
  `EXTERNAL_GATEWAY → seller:{id}` (net), `EXTERNAL_GATEWAY → PLATFORM_REVENUE` (commission) — net-zero.
- **collect_then_payout** ledger: the engine's clearing-based plan (`EXTERNAL_GATEWAY → PLATFORM_CLEARING → seller`, separate payout).
- Every settlement/ledger/audit record carries `settlementMethod`, `methodReason`, and (for split) the **masked** split — the full Bravilex/seller account numbers never enter a stored record.

## Security & branding

- Full Bravilex account number is used only to build the gateway instruction server-side; records/logs carry `••••0001`. Seller account masked to last-4 in records.
- Customer experience unchanged — all confirmations remain SOKONI-branded; split is invisible to the buyer.

## Verification (unit, synthetic)

| Scenario | Result |
|----------|--------|
| intasend + split enabled + seller account | ✅ `split`; ledger balanced; seller 90000 → account, 10000 → Bravilex `••••0001` |
| intasend + split disabled | ✅ fallback (`split supported but not enabled`) |
| mpesa_daraja | ✅ fallback (`provider cannot split natively`) |
| split enabled but no seller payout account | ✅ fallback (`seller has no registered payout account`) |
| split call throws at runtime | ✅ auto-fallback to collect-then-payout, method recorded as such |
| full account number in stored record | ✅ never (masked only) |

## Activation checklist (before enabling split for a gateway)

1. Verify the provider's split API endpoint/payload in **sandbox** (IntaSend split/wallets).
2. Ensure sellers have a **registered payout account** captured.
3. Run `settlementValidatePath` (Phase 2) green + the emulator manual checks.
4. `settlementSetProvider({ provider:'intasend', splitEnabled:true })` behind the routing rollout %.
5. Reconcile split settlements (new ledger types) net-zero before widening rollout.

## Not done / deploy note
Split is **disabled** for every gateway (no live change). The IntaSend split endpoint needs sandbox confirmation before enabling. **New CFs (`settlementGetProviders`, `settlementSetProvider`, `settlementPreviewMethod`) are blocked from creation by the project's Cloud Run CPU quota** — code is committed; deploy on quota increase (see `DEPLOY_QUEUE.md`).

Related: [[SETTLEMENT_MIGRATION_PHASE2]] · [[ENTERPRISE_SETTLEMENT_ARCHITECTURE]] · [[project_settlement_engine]]
