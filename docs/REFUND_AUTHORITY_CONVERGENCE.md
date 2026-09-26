# Refund authority — three lineages, one release decision

**Status:** OPEN merge task. Owner decision 2026-09-26: **Creator Hub keeps this branch's refund
authority (C)**; the lineages converge at the release merge, not by porting into a feature branch.
Related: [[CREATOR_HUB]], [[CREATOR_PAYMENT_ARCHITECTURE]], [[PAYOUT_OUTCOME_UNKNOWN]].

## The three authorities (measured 2026-09-26)

| | Lineage | Authority | Commits | On `main`? | Creator film refunds |
|---|---|---|---|---|---|
| **A** | `slice/realtime-control-plane` | `refund-requests.js` (`requestRefundCase`, `reviewRefundCase`, `listMyRefundCases`, `listShopRefundCases`) + `refund-execution.js` (`executeRefundCase`); `fosApproveRefund` "cannot spend money" | B9.31 `a5e3287` → B9.32-REPAIR `c073770` → `1fbc2d4` → B9.32B `408573c` `903e019` → B9.32B-REPAIR `e18fad8` → **B9.32C `e27620d`** (financial-os converged) → B9.32D-REPAIR `1af3029` (IntaSend refund adapter, field-proven contract) | **no** | **none** (0 references) |
| **B** | `land/refund-repairs` → `feat/integrations-control-center` (main checkout) | `refund-authority.js` — Tracks F/G | `e63191c` (one refund authority), `9067a9e` (escrow bound to order), `ea5b5f1` | **no** | **none** (0 references) |
| **C** | `feat/creator-hub` (this branch) | `financial-os.js` — `fosSubmitRefund` · `fosApproveRefund` · `_executeRefund` (locked, one provider call) · `fosResolveRefund` (Super Admin + evidence, `outcome_unknown` never retried) | `3308deb` (P0) | **no** | **yes** — `_afterRefundSettled` → `creator-hub.onFilmRefundProcessed` (royalty reversal + entitlement revocation) |

## Why nothing was ported in this slice

- A trial cherry-pick of A's 8 core commits onto `7fc0643` (throwaway worktree, removed) **conflicted on
  every one**: `functions/index.js` (a5e3287, c073770), `refund-execution.js` inside the lineage,
  `functions/financial-os.js` (e27620d — where C's P0 fix and the film hook live) and
  `functions/payment-adapters.js` (1af3029).
- A and B have **no Creator film handling**. Adopting either as-is would drop film royalty reversal and
  entitlement revocation on refund.
- Porting A into a feature branch would create a **fourth** variant unless A is also declared the release
  line.
- The AdminOS Refunds tab calls C, which **exists on this branch** — there is no runtime dependency on
  another branch.

## What the release merge must do (the task)

1. Choose ONE authority for the release line (A has the richest lifecycle: request → review → execute,
   funding policy, the field-proven IntaSend refund adapter; C has exactly-once execution, `outcome_unknown`
   resolution and the Creator film hook; B has the order-escrow binding).
2. Carry into it, as acceptance criteria, every property the others proved:
   buyer cannot approve · ordinary user cannot approve · one provider execution per case · replay /
   concurrency = one refund · `outcome_unknown` never retried blind · resolution Super Admin + evidence,
   repeat is a no-op · seller credit reversed exactly once · no negative wallet · no `refundRequests`
   auto-credit bypass · **Creator film refund → royalty reversal + entitlement revocation, once**.
3. Point AdminOS › Creator Hub › Refunds at the chosen authority (today: `creatorAdminRefundCases` reads
   `fosRefundQueue`; actions call `fosApproveRefund` / `fosResolveRefund`).
4. Re-run `scripts/test-refund-authority-matrix.js` (R1–R8 + film) against the result.

## Proof for C today

`scripts/test-refund-authority-matrix.js` — 24/0: R1 buyer requests, cannot approve · R2 ordinary user
refused · R3 admin approves · R4 one provider call · R5 replay + concurrent = one · R6 5xx →
`outcome_unknown`, no retry · R7 Super Admin + evidence, repeat has no effect · film refund reaches the
royalty hook · R8 AdminOS lists the real `fosRefundQueue` case and creates nothing.
`scripts/test-refund-exactly-once.js` — 103/0 (base-vs-branch).
