# Supply A→M — Release Record

**Status: ENGINEERING-COMPLETE. NOT PRODUCTION-PROVEN.**
Recorded 2026-09-05 · Milestone head `49e81a1` on `release/multishop-checkout-certified`

> Nothing in this record asserts that any of this work is running. No deployment has been
> performed, attempted, or may be inferred from any certification below.

---

## The distinction this record exists to preserve

**Engineering-complete** means: the behaviour is implemented, and every claim about it was
proved by executing the real code, sabotaging it, watching the suite go red, restoring it
byte-identically, and watching it go green.

**Production-proven** means: it has run in production, against real data, for real merchants.

**Supply A→M is the first. It is not the second, and the gap between them is not a formality.**
Every suite below runs against injected fixtures and DOM doubles. None of it has executed
against a live Firestore, a live callable, or a real merchant session. Firestore rules, indexes,
App Check, cold-start behaviour, quota, latency and every interaction with the other 172
handlers in `smartPosDispatch` remain unexercised by this work.

---

## Live production, verified — not inherited from a document

```
commit        d592d8f8892316c8d4ba1f6f54cc62416000ba12  (d592d8f)
cacheVersion  sokoni-20260902200425-v632
branch        release/r1-pos-printer-fn
buildTime     2026-09-02T20:04:26.419Z
```

Read from `https://mysokoni.co.ke/version.json` with a cache-buster on 2026-09-05.
`docs/RELEASE_STATE.md` is stale and was not consulted.

**The lineages have diverged.** `d592d8f` is **not** an ancestor of `49e81a1`: production was
built from `release/r1-pos-printer-fn`, this milestone sits on
`release/multishop-checkout-certified`. Neither contains the other. Any future release of this
work is a merge decision, not a fast-forward, and that decision has not been made.

Production also reports `dirtyWorkingTree: true` — it was built from a tree that was not clean.
That is a separate provenance question and is not resolved here.

---

## What A→M actually is

```
Find Suppliers → Supplier Business → Supply Catalogue → Draft
   → addSupplier + createPurchaseOrder → Approval → Send
   → Incoming → Receiving/GRN → Inventory → Invoice → Payment ledger → Analytics
```

| slice | commit | what it established |
|---|---|---|
| pre-A | `1f7f909` `5a45d34` `e331182` | supplier-sync authority; no fabricated BI metrics; a PO is "sent" only on backend confirmation |
| A | `e8293f7` | merchant-scoped authority primitive |
| B | `18aa183` | two competing PO engines collapsed into one |
| B2 | `b239ae5` | SOKONI supply relationships — a counterparty is `businesses/{id}`, never a duplicate identity |
| C | `e691823` | merchant-scoped approval + send |
| D | `742d5b2` `4b56369` | GRN/receiving; receipt idempotency and cumulative state |
| E | `94ab168` | supplier invoice + payment |
| F | `9d221e5` | auto-reorder onto canonical PO drafts |
| G | `fc5fccd` | local-draft reconciliation |
| H | `74a31db` | Merchant V2 business-identity resolution |
| I | `6f211cf` | merchant-scoped read layer |
| J1 | `54d1011` | Supply workspace module |
| J2 | `0a6244a` | the Supply route |
| K | `db89191` | Find Suppliers — discovery, opt-in, positively allowlisted |
| L | `714b38d` | Supply Catalogue; the fabricated B2B catalogue deleted |
| M | `49e81a1` | end-to-end integration; discovery → purchase order |

**Certification total: 18 suites, 1276 checks, 129 sabotage catches, all exit 0 at `49e81a1`.**

### The commercial rules the chain preserves

* **Placing an order is not sending an order.** Approval and sending keep their own authority gates.
* **The pre-submission figure is an estimate and is labelled one.** Subtotal, VAT and total are
  computed server-side; after placement only the server's figures are displayed.
* **A SOKONI business is a canonical counterparty.** It is never relabelled by a buyer and never
  duplicated as a second supplier identity.
* **Discovery consent and supply participation are separate.** A supplier can trade with
  existing buyers without appearing in the directory.
* **Nothing is invented.** No minimum order, price, saving, rating, availability or supplier is
  ever manufactured; an unknown renders as a dash, never as zero.

---

## What is NOT proven, and must not be claimed

1. **No deployment.** Not attempted. Deployment is on HOLD and is blocked below.
2. **No live execution.** Every certification is fixture-driven. No callable in this chain has
   been invoked against production.
3. **No production data has exercised the chain.** All procurement collections are **empty** in
   production — `procSuppliers`, `procPurchaseOrders`, `procGRNs`, `procSupplierInvoices`,
   `procWarehouseStock`, `procStockMovements` are all 0 documents, and no business has
   `supply.enabled` or `supply.discoverable` set. The chain has never carried a real order.
4. **Firestore rules and indexes are unverified for these paths.**
5. **The Supply UI has never been rendered in a real browser session** for these slices.

---

## The gate: the Functions module graph cannot be loaded

`functions/index.js` **cannot be `require`d**, so no functions deploy can succeed regardless of
how well-certified the application code is. Two dependencies are **untracked**:

| file | required by | since |
|---|---|---|
| `functions/tenant-identity.js` | `procurement.js` (Slice B2, `b239ae5`), `business-bootstrap.js` | before B2 |
| `functions/merchant-identity.js` | `pos-zero-friction.js` (another workstream) | — |

Neither may be recreated, copied, or reconstructed. Exact source, owner and intended lineage
must be established first — a file that is required by certified code but has no provenance is
a worse problem than a missing file, because it will be deployed and trusted.

---

## Deferred, deliberately

Supply: chronological ordering and the indexes it needs · deeper warehouse views · richer
discovery/search · a supplier verification system (there is no business-level attestation today;
`verifications` is user-keyed and empty) · the invoice-total authority decision · a real
settlement rail.

Independent defects: `getPOSInventoryIntelligence` 500 · the `pos-bi.html` KPI missing-field →
`0` coercion · `b2b.html` and its siblings, which now render truthful empty states but are
customer-facing and not yet wired to a business-scoped authority.

---

**Do not read any certification in this repository as evidence that Supply is live.**
Live is `d592d8f` / v632, and it does not contain this work.
