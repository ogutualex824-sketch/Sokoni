# Slice 1 — semantic review: `functions/index.js` (final gate)

**From:** `2dd5645` · **Read-only.** `index.js` not modified, nothing resolved, nothing deployed.

```
lineage A   d6655bd   blob 773f1993   12,791 lines   1502 exports
lineage B   919333e   blob 2ba14e09   13,067 lines   1514 exports
candidate   c6a1e68   blob 96cfd3f5   13,266 lines   1532 exports
```

Neither lineage was treated as the universal authority. The unit of comparison is the
individual export against the **deployed** graph.

# ⚠️ REQUIRES_HUMAN_DECISION

**The candidate would remove 18 live exports, including three registered Eventarc triggers.**

---

## Deployed export matrix

| | count |
|---|---|
| union of both production lineages | **1516** |
| of that union, **deployed / live** | **946** |
| live exports the candidate would **REMOVE** | **🔴 18** |
| candidate-only exports **already deployed** (must be preserved) | **5** |
| candidate-only exports that are **genuinely new surface** | **31** |

**No source is a superset.** Lineage A+B holds 18 live exports the candidate lacks; the
candidate holds 5 live exports A+B lack. The correct reconciliation is a **union**, not a
choice between files.

## 🔴 The 18 live exports the candidate removes

| class | exports | source module |
|---|---|---|
| **TRIGGERS — all three live** | `onPaymentIntentPaid` · `onPosSaleCompleted` · `onPackageRequestChanged` | `subPayMethods` · `printIntents` · `_messagesMod` |
| **PAYMENT** | `payIntentWithWallet` · `reconcileSubscriptionPayment` · `subscriptionPaymentMethods` · `commissionDispatch` | `subPayMethods`, `commission` |
| **POS PRINTER HOST** | `createPrintIntent` · `claimPrintJob` · `advancePrintJob` · `registerPrinterHost` · `getPrinterHostStatus` | `printIntents`, `deviceMgr` |
| **IDENTITY VERIFICATION** | `verificationSubmit` · `verificationDecide` · `verificationRevoke` | `_verEng` |
| **AUTHORITY** | `adminLinkMerchantAccounts` · `employeeSaleAuthorize` | `merchantIdentity` |
| **POS RETAIL** | `posSendPurchaseOrder` | `posRetail` |

### The triggers are registered, not merely exported

Checked against live Eventarc and Cloud Run rather than inferred from source — the distinction
that mattered in the `application-lifecycle` gate:

```
onpaymentintentpaid       eventarc=1   deployed-service=1
onpossalecompleted        eventarc=1   deployed-service=1
onpackagerequestchanged   eventarc=1   deployed-service=1
```

Removing these from `index.js` unwires a **live payment trigger** and the **POS-sale → print**
trigger. Classification: **REMOVED — SECURITY/BEHAVIOR_CHANGE**, not a cleanup.

### The printer chain is the current release payload

Production runs branch **`release/r1-pos-printer-fn`**. The five printer-host functions the
candidate drops are precisely what that release exists to ship. Removing them is not a
plausible intent.

## The 5 live exports only the candidate has

```
getPaymentDestination   savePaymentDestination   sweepCommissionDue
getCommissionBalance    getSellerRestriction
```

These are **live** and absent from both production lineages — the same finding that halted the
merge originally. Any reconciliation must **keep** them. Per instruction, the
payment-destination pair is treated as **export-governance only**: they are exported by the
candidate, deployed, and their implementation source remains UNRECOVERABLE. **Not modified.**

## The 31 genuinely new surfaces

Unreviewed. Each is a new client-reachable or triggered surface, and an export-count increase
is not evidence of safety. They include Supply/procurement, Sokoni Till, manual till, order
claim, pickup PIN and multishop checkout families. **None assessed here** — this gate measured
the deployed graph, not new-feature intent.

## Internal surfaces — 🟢 no regression

| | `delete exports._internal` | underscore-prefixed exports |
|---|---|---|
| lineage A | 1 | 0 |
| lineage B | 1 | 0 |
| candidate | 1 | 0 |

The `_internal` suppression relied on by the `application-lifecycle` security gate is present
in all three. The candidate does **not** re-expose it, and no `_h`-style hook leaks into the
deployed surface.

---

## Evidence classification

| claim | basis |
|---|---|
| 946 live exports, 18 removals, 5 candidate-only live | 🟢 **deployed-observed** — 1002 Cloud Run services |
| three removals are registered triggers | 🟢 **deployed-observed** — Eventarc |
| export sets and module bindings | 🟢 **source-proven** |
| runtime effect of removal | ⚪ **production-unproven** — nothing was deployed or invoked |

---

## Verdict

# ⚠️ REQUIRES_HUMAN_DECISION

`SAFE_TO_RESOLVE` required the candidate to preserve the union of live exports and their
wiring, or to prove each difference non-live. It does neither: **18 live exports disappear, 3
of them registered triggers**, and none has been shown obsolete.

### Recommended shape

**Reconcile `index.js` as a union, not a selection.** It is an export/wiring authority — a
better implementation elsewhere does not license changing exposure, and absence from one commit
does not prove a function is dead. Concretely:

1. Start from the **union** of live exports across both lineages plus the 5 candidate-only live
   ones — 964 live exports that must all survive.
2. Keep all 18, with the three trigger registrations intact.
3. Review the 31 new surfaces **individually** as feature decisions, not as merge fallout.
4. Leave the payment-destination pair exported and untouched pending source recovery.

That is materially larger than this gate and needs its own authorisation.

```
production deployed   NO
production mutated    NO
worktree              clean
files changed         NONE
```
