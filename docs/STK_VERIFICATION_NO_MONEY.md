# STK verification without moving customer money

**Date:** 2026-08-28
**Suite:** `scripts/test-stk-implementation.js` — **58 passed, 0 failed**
**Money moved:** none. No STK push was sent. The only network call was an OAuth
token request to the **sandbox** host.

> **Lineage warning.** `functions/payment-destinations.js` and
> `functions/checkout-mode.js` are **NOT deployed** — they exist only on the desktop
> working tree, not on the production lineage (live `b223635`). Sections D and E
> therefore certify the *implementation*, not production behaviour. In production
> today there is no merchant-STK rail at all.

---

## 1. KASS Shop merchant STK configuration

Read from production, **shape only** — no secret value was read into the log.

| field | value |
|---|---|
| `darajaShortCode` | `174379` — Safaricom's public **sandbox** shortcode |
| `darajaEnv` | `sandbox` |
| `darajaTransactionType` | `CustomerPayBillOnline` — consistent with a PayBill |
| `darajaAccountRef` | `SOKONI-SBX` |
| `darajaConsumerKey` / `Secret` / `PassKey` | present (48 / 64 / 64 chars) |
| `paymentDestinations.productionAuthorized` | **false** |
| `paymentDestinations.activeDestination` | **null** |

**Finding — duplicate seller record.** A second KASS seller `xrH21J5GFbW8PluCZ2ny5nIuf602`
exists with no `shopSettings` and no `paymentDestinations`. Consistent with the known
[[KASS account merge]] issue. Not touched.

## 2–3. Payload construction and field mapping

The real `stkBody` object literal is extracted from `functions/index.js` and **evaluated**
with controlled inputs, so an inverted field fails the suite rather than passing a grep.

- `BusinessShortCode` = `PartyB` = merchant shortcode; `PartyA` = `PhoneNumber` = payer.
  Asserted that **PartyA ≠ PartyB**.
- `Amount` is `authoritativeAmount` — the server figure, never a client one.
- `AccountReference` → config, then business name, then `"SOKONI"`; capped at **12**.
- `TransactionDesc` capped at **13** (Daraja rejects longer, and non-ASCII).
- No credential can appear in the payload.
- One `CallBackURL`, the single `darajaSTKCallback`.

### Phone normalisation — three defects, now FIXED

Gate 2 of the pre-production checklist. All three are closed by a single canonical
helper `_normalizeMsisdn()` in `functions/index.js`, used by all three STK sites.

| # | defect | before | after |
|---|---|---|---|
| D1 | `00254712345678` mis-normalised | `2540254712345678` (16 digits, sent) | `254712345678` |
| D2 | `darajaSTKPush` had **no** validation | any shape prepended `254` and sent | refuses, `invalid-argument` |
| D3 | seller-phone ownership check **failed OPEN** | guard skipped when the stored phone was missing or not 12 digits | refuses, `failed-precondition` |

**D3 was the more serious one and was not in the original list.** The guard read
`if (sellerPhone && sellerPhone.length === 12 && phone !== sellerPhone)`. A seller with
no stored phone — or a stored phone that did not normalise — skipped the check entirely
and could send a live KES 1 STK push to **any** handset. Rate limiting (3/hour) capped the
blast radius; the check itself did not. An authorisation check that cannot be evaluated
must refuse, so it now does.

```
0712345678      -> 254712345678      07123456789   -> null  (11 digits)
+254712345678   -> 254712345678      071234567     -> null  (9 digits)
254712345678    -> 254712345678      ''            -> null
712345678       -> 254712345678      null / undef  -> null
0112345678      -> 254112345678      'not-a-phone' -> null
00254712345678  -> 254712345678      0812345678    -> null  (non-mobile range)
```

Accepted values must match `254[17]d{8}` exactly. `sendTestSTKPush` already validated
length, so D2 applied only to `darajaSTKPush` — the **live, customer-facing** path.

> **NOT SHIPPED.** These edits are in the desktop working tree. `functions/index.js` on the
> production lineage (`b223635`) still carries the old expressions. To ship, reapply on a
> worktree cut from the live commit — never deploy the desktop tree.

### The same bug exists in 8 further modules — deliberately not changed

`.replace(/^0/, '254')` is copy-pasted in `dispatch.js`, `finos.js`, `finos-utils.js`,
`impact.js`, `payment-orchestrator.js`, `pos-qr.js` and `sub-engine.js` (×2). Two of them
carry a `.replace(/^254254/, '254')` patch for a related symptom, and
`payment-orchestrator.js` does not strip non-digits at all. Those are **payout and dispatch**
paths, outside the STK slice and outside this review's scope. Converging them on
`_normalizeMsisdn()` is the obvious follow-up and should be its own change with its own
tests — not smuggled into an STK fix.

## 4. Correct endpoint, permitted environment

Live check against the **sandbox** host with KASS's sandbox credentials:

```
configured env         "sandbox"
host used              https://sandbox.safaricom.co.ke
HTTP status            200  (670ms)
access_token           returned (not printed)
expires_in             3599
```

The host selector is executed for every value: anything that is not exactly
`"production"` — `""`, `undefined`, `"prod"`, `"Production"`, `null` — resolves to
**sandbox**. There is exactly one production-host literal in the file.

## 5. Callback handling and reconciliation

`darajaSTKCallback` — exactly one exported STK callback. It checks caller IP against an
allowlist, refuses an unknown `checkoutId`, treats an already-processed callback as a
no-op (replay-safe), compares the **paid** amount against the **stored requested** amount,
and labels sandbox callbacks as sandbox rather than silently accepting them as production.

## 6. The production gate

`resolveActiveDestination()` executed against fixtures:

| state | result |
|---|---|
| no document | `null` — refuse, never a default |
| no `activeDestination` | `null` |
| destination `TESTING` / `FAILED` | `null` |
| `VERIFIED` + `productionAuthorized:false` | `production_not_authorized` |
| `VERIFIED` + flag **absent** | `production_not_authorized` (fail-closed) |
| `VERIFIED` + `"true"`, `1`, `"yes"`, `"TRUE"` | **still blocked** — only boolean `true` opens it |
| `VERIFIED` + `true` | allowed, and only then is a destination returned |

## 7. Configuration is not authorisation

`checkout-mode.js` never reads `shopSettings` and never reads a Daraja credential field.
Holding a consumer key cannot produce a payable mode. Only `blocked:null` yields
`daraja_stk`; `production_not_authorized` yields `manual_payment`; **an unrecognised block
yields `unavailable`, never a payable route**.

**KASS as configured today resolves to `unavailable` — no STK is offered.**

## Proved by sabotage

A suite that has never failed proves nothing. Each check read on exit code:

| sabotage | result |
|---|---|
| production gate weakened to a truthy check | exit 1, **4** failures |
| unauthorised merchant routed to STK | exit 1, 1 failure |
| an unknown block made payable | exit 1, 1 failure |
| host selector inverted | exit 1, 1 failure |
| restored | exit 0, 0 failures |

Source files restored byte-identical after each.

## What this does NOT establish

- Nothing about **production** merchant STK — that rail is not deployed.
- No STK push was sent, so the end-to-end push → callback → reconciliation path is
  **not** exercised here. The sandbox track was closed separately on 2026-08-25.
- `productionAuthorized` remains **false** and must stay so until Safaricom resolves the
  authorisation / Merchant-of-Record question. **A passing suite is not a reason to open it.**

Related: [[Merchant-Owned Payments]] · [[Commission Enforcement Contract]] · [[SmartPOS]]
