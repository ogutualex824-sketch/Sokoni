# RES-1 option 1 — a quote carried from the checkout session is bound to its order

**Branch:** `res1-opt1/bind-session-quote` (from main line `9405e3a`) · **NOT landed, NOT deployed**
**Related:** [[RES-1 delivery quote binding]] · [[R5-rider-entitlement-authority]]

## Why

In the RES-1 investigation (2026-09-26), I ran the real quote endpoint, checkout session, binder, carry and Repair 5
authority on the emulator, with each order path taken separately:

| order path | before |
|---|---|
| verify first (browser survives) | pin on the order, quote bound → **Repair 5 pays** |
| **webhook first, session known** | carry finds the pin on the SESSION, but the quote stays `issued`, **unbound** → Repair 5 refuses `quote_not_bound_to_this_order` |
| webhook first, no session | no pin → Repair 5 refuses `no_pinned_quote` |

The webhook's order writer (`_finalizeMarketplacePayment`) never reads the session and never binds. The carry
therefore wrote an unbound quote onto the delivery record. RES-1's own certification (F5-4) passed exactly
this state.

An unbound quote is not single-use, and Repair 5 is right to refuse it.

## The change (server-side only)

The change is in `functions/delivery-quote-carry.js`. When the carry resolves the pin through the session, it now calls
`bindSessionQuoteToOrder`, which runs **one transaction**. All reads happen first, then all writes, and any refusal
writes nothing. The transaction does the following:

1. It requires the session to name **this** quote, with a pin whose `quoteId` is this quote.
2. It requires the session's buyer, the quote's buyer and the order's buyer (the Repair 2 identity precedence) to be
   the same uid.
3. It refuses a session already consumed by another order.
4. It refuses an order that already carries a **different** quote, so a bound quote is never replaced.
5. It binds the quote through the **one** single-use binder, `bindQuoteToOrderTx`. A quote consumed by another
   order is refused; the same order re-binding is a no-op.
6. It records the quote on the order and marks the session consumed by the order. That is the same state the
   verify path leaves.

If any check fails, the carry returns `pricingBlocked` with the reason, and no pin reaches a payable record.

The change reads no amount, refund, order total, delivery fee or `driverNet`. **Repair 5 is untouched**; it is
byte-identical to its landed version, and a test asserts this.

The **no-session** path is deliberately unchanged. It stays `no_pinned_quote`, and the buyer's open quote is never
inferred. Making the webhook know the session (payment reference → session) is **option 2**, a separate repair
that involves the payment/webhook provenance chain and `checkout.html` (another agent's work in progress).

## Evidence

### `scripts/test-res1-session-quote-binding.js`

The suite runs against the emulator with real code, apart from the two order writes and the delivery-record write,
which are mirrored and labelled as such.

It proves the **chain**, not merely a non-null entitlement:
- a real quote → the session that names it → the webhook-first order;
- the carry finds **that** quote, and it is bound to **this** order: exactly one bound, none minted;
- the order and the session record the binding;
- the delivery record carries that quote;
- Repair 5 derives **23,083 minor = the issued quote's `riderEarningMinor`**, paid to the assigned rider;
- replaying the carry is a no-op.

It also proves the security properties:

| property | result |
|---|---|
| quote bound to order A → order B presents A's session | refused `session_bound_to_another_order`; the quote stays A's; Repair 5 pays nobody on B; A is unaffected |
| quote bound to A by the **verify** path → B tries the session path | refused `quote_bound_to_another_order` |
| another buyer's order presents this buyer's session | refused `buyer_mismatch`; **nothing written** (quote still `issued`, session not consumed) |
| an order already bound to quote 1 is offered quote 2 | refused `order_bound_to_another_quote`; the order keeps quote 1 |

| target | result |
|---|---|
| repaired | **23 / 0** |
| old code (`9405e3a`) | **12 / 11 FAIL**: every binding and every security property fails. It passes only verify-first and no-session, which this repair leaves unchanged, plus the scope checks |

### `certify-res1-delivery-quote-binding.js`

The RES-1 certification is now **58 / 0**. F5-4 was strengthened from "falls back to the session" to "falls back to
the session **and binds the quote to that order**", and it now fails on the old tree. Its race order now carries the
buyer, as the webhook's order write does. Its in-memory store gained a `runTransaction` built on the harness's
existing read-first/commit-later `makeTx`.

### Regressions

None:

| suite | result |
|---|---|
| R1 | 39/0 |
| R2 | 26/0 |
| R3 | 21/0 |
| R4 | 33/0 |
| R5 | 32/0 |
| double credit | 66/0 |
| refund | 55/0 |
| escrow | 13/0 |
| RES-1b | GREEN |
| Gate C | GREEN |
| `test-delivery-quote-authority` | 128/0 on both trees |
| predeploy chain | passes |

The money chain is 32 passed / 7 failed, the same 7 pre-existing commission-ladder failures as `28b70e5`.

## Unchanged, by decision

- **The 13 existing production delivery records are untouched and stay blocked.** No quote was ever issued for them:
  production has 0 `deliveryQuotes` and 0 `checkoutSessions`, and all 10 orders predate policy v1. No quote is
  invented.
- **Deployment gate.** RES-1 must not be deployed piecemeal. The production chain has these gaps:
  - `requestDeliveryQuote` is not deployed;
  - the live checkout never requests a quote;
  - session, verify and webhook all predate RES-1.

  Production requires option 2 and the full quote → carry → payment chain, released as one unit, within the
  functions-lineage constraints.

**Sequence:** R1–R5 landed → RES-1 investigation → **option 1 (this)** → certify → option 2 separately → certify the
complete chain → only then consider deployment.
