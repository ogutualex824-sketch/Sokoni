# M0-4a — Abandoned POS commission payment attempts converge through ONE confirm authority

**Status:** built on the POS lineage (base `6d8b0da`) 2026-09-28. **Not deployed.**
**Related:** [[FINANCIAL_CORE_ARCHITECTURE]] (M0-3, M0-4a/4b, M0-5), [[POS-0b-checkout-integrity]].

## Why

M0-3 (`pos-commission-settlement.js`) made one state machine for settling POS commission, but left three gaps:
- **Attempts could stay OPEN forever.** An attempt whose gateway outcome was unknown, whose provider never answered,
  or whose merchant never came back to Confirm stayed OPEN with its debt claims **HELD** indefinitely. Nothing
  expired or re-checked it. The code deferred this to "the M0-4 sweep".
- **The confirm logic could not be reused.** It (provider status → judge → transition) was written inline in the
  Confirm callable, so a scheduler could only reuse it by copying it, which would be a second settlement path.
- **Review could overwrite PAID.** `markNeedsReview` was a **plain update with no status check**. Proven on the pre-M0-4a
  tree (X-0, 3 of 3 runs): two Confirms read an attempt as OPEN; one completes it (PAID, debt SETTLED); the
  other's late review then overwrites it to **NEEDS_REVIEW while its debt is already SETTLED**.

## What changed (`functions/pos-commission-settlement.js`)

1. **`confirmAttempt(payId, { by })` is THE confirm authority.** It reads the provider status, applies `judgeEvidence`,
   and makes exactly one transactional transition. The Confirm callable (after its unchanged permission check) and
   the sweep both call it, and there is no other settlement path.
2. **Every transition checks its source state inside its own transaction** (`opts.from`). Otherwise it is a replay that writes nothing:

   | Evidence | Transition | Allowed from |
   |---|---|---|
   | proven COMPLETE | `completeAttempt` | OPEN; FAILED (M0-3 F-4: proven money after a failure still settles an OUTSTANDING, unclaimed debt) |
   | provider FAILED / EXPIRED / … | `failAttempt` (claims released) | OPEN |
   | COMPLETE not proven (amount, currency, api_ref) | `markNeedsReview` | OPEN; FAILED (a mismatched completion after a failure is a money signal) |
   | PENDING | none | — |

   `markNeedsReview` is now transactional and defaults to OPEN only. **NEEDS_REVIEW is left alone** by Confirm and by
   the sweep: that is M0-5. PAID and PAID_RECONCILE are final. Cash confirm and cancel pass no `from` and keep their
   certified M0-3 behaviour.
3. **`sweepOpenAttempts` / `posCommissionAttemptSweep`** runs every 15 min, Africa/Nairobi, as one instance with no automatic retry. For each OPEN
   IntaSend attempt (cash is never touched), timed from its persisted `createdAtMs`, so a delayed or missed run changes
   nothing:

   | Condition | Action |
   |---|---|
   | younger than **10 min** | untouched, and not even read at the provider (leaves the interactive Confirm its time) |
   | has a provider reference | `confirmAttempt` |
   | still PENDING / provider silent **30 min after eligibility** (createdAt + 40 min) | NEEDS_REVIEW, never guessed failed |
   | no reference, provider **never called** (crash between opening and the call) | expired: FAILED, claims released, debt OUTSTANDING |
   | no reference, gateway rejected | FAILED |
   | no reference, outcome unknown or accepted-without-reference | **NEEDS_REVIEW**, never expired: a prompt may have reached the phone |

   The sweep never opens a payment and never sends an STK. Its only provider calls are status **reads**. It touches no
   wallet (business or personal) and never blocks the till (`GATE_ENFORCED` stays false).
4. `functions/index.js` re-exports `posCommissionAttemptSweep` by name.

## Evidence

- **`scripts/test-m04a-attempt-sweep.js`** (real module, Firestore emulator, scripted IntaSend double; **nothing is sent**): **24/0 new** vs **1/20 old** (`6d8b0da`).
  - On the old tree the sweep and confirm authority are absent, and **X-0 reproduces the review-over-PAID defect** (attempt NEEDS_REVIEW, debt SETTLED; 3 of 3 runs).
  - The race cases force both provider reads to overlap with a barrier. X-1 has both read COMPLETE and makes ONE PAID transition, settling the debt once. X-2 has the two reads return conflicting answers, and exactly one transition wins.
  - The thresholds are tested at the edges: 9m59s untouched and 10m processed; OPEN 1 ms before the cap and NEEDS_REVIEW at it.
- **M0-3 `test-m03-commission-payment`:** 31/0, unchanged, including under every mutant run against it.
- **Mutants:** 13 of 13 caught, one per safeguard:
  - min-age, the pending cap, and the cap measured from opening rather than eligibility;
  - pending treated as failed;
  - unknown outcome expired, never-called sent to review, and no-reference attempts left OPEN;
  - review as a plain update, review from PAID, and review not left alone;
  - the sweep touching cash;
  - the complete source guard dropped;
  - the callable keeping its own confirm path.
- Floor and earlier units: CHANGELOG 169.

## Boundaries

- **Not here:**
  - M0-4b (the 07:00 business-wallet collector; held for FC-1);
  - the debt-reconciliation unit (sale-without-debt; next after M0-4a);
  - M0-5 (review resolution);
  - the stale 06:00 reminder copy (its own unit);
  - any scheduled M-PESA prompt (a separate policy decision).
- **Deployment prerequisites (unchanged):**
  - the controlled KES 10 live proof;
  - M0-6;
  - `INTASEND_PRIVATE_KEY` bound to the sweep;
  - the live-rules fetch;
  - the deploy of the M0-3 callables it serves (none are deployed).
- **Production today:** 0 commission attempts, debts or claims (read-only, 2026-09-28).
