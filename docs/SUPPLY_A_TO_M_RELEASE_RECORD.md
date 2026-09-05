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

## The gate — traced 2026-09-05, and NOT what it was previously recorded as

**Correction.** This blocker was previously described (including in earlier revisions of this
record) as *"two untracked files with no provenance, so `functions/index.js` cannot be
required."* That description was wrong in both halves. The trace:

### `functions/index.js` loads from the WORKING TREE. The tracked tree is a different question.

Substituting **HEAD's** committed `pos-zero-friction.js` for the working copy — without
modifying the working copy — `require('./index.js')` **succeeds**, exporting **1718** names
including `findSuppliers`, `getSupplyCatalogue`, `servicesDispatch` and `smartPosDispatch`.

**Correction (2026-09-05).** An earlier revision of this section said "the module graph at HEAD
is closed". That was wrong, and the error was in the measurement: the closure scan walked the
**filesystem**, where other workstreams' untracked files are present, so it measured the
working tree and reported it as the tracked tree. A deploy uses a checkout, not this disk.

Scanning the **git tree** instead — `git ls-tree` for the file set, `git show` for the sources —
gives the real position:

| ref | tracked `functions/*.js` | unresolvable local requires |
|---|---|---|
| before the tenant-identity commit | 382 | **5** |
| after it (`24f50ba`) | 383 | **4** |

The one that closed was `tenant-identity` ← `procurement.js`, `business-bootstrap.js`. The four
that remain are all from `index.js`:

| missing module | ever committed on any ref? | on disk here? |
|---|---|---|
| `order-claim` | no | yes (untracked) |
| `manual-till-orders` | no | yes (untracked) |
| `commission-invoice` | no | yes (untracked) |
| `pos-mpesa-refs` | once, at `233ac4d` | yes (untracked) |

All four `require` lines entered the **tracked** `index.js` at `fa5082b` (2026-08-30, *"Rail-B
multi-shop checkout"*) — this branch's own lineage, committing an `index.js` that references
four modules the same commit did not commit. The Supply slices did not introduce them: `db89191`
and `714b38d` each added exactly one `exports.` line to that file.

So a **clean checkout of `release/multishop-checkout-certified` still cannot load
`functions/index.js`.** The tenant-identity commit removed one of five gaps of this class, not
the class itself.

### That one require lives inside another workstream's uncommitted edit

| | |
|---|---|
| unresolvable require | `./merchant-identity` |
| required by | `functions/pos-zero-friction.js` — **working copy only** |
| at HEAD | that file does **not** reference `merchant-identity` at all; its closure is complete |

The file does not exist in this working tree. It is not missing provenance — it is committed
history that this branch does not carry, and the workstream editing `pos-zero-friction.js` has
introduced a dependency on it without bringing it into the tree. **That edit is not ours and
must not be touched.**

Two divergent committed versions exist, and which is canonical is not a question this record
answers:

| ref | blob | size |
|---|---|---|
| `7ecd119` (2026-08-21, on `audit/employee-attribution`) | `a36997f` | 46,554 bytes |
| `release/merchant-identity` (tip `6801185`) | `ccc43cf` | 20,818 bytes |

`7ecd119` does export `_internal.resolveActor`, which is the shape the dirty edit imports.
**But its signature is `resolveActor(uid, requestedShopId)` and it reads `shops/{shopId}`,
while the dirty edit calls `resolveActor(cashierId, merchantId)`** — the two identifier spaces
this entire workstream exists to keep apart, which coincide only in the owner-uid form. That is
a flag for the owner of that edit, not a finding about their finished work: it is a dirty file,
and nothing may be inferred from it.

### `functions/tenant-identity.js` is NOT a load blocker

It exists in this tree, resolves, and is required successfully by five modules
(`procurement.js`, `business-bootstrap.js`, `pos-retail-engine.js`, `pos-staff-ops.js`,
`pos-zero-friction.js`).

Its provenance is **established, not mysterious**: the local file is **byte-identical** to a
committed blob — sha1 `4d89a1da854f8a05e41147661dfff42654a4bf3b`, committed by Alex Ogutu at
`25d2c19` (2026-09-04) and present on `feature/sales-control-centre-approvals` and
`feature/void-permission-convergence`. Nothing would need to be reconstructed.

What it *is*: an **uncommitted-file risk on this branch**. `release/multishop-checkout-certified`
carries no copy, so a clean checkout of this branch breaks five modules, including the
`procurement.js` that every Supply certification depends on. Committing it here would be a
cherry-pick of known, identical content — but that is a branch-content decision and has not
been taken.

### So the real position

Nothing in the certified Supply stack blocks a functions deploy, and
`functions/tenant-identity.js` is now committed (`24f50ba`, byte-identical to `25d2c19`). What
still stands between this branch and a functions deploy is **not** Supply work:

1. **Four modules `index.js` requires are untracked** — `order-claim`, `manual-till-orders`,
   `commission-invoice`, `pos-mpesa-refs`. Three have never been committed on any ref. Each
   needs its own owner and provenance decision, exactly as tenant-identity did.
2. **`merchant-identity.js`** — another workstream's in-progress edit to
   `pos-zero-friction.js` depends on it; two divergent committed versions exist; that
   decision is theirs.
3. **The lineages have diverged**, and production was itself built from a dirty tree.

None of these is resolved here, and no deployment has been performed.

---

## The deployment statement

> **A clean checkout of the current branch still cannot load `functions/index.js`; four
> tracked-tree local dependencies remain unresolved.**

That is materially different from "the graph is closed", and the difference is the whole point
of this section.

**Presence on disk is not closure.** Those four modules are sitting in this working tree right
now as other workstreams' untracked files. A deploy uses a checkout, not somebody's disk. The
filesystem scan that reported closure was measuring the wrong thing, and any future scan that
consults the filesystem will make the same mistake.

**No deployment may be attempted until all four are resolved or explicitly dispositioned
through the release gate.** Their per-file provenance is already established in
`docs/UNTRACKED_FUNCTIONS_PROVENANCE_CENSUS.md` (2026-09-04): `order-claim` has no provenance
anywhere and is classified **C — escalated, unresolved**; `manual-till-orders` and
`commission-invoice` are documented but deliberately gated on decisions never taken;
`pos-mpesa-refs` is a proven foreign port. Disposition is a founder decision, not an
engineering one.

### It is now enforced, not merely written down

`fa5082b`'s own commit message declared *"NEVER deploy FULL index.js"* — but the mitigation was
a sentence, and `predeploy-syntax-gate.js` runs `node --check`, which parses a file and never
resolves a `require()`. Nothing could catch this class.

`scripts/gate-functions-require-closure.js` walks the transitive require graph from
`functions/index.js` over the **git tree** and exits non-zero when the entrypoint cannot load.
Certified at **41 checks, 5 sabotage catches** by
`scripts/test-functions-require-closure-gate.js`, including the control that matters: the same
gate **passes** on `fa5082b^` with 321 modules, so it discriminates rather than always failing —
and that independently confirms closure broke at `fa5082b`.

It is deliberately **not wired into `firebase.json`**. Wiring a predeploy hook is a
deployment-configuration change and remains a founder decision.

### Documentation integrity

Two corrections in this record (`671782a`, `ef68822`) exist because generated documentation
needs content-integrity verification after shell-mediated writes: backticked identifiers were
command-substituted out of a paragraph by bash, shipping a commit with holes in it. The same
class as the `cmd.exe` caret defect recorded earlier — **content passed through a shell is
content the shell may rewrite** — and the reason those two commits stand rather than being
squashed away.

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
