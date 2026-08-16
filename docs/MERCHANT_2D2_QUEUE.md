# Merchant Consolidation — the authoritative queue

> Hand-maintained. The per-stage evidence lives in the census artifacts:
> [[MERCHANT_2D2_AUTHORITY_CENSUS]] · [[MERCHANT_MARKETING_AUTHORITY]] ·
> [[MERCHANT_CUSTOMERS_AUTHORITY]] · [[MERCHANT_CAPABILITY_MAP]]

## Status

| stage | state | commit |
|---|---|---|
| shopEmployees convergence | ✅ done | `0d1acdf` |
| Team / Staff | ✅ done | `d062c63` |
| Marketing | ✅ done | `a7ef31e` |
| Disputes | ✅ done | `eaefe47` |
| Messages | ✅ done | `59b6ffe` |
| Customers | ✅ done | `50f6e99` |
| Store | ✅ done | `51780ed` |
| **Tax** | **ready to build** — census clean, account-level | — |
| Receipts | **blocked** — no merchant receipt-list authority + 3 security fixes | — |
| Stories | new server authority required | — |
| Orders | **blocked** — divergent store | — |
| Flash Sales | **blocked** — divergent store | — |
| **Fulfilment / Delivery** | **audit required — see below** | — |

### Security stages (kept deliberately separate from UI commits)

| finding | state | commit |
|---|---|---|
| `orderAdvance` accepted any signed-in caller | ✅ fixed | `1d49634` |
| `posLookupCustomer` returned any customer platform-wide | ✅ fixed | `9360cbd` |
| `_resolveSellerId` trusts `req.data.sellerId` when no claim exists | **open** | — |
| `posCompleteCheckout` updates `posCustomers/{client-supplied id}` | **open** (frozen sales path) | — |
| numeric `role` gate inverts for string claims (`marketing-engine`, `b2b-wholesale`) | **open** | — |
| `followShop` could create `minishopConfig/{arbitrary shopId}` | ✅ fixed | `0e6a1f5` |
| `emailTrustReceipt` mails any receipt to any address for any signed-in caller | **open** — high | — |
| `sendPOSReceipt` delivers arbitrary client-composed branded receipts to arbitrary recipients | **open** — high | — |
| `posLogReprint` accepts an uncorroborated `merchantId`; mutates any order's reprint counter | **open** — medium | — |
| `posGetQueueMetrics` queries `posCheckoutMetrics` by client-supplied `merchantId` | **open** — medium | — |
| `posReceipts` rule gates on `sellerId`; 3 of 4 writers emit `merchantId` | **open** — medium | — |

Receipts/Tax detail: [[MERCHANT_RECEIPTS_TAX_AUTHORITY]].

**Receipts and Tax are not one screen.** Tax is entirely server-decided (`etimsProfiles/{auth.uid}`
— the uid *is* the doc id, no client identity anywhere) and can be built now, labelled as an
**account-level** setting because tax identity has no shop dimension. Receipts has no
merchant-scoped list authority at all and sits behind the five findings above.

---

## FULFILMENT / DELIVERY — a workstream, not a sub-task of Orders

**Orders does not cover Fulfilment.** They are adjacent authorities over the same
document, and conflating them is how a merchant screen ends up mutating a rider's
state or exposing a delivery PIN:

```
ORDER
  ↓  payment / order authority
FULFILMENT
  ├── merchant prepares
  ├── pickup / dispatch
  ├── rider assignment
  ├── in transit
  ├── delivered
  └── exception / cancellation
```

This is a **security-sensitive** stage, not a UI conversion. It is scheduled
after Store and **must be audited before the merchant system is called complete**.

### Audit checklist — to be answered from bodies, not names

1. Order → fulfilment lifecycle, and which field is the **authoritative** status.
2. Merchant / shop ownership of every fulfilment action.
3. Rider assignment, and the **rider-safe order projection**.
4. Pickup / dispatch / in-transit / delivered transitions, and who may set each.
5. Cancellation / void / refund interactions with an in-flight delivery.
6. Delivery PIN handling — issue, storage, verification, and who can read it.
7. Merchant visibility **vs** rider visibility, as two distinct projections.
8. Shop / location scoping on `sellerUid` + `shopId`.
9. Notifications at each legitimate transition, and only legitimate ones.
10. The mobile merchant fulfilment screen.
11. **No client-side status mutation bypassing the server.**
12. **No exposure of `deliveryPin` or other non-rider-safe order fields.**
13. Fulfilment history / audit trail.
14. Interaction between POS orders and marketplace orders.

### What is already known, and what must be re-verified

Established by the `orderAdvance` security stage (`1d49634`):

- `orderAdvance` is the only order-status authority. It now resolves the caller's
  relationship to the order and enforces a **stage → actor** map: a seller may
  `accept`/`preparing`/`ready`, a rider may `picked_up`/`halfway`/`near`/
  `delivered`, nobody may set `paid` or self-`assign`. That map is the starting
  point for item 4, not the answer to it.
- The `accepted` stage sets `status:'confirmed'`, which `onOrderStatusChange`
  watches to fire **rider auto-assignment**. Any fulfilment UI touches dispatch.

Present in the codebase and **not yet audited**:

- `functions/fulfilment-lifecycle.js`, `functions/fulfilment-scan.js`,
  `functions/delivery-pin.js`, `functions/delivery-complete.js`,
  `functions/dispatch.js`, `functions/logistics-plus-dispatch.js`.
- `fulfilment-scan.js` defines a `_riderView(order, delivery, active)` projection —
  its completeness is item 7 and item 12.
- `delivery-pin.js` stores `deliveryPinHash` on the package and writes the
  plaintext `deliveryPin` to a buyer-visible location; `delivery-complete.js`
  verifies against the hash. Whether the plaintext is reachable from any
  rider-visible path is item 6 and **must be re-checked** — the standing note that
  a rider could read `deliveryPin` predates these modules and is not assumed
  either way here.

### Rule carried into this stage

Same as every stage so far: trace the write path before choosing a scope
identifier, judge each authority by its opened body rather than its name, and
keep a client-supplied scope id out of the authorization boundary. Three findings
in a row have come from that last one.
