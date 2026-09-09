# Slice 1 — index.js reconciliation: no change warranted

**From:** `f1453fe` · **`functions/index.js` NOT modified.** Nothing deployed, no implementation
module touched.

# Outcome: the reconciliation target is empty once the freezes are applied

The gap between the worktree index and the live production union is **7 exports — and all 7
are inside a frozen boundary.** Nothing outside those boundaries needs adding, and nothing
needs removing.

---

## Nothing is at risk — the 18 are already preserved

The earlier gate found 18 live exports *the candidate would remove*. The worktree index is not
the candidate: **all 18 are present**, verified individually.

```
missing of 18: 0
```

Triggers `onPaymentIntentPaid` · `onPosSaleCompleted` · `onPackageRequestChanged`; the five
printer-host functions; the three verification callables; `adminLinkMerchantAccounts`,
`employeeSaleAuthorize`, `posSendPurchaseOrder`; and the four payment exports. **The risk
existed only in adopting the candidate index. Not adopting it removes the risk entirely.**

Internal suppression intact: `delete exports._internal` ×1, underscore-prefixed exports **0**.

## The gap: 7 live exports, every one frozen

Worktree index carries **1514** exports. Live union across all three sources: **953**. Missing:

| export | boundary | disposition |
|---|---|---|
| `getPaymentDestination` | **PAYMENT — PROTECTED** | not added |
| `savePaymentDestination` | **PAYMENT — PROTECTED** | not added |
| `posInitiateTerminalPaymentV1` | **POS TILL-ON — FROZEN** | not added |
| `posCancelTerminalPaymentV1` | **POS TILL-ON — FROZEN** | not added |
| `sweepCommissionDue` | **WALLET/LEDGER — PROTECTED** | not added |
| `getCommissionBalance` | commission (wallet/ledger family) | not added |
| `getSellerRestriction` | seller authority, deployed | not added |

Adding an export **creates exposure** for the surface it names. For the four payment and POS
entries that is precisely what "do not modify any current POS Till-On export" and the payment
protection forbid. The remaining three sit in the same wallet/ledger and seller-authority
families and were not separated out to act unilaterally on.

**This is a real finding, not an evasion:** these seven are deployed and running, yet absent
from every index lineage in this tree. That is the same provenance gap found at `ee24802` —
production runs code no repository index exposes. It is resolved by the source-recovery and
export-governance work already queued, not by editing the index during a frozen-payment slice.

## The 31 new candidate surfaces — none authorized

Supply/procurement, Sokoni Till, manual till, order claim, pickup PIN, multishop checkout.
Each is `NEW — REQUIRES FEATURE DECISION`. *"The candidate has it"* is not authorization, and
no prior Slice 1 work establishes any of them.

---

## Daraja removal — 🔴 BLOCKED

Reference resolution on all six, in the worktree index:

| export | total refs | export line | comment | other code | pattern |
|---|---|---|---|---|---|
| `darajaSTKPush` | 5 | 1 | 1 | 3 | self-contained |
| `darajaSTKCallback` | 17 | 1 | 1 | 15 | own log statements + a live `callbackUrl` string built by `darajaSTKPush` |
| `validateDarajaCredentials` | 4 | 1 | 1 | 2 | self-contained |
| `sendTestSTKPush` | 4 | 1 | 1 | 2 | self-contained |
| **`initiateSTKPush`** | 7 | 1 | 0 | 6 | **comments inside five OTHER live functions** |
| `webhookMpesa` | 2 | 1 | 0 | 1 | one comment |

`darajaSTKPush`/`darajaSTKCallback` are a closed pair, and their references are their own
bodies. **`initiateSTKPush` is the blocker.** Its references are explanatory comments *inside
other live functions*, describing current behaviour in terms of it:

```
"initiateSTKPush writes uid — so the checkout confirms via THIS authed …"
"compliance gate inside initiateSTKPush"
"initiateSTKPush enforces against. See functions/payment-intents.js"
"legacy payments without that field … (since this fix)"
```

Live code is **documented relative to it**. Whether the behaviour those comments describe is
still current, or the comments are stale, is unresolved — and that is exactly the ambiguity the
instruction says must block removal. Compounding it, these are payment surfaces and payment is
frozen for this slice.

**DARAJA REMOVAL BLOCKED.** Undeployed is not sufficient evidence of dead.

---

## Report

```
implementation commit          none — index.js unchanged
live production exports preserved   953 of 953 reachable from this tree; 18 at-risk all present
live production exports removed     0
new exports added                   0
Daraja six                     BLOCKED — initiateSTKPush referenced by live-code comments
IntaSend                       untouched; webhook provenance still BLOCKED
POS Till-On                    untouched (2 live exports absent from index — frozen, not added)
cards                          untouched
wallet/ledger                  untouched
triggers preserved             all, including the 3 the candidate would drop
internal exposure              suppressed — delete exports._internal x1, 0 underscore exports
tests                          not run — no implementation changed; running them would prove
                               nothing about a no-op
files changed                  documentation only
production deployed            NO
production mutated             NO
worktree                       clean
```

## What this means for Slice 1

`index.js` cannot be meaningfully reconciled while payment, POS Till-On and card are frozen,
because **every remaining difference falls inside those boundaries.** That is not a failure of
the slice — it is the freeze working as intended.

The two genuinely open items, both outside this slice:

1. **Export governance for the 7 live-but-unexposed functions** — they run in production while
   no index lineage in this tree exports them. Needs the payment freeze lifted, or a
   deliberate carve-out for the three non-payment ones.
2. **Daraja removal** — needs the `initiateSTKPush` comment references adjudicated: is the
   behaviour they describe live, or is the documentation stale?
