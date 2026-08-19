# Merchant v2 — Release Board

**This board is deliberately honest.** A green unit suite is not a shipped feature, and
"written" is not "runtime proven". Nothing here is marked done because a page rendered.

**Branch:** `fix/merchant-shell-capability` · **Worktree:** `C:/temp/sok-compat`
**Production:** `c1df168` / v534 · `MERCHANT_URL` = `/merchant` · **V2 CUTOVER: BLOCKED**

Related: [[RECEIPT_CONTRACT]] · [[CANONICAL_ORDER_DESTINATION]] · [[MERCHANT_V2_TARGET_ARCHITECTURE]] · [[MESSAGES_PARTICIPANT_ANCHORING]]

---

## The board

| Area | State | Finish condition |
|---|---|---|
| **Subscription catalogue** | 🟢 79/0 code-certified | — |
| **Entitlement authority** | 🟢 79/0 code-certified | — |
| **Trial single-use** | 🟢 79/0 code-certified | — |
| **Inventory entitlement** | 🟢 79/0 code-certified | — |
| **KASS live account** | 🔴 VERIFIED BROKEN — two accounts | see docs/KASS_PRODUCTION_VERIFICATION.md |
| **KASS shop↔subscription link** | 🟡 REPAIR BUILT 34/0, NOT APPLIED | admin link + resolution; production write pending decision |
| **Merchant account link** | 🟢 34/0 code-certified | admin-only, auditable, ambiguity refused |
| **Counter recount tool** | 🟡 DRY-RUN VERIFIED | --apply NOT run; 103 and 0 are the measured truths |
| **productCounters (KASS shop)** | 🔴 −23 vs 103 real | cap BYPASSED, not enforced |
| **Payment / webhook** | 🟢 PROVEN on the paying uid | KES 499 COMPLETE, webhook received in 30s |
| **Renewal lifecycle** | 🔴 UNPROVEN | not traced |
| **Production trigger** | 🔴 UNPROVEN | not deployed |
| **KASS KES 499 entitlement** | 🔴 UNPROVEN | what was purchased must be established first |
| **Starter entitlement** | 🔴 BROKEN — reproduced | ai_starter resolves to FREE while reporting ACTIVE |
| **Free trials** | 🔴 NOT IMPLEMENTED | no eligibility machinery exists at all |
| **Inventory entitlement** | 🔴 DEPENDENT | one canCreateProduct() authority for add + inventory |
| **Role boundary (data layer)** | 🟢 44/0 vs LIVE rules (+1 unproven) | — |
| **Merchant identity** | 🟢 51/0 (+2 unproven), NOT DEPLOYED | a real employee completes a real sale |
| **Employee sale authority** | 🟡 BUILT, enforcement OPEN | posCompleteCheckout must consult the attribution |
| **Product create approval** | 🔴 SEPARATE security decision | do not bundle with the employee-sale fix |
| **cdGetShiftSummary** | 🔴 SEPARATE money-reporting issue | decision before relying on that summary |
| **Role switcher (UI)** | 🔴 MUST BUILD + CERTIFY | Instagram-style switcher; A-clears-before-B in the rendered workspace |
| **Opening cash** | 🟡 WIRED, UNIT-CERTIFIED 60/0 | needs journey certification + a real shift end-to-end |
| **Sell** | 🟡 COMPOSED 40/0 | one supermarket flow, journey-certified |
| **Online orders** | 🔴 MUST JOURNEY-CERTIFY | managed beside physical sales in one workspace |
| **Receipts** | 🟡 CONTRACT GREEN 113/0 + Role line | served-by wiring: authority BUILT, shell not wired |
| **Messaging authority** | 🟢 51/0 | — |
| **Message history rules** | 🟢 21/0 | — |
| **Messaging production** | 🔴 OPEN | Function + live rules deployed together, then production verified |
| **Locations** | 🔴 OPEN INTEGRATION | buyer location → Sell → delivery receipt → rider |
| **V2 production cert** | 🟢 18/0 | extend with Sell / role / receipt journeys |
| **P58E** | 🔴 HUMAN | real printer walk |
| **POS iOS** | 🔴 HUMAN | real-device keyboard test |
| **`MERCHANT_URL`** | `/merchant` | flip only when every gate above is genuinely green |

Unit suites currently green: receipt contract 113/0 · shift/cash 60/0 (+1 unproven) ·
cash 55/0 · sell composition 40/0 · fulfilment 38/0 · idempotency 38/0 · buyer
locations 26/0 (+1 unproven) · capability 42/0 · exit 18/0.

Role boundary: **44 passed, 0 failed, 1 unproven** against `firestore.rules.live` in the
Firestore emulator — real rules, not mocks.

**No "unproven" is a pass.** Three stand: buyer-location ownership isolation (emulator was
unavailable for that suite); whether any merchant has hit the cash-drawer defect (needs a
production query); and whether `firestore.rules.live` still matches the deployed ruleset
(no gcloud token this session, so the releases API was not queried).

---

## Journeys — the gate that actually matters

None of these are certified yet. Counting isolated green suites as "finished" is the
failure mode this section exists to prevent.

| | journey | state |
|---|---|---|
| **A** | open shift → search → cart → customer here → cash → change → receipt | 🔴 |
| **B** | cart → delivery → saved/new location → rider choice → payment → receipt | 🔴 |
| **C** | new online order → accept → prepare → message → fulfil → receipt → complete | 🔴 |
| **D** | switch to employee → sell → receipt names the EMPLOYEE → switch back | 🔴 |
| **E** | buyer → merchant → employee → merchant → buyer | 🔴 |
| **F** | each of the above under refresh · back · double-tap · slow network · session restore | 🔴 |

Invariants every journey must hold: **one sale, one order, one stock mutation, one
receipt.**

---

## Open findings

### 1. `cdGetShiftSummary` disagrees with the canonical till formula — LIVE

`functions/pos-cash-drawer.js:283` is deployed (`functions/index.js` exports it) and
computes expected drawer cash from the same event stream as
`functions/pos-cash-manager.js:90` — with **three** differences, all of which overstate
the drawer:

| | canonical (`pos-cash-manager`) | `cdGetShiftSummary` | effect |
|---|---|---|---|
| cash pickup | `- cashPickups` | `+ till.cashPickup` | **2× the pickup too high** |
| cash refund | `- cashRefunds` | *absent entirely* | full refund value too high |
| cash sales | sale events | `posDrawerLog` drawer-**opens** | a phone till reports **zero** |

Measured in `scripts/test-shift-cash.js` §10: a 5,000 pickup reports 18,000 against a
canonical 8,000. It also requires **manager claims**, which a solo merchant does not
have — so a merchant running the till from their phone cannot call it at all.

The client `pos-cash-manager.js:197` agrees with the canonical formula, so
`cdGetShiftSummary` is the outlier of three implementations.

**Not fixed here.** It is a deployed money-reporting path and the fix changes reported
figures; it needs an explicit decision, not a drive-by edit. New code does not inherit
it: `sokoni-shift.js` uses the canonical formula, asserted character-for-character
against the deployed one.

### 2. `servedBy` has no source

The receipt contract names the person who served — employee for an employee sale, owner
for an owner sale, omitted when unknowable. `sokoni-merchant-sell.js` passes
`ctx.servedBy` straight through and never synthesises it. **No shell populates it.**
Until the merchant identity authority lands, real receipts omit the line.

### 3. The order destination migration gate is still closed

The till captures, displays and prints a destination but **does not write one**. Proven
at runtime: zero of 14 known spellings appear in the checkout payload at any depth. Do
not open this without the broader multi-seller census — see [[CANONICAL_ORDER_DESTINATION]].

### 4. An employee has NO data access to the shop they work for — measured

Certified in `scripts/test-role-boundary.js` §7 against the live rules. `products` and
`orders` are keyed to `sellerUid == request.auth.uid`, so an employee of shop A:

- cannot create or edit a product for their employer;
- cannot read their employer's orders.

The boundary is airtight — that is the *good* news. But it means **an employee sale
cannot go through client writes at all.** It must go through a server callable that
checks `shopEmployees`. Journey D is blocked on that callable existing, not just on
`servedBy` having a source.

### 5. `products/create` has no approved-seller gate — measured

An ordinary buyer with **no seller claim** successfully created a product against the
live rules (§9). The rule is `isActive() && isAuthed() && sellerUid == request.auth.uid`
— pure uid-ownership, with no claim and no approval check anywhere in the products
block. Seller approval is therefore enforced *above* the rules, not at the data layer.

Consistent with the frozen seller-approval finding. Recorded, not fixed — tightening it
touches a live write path used by every seller.

### 6. `rc/combined` deploy blocker

Production is behind and a hosting-only deploy breaks POS restock
(`merchantAdjustStock` undeployed). Any deploy must be functions-first.

---

## Money invariants now enforced

Both are certified with **mutation controls** — the defect is constructed and the
assertion is shown to catch it. An invariant test that cannot fail is not evidence.

1. **Opening cash is not revenue.** The float is the merchant's own money for making
   change. It moves the drawer and nothing else — structurally, because it is not in the
   set of event types `salesTotal()` sums. A summariser that counted it would report
   12,950 where the truth is 7,950.
2. **M-PESA is not cash in the drawer.** Phone payments are revenue but not physical
   money and cannot fund change. Only `cash` tenders move the drawer, and they move it
   **net of the change handed back** — recording the gross tender overstates the drawer
   by the change on every cash sale.

---

## Cutover rule

`MERCHANT_URL` stays `/merchant` until every gate above is genuinely green. That
preserves the current production merchant experience while the operating system
underneath it is finished.
