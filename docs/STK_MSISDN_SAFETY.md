# STK MSISDN safety — three fixes on the live lineage

**Branch:** `fix/stk-msisdn-safety`, cut from live **`b223635`**
**Status:** committed, gate-certified, **NOT deployed** (this is a *functions* deploy)
**Money moved:** none. No STK push sent. `productionAuthorized` untouched.

---

## Why

`darajaSTKPush` is live and is called from `pos.js`. It normalised phone numbers with
`.replace(/^0/, "254")`, which rewrites only the **first** zero, then sent whatever
resulted. Three defects followed.

| # | defect | before | after |
|---|---|---|---|
| D1 | `00254712345678` mis-normalised | `2540254712345678` — 16 digits, **sent** | `254712345678` |
| D2 | `darajaSTKPush` had **no** validation | any shape got `254` prepended and was sent | refuses, `invalid-argument` |
| D3 | seller-phone ownership check **failed OPEN** | guard skipped entirely | refuses, `failed-precondition` |

**D3 was not in the original brief and is the most serious.** The guard read
`if (sellerPhone && sellerPhone.length === 12 && phone !== sellerPhone)`. A seller with no
stored phone — or one that did not normalise to 12 digits — **skipped the check entirely**
and could send a live KES 1 test push to *any* handset. Rate limiting (3/hour) capped the
blast radius; the check itself did not. An authorisation check that cannot be evaluated
must refuse.

`sendTestSTKPush` already validated length, so D2 applied only to `darajaSTKPush` — the
customer-facing path.

## The fix

One canonical `_normalizeMsisdn()` in `functions/index.js`, used by all three STK sites.
It returns `254XXXXXXXXX` or **null**; every caller refuses on null.

```
0712345678      -> 254712345678      07123456789   -> null  (11 digits)
+254712345678   -> 254712345678      071234567     -> null  (9 digits)
254712345678    -> 254712345678      ''            -> null
712345678       -> 254712345678      null / undef  -> null
0112345678      -> 254112345678      'not-a-phone' -> null
00254712345678  -> 254712345678      0812345678    -> null  (non-mobile range)
```

Accepted values must match `254[17]\d{8}` exactly.

## Scope deliberately NOT taken

The same expression is copy-pasted in **8 further modules** — `dispatch`, `finos`,
`finos-utils`, `impact`, `payment-orchestrator`, `pos-qr`, `sub-engine` (x2). Two carry a
`/^254254/` patch for a related symptom; `payment-orchestrator` does not strip non-digits
at all. Those are **payout and dispatch** paths. Converging them belongs in its own release
with its own tests, not smuggled into an STK fix.

## Gates

`scripts/test-stk-msisdn-safety.js` — **37 passed, 0 failed**. Sends nothing: `fetch` is
replaced with a tripwire that records and throws, and the suite asserts it was never called.

`scripts/verify-stk-production-authorization.js` — **9 passed, 0 failed**, read-only against
**production data**, because `payment-destinations.js` does not exist on this lineage and a
source assertion would prove nothing:

- **no** seller anywhere has `productionAuthorized === true`
- **no** seller has a VERIFIED active destination
- KASS: `productionAuthorized: false`, `activeDestination: null`, env `sandbox`, shortcode
  `174379` (Safaricom's public sandbox PayBill, not a real till)
- carries controls proving the collection was actually read and the field is present —
  otherwise "none are authorised" is indistinguishable from a query that found nothing

### Proved by sabotage

The guards are **executed**, not pattern-matched. That mattered: a source regex passed even
when `if (!normPhone)` was replaced with `if (false)`, because it only proved the throw was
*nearby*. The gate was strengthened until every sabotage was caught.

| sabotage | result |
|---|---|
| drop the `00`-prefix handling | exit 1, 2 failures |
| remove the length/range validation | exit 1, 11 failures |
| make the ownership check fail-OPEN again | exit 1, 3 failures |
| let `darajaSTKPush` send without validating | exit 1, 2 failures |
| restored | exit 0, 0 failures |

`functions/index.js` byte-identical after each.

## The three gates that remain

1. **Safaricom** — production authorisation / merchant-of-record decision. External.
2. **Engineering** — this branch. Committed and certified; deploying it is a **separate,
   explicit decision**, and a *functions* deploy rather than hosting.
3. **Real sandbox E2E** — STK to callback to reconciliation against the sandbox
   configuration. Not exercised here by design.

**The production customer rail remains IntaSend.** Merchant-owned STK must not become
reachable merely because gate 2 is green. `productionAuthorized` stays `false`.

Related: [[Merchant-Owned Payments]] · [[SmartPOS]] · [[Payment Trust]]
