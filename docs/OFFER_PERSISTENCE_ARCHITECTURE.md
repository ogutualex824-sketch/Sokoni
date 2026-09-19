# Offer persistence — the authority, the schema, and what is still owed

**Status:** DESIGN CERTIFIED · IMPLEMENTATION BLOCKED on a Cloud Functions deploy
**Date:** 2026-09-19 · **Gate:** P
**Evidence:** `scripts/test-offer-record.js` — **64/0**
**Supersedes the "why" in** [[Offer Persistence Decision]] (`OFFER_PERSISTENCE_DECISION.md`),
which remains correct and is still the short warning.

Nothing was deployed. No rules were changed. No write was implemented.

---

## 1. There are three different things called "offer", not two

The earlier record identified two. Reading the server established a third, and the
distinction is what the whole gate turns on.

| | store | authority | shape | touches price? |
|---|---|---|---|---|
| **Admin price drop** | `offers` | Firestore rules, `isAdmin()` | `productId`, `offerPrice`, `originalPrice`; one active per product | yes, admin-set |
| **Admin marketing placement** | `promotions` | callables in `functions/promotions.js`, all `_assertAdmin` | `placement`, `title`, `body`, `ctaUrl`, `priority` | **no** — and `FORBIDDEN_PLACEMENTS` bars checkout, payment, wallet, dispute, refund outright |
| **Merchant offer** (the Studio) | **none** | **none** | bundles, BXGY, happy hour, stacking, schedules, conditions | yes, merchant-set |

`promotions` is a **banner engine**. It carries no price, no discount, no qualifying
listings and no stacking, and its own header states that nothing is injected into checkout
"Ever". It cannot represent a merchant offer without total semantic loss.

Both existing authorities are pinned by the suite (§8): if a later change makes `offers`
merchant-writable, drops `offerPrice < originalPrice`, removes an `_assertAdmin`, or gives
`promotions` a price field, the suite fails.

## 2. The authority should be a callable, not rules

This is the gate's main finding, and it changes what unblocking costs.

Merchant writes in this codebase do **not** go client-direct through rules. They go through
a callable that authorises against the shop. `merchantAdjustStock` is the reference:

```
1  authenticate        req.auth.uid, or refuse
2  validate            explicit, before anything else
3  authorise           assertShopAccess(uid, shopId)  ← the SHOP, never a claim
4  apply once          caller-supplied id makes it idempotent, inside a transaction
   enforceAppCheck: true
```

`assertShopAccess` → `resolveShopAccess` resolves owner, employee or platform admin — the
same workforce authority that already answers for the till, refunds, duty and rosters. It is
the correct owner of "may this person write this shop's offers", and it exists today.

**Consequences of choosing the callable:**

* **No new Firestore rules are required for the write path.** Rules do not secure callables
  ([[feedback_firestore_rules_do_not_secure_callables]]), and the frozen, reopened rules
  lineage is avoided entirely rather than negotiated with. A read path may still want a
  rule; that is a smaller, separable question.
* **The server stays authoritative on price**, which the offer design has claimed on every
  surface from the start — the Studio preview, the card and the offer panel all say the
  figure is a display quote and *"the price you pay is confirmed at checkout"*. A
  client-direct write would leave that promise unbacked.
* **Ownership cannot be forged.** `shopId` comes from the resolved scope, never the payload.

**What it costs:** a Cloud Functions deploy — and function deploys are **frozen** under the
Artifact Registry forensics notice ([[project_ar_canary_forensics]]). So implementation is
blocked, but on a *different and better-understood* constraint than rules, and one with a
named owner and an exit condition.

## 3. The schema, certified before any write exists

`sokoni-offer-record.js` is the boundary: `toRecord(offer, scope)` and `fromRecord(doc)`. It
performs no I/O, names no collection and is not a writer — asserted by the suite. It is what
`ctx.saveOffer` would send, wherever that is decided to go.

**Ownership from the scope only.** A payload naming `shopId: 'someone_elses_shop'` is
discarded; the record carries the resolved shop. Same rule the certified product writer
follows.

**Absent stays absent.** `minSpend: 0` is a rule that always qualifies; an absent `minSpend`
is no rule at all. Writing one as the other changes what customers are charged, so unset
fields are omitted rather than stored as `null` or `0`. A blank schedule
(`{days:[], from:'', to:''}`) collapses to absent, because storing it would make `isLive()`
evaluate an empty window.

**Idempotency by construction.** `offerDraftId(scope, draftToken)` is derived from the shop
and the merchant's own draft token — never a clock, asserted — so a retry after a dropped
response claims the same document instead of creating a second offer. Deliberately the same
shape as the product writer's `productDraftId`; two idempotency schemes in one codebase is
one too many.

**Status normalises conservatively.** Anything unrecognised becomes `draft`, never `live`,
and the resolver is proven to price nothing for draft, scheduled or archived.

## 4. How "no semantic loss" was proven

Not by comparing fields — that only proves the fields someone remembered to compare. Every
offer type is **resolved twice**, once as authored and once after `toRecord → fromRecord`,
and the resolver's entire output is compared: bundle, percentage, fixed, BXGY, spend-and-save,
free delivery, free item, inventory-limited, redemption-limited, and three stacked together.

Two completeness guards sit behind that, both derived from **source** rather than memory:

* every `o.<field>` the **resolver** reads must be in the schema;
* every `o.<field>` the **customer surface** reads must be in the schema.

### The second guard earned its place immediately

`regularValue` was missing from the schema. The resolver never reads it, so **every total
matched exactly** — resolver-equivalence was completely blind to it. What it cost was the
customer's *"SAVE KES 651"* on both the card ribbon and the offer panel: the single line an
offer exists to show. Found before any write existed, which is the entire argument for doing
the schema gate before the implementation gate.

## 5. What Gate P still owes

These need the persistence authority to exist, and are honestly marked UNPROVEN in the suite:

* server-side authorisation actually refusing a non-member (needs the callable);
* cross-shop isolation at rest (needs stored documents to isolate);
* redemption accounting — `promotionUsage` exists for the admin engine; whether merchant
  offers share it or need their own counter is undecided, and it interacts with
  `inventoryLimit`;
* where the resolver runs at checkout. Today every surface says the price is confirmed at
  checkout; making that true means the resolver runs server-side before an order is priced.

## 6. The decision an owner still has to make

1. **Collection.** A new top-level collection with a `shopId` field matches the products
   convention (`assertInScope` scopes by field, not path). Suggested: `shopOffers`.
   Not `offers`, not `promotions`.
2. **Who may write.** `resolveShopAccess` already answers owner / employee / admin — decide
   whether staff may publish offers or only draft them.
3. **Redemption accounting.** Shared with `promotionUsage` or separate.
4. **Checkout resolution.** Where the server applies the offer, and what it does when the
   client's display quote and the server's answer disagree.

Related: [[Offer Persistence Decision]] · [[project_merchant_offer_store_absent]] ·
[[project_workforce_authority_convergence]] · [[project_ar_canary_forensics]]
