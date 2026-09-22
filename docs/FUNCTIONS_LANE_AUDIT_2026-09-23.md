# Functions-Lane Audit — can a scoped deploy run?

**Date:** 2026-09-23 · **Tree:** `05c1f4e` · **Read-only. Nothing deployed, nothing modified.**
**Question:** is the scoped `smartPosDispatch` deployment executable today?

**Answer: NO — and not for the reason the dependency order assumed.**

---

## 1 · The headline correction

The provenance gap has been treated as the blocker for the functions lane. For a **scoped**
deploy it is not.

| Blocker | Applies to a scoped `--only functions:smartPosDispatch`? |
|---|---|
| merchant-identity provenance gap | **No** — a scoped deploy without `--force` does not delete unregistered live functions; it blocks an **unfiltered** deploy |
| **foreign `functions/` tree** | **YES — this is the binding constraint** |

Two different blockers were being conflated. Closing the merchant-identity lineage decision
would **not** unblock this deploy.

---

## 2 · Target is valid

`exports.smartPosDispatch = smartPosDispatcher.smartPosDispatch;` — `functions/index.js:11794`.
It is a real exported deployment unit, so the target itself is sound.

---

## 3 · Why it is blocked: a deploy ships the DIRECTORY, not the commit

`--only` selects which functions are **created/updated**. It does not select which **source**
is uploaded. The whole `functions/` directory is zipped and shipped, so every foreign file in
it reaches production and every module on the load path **executes at cold start**.

```
functions/index.js
 ├── payment-orchestrator.js        MODIFIED  +9/-3     ← required DIRECTLY by index.js
 ├── multishop-checkout-quote.js ──┐
 └── payment-intents.js ───────────┴── payment-purposes.js   MODIFIED  +277/-0
                                         └── shared/business-scope.js  UNTRACKED  179 lines
```

Verified by `require` inspection, not assumed:

| Module | Ownership | Reaches production? |
|---|---|---|
| `payment-orchestrator.js` | foreign, modified | **executes** — `index.js` requires it directly |
| `payment-purposes.js` | foreign, modified | **executes** — via both requiring modules |
| `shared/business-scope.js` | **foreign, untracked** | **executes** — via `payment-purposes` |
| `shared/intasend-checkout.js` | foreign, untracked, 236 lines | ships but **inert** — nothing requires it yet |
| `functions/.env` | foreign, modified | **takes effect** — see §4 |

**465 lines of unreviewed foreign code would execute at cold start**, 179 of them from a file
that is not even tracked in git.

---

## 4 · `functions/.env` is a live config change

`firebase.json` declares **no `ignore` list** for functions, and `.env` is not in Firebase's
default ignore set — it is the documented mechanism for function environment variables. So the
file ships and its values become production environment.

The delta changes exactly one key (value redacted):

```
DARAJA_SANDBOX_SELLER_UIDS
```

That is the Daraja sandbox seller allow-list — payment routing. An uncommitted, unreviewed
change to which sellers are in it would go live with any functions deploy. `.env` is
git-ignored, so the commit graph cannot show this change happened.

---

## 5 · What would unblock it

Only two paths, and the second is itself a new authorized action:

1. **The payment owner lands or removes their delta.** `functions/` returns to a state whose
   contents match a reviewed commit.
2. **Deploy from a clean snapshot of a known commit** rather than the working directory.
   Changing the deployment mechanism is a decision, not a workaround to apply quietly.

**Not acceptable:** committing the payment owner's files to make the tree clean. That would
attribute 465 lines of their in-flight work to another commit and ship it unreviewed.

---

## 6 · Consequence for the closure sequence

The sequence opens with `FOREIGN FUNCTIONS TREE → smartPosDispatch scoped deployment`. That
first arrow is **correct and currently blocked**, and it is blocked on the payment owner's lane
— the same lane that owns `checkout.html`.

So the functions lane and the payment lane share one gate. Closing the merchant-identity
decision does not move it; only the payment owner landing their work, or an authorized change
of deployment mechanism, does.

Everything downstream — the 5-operation production proof, catalogue → POS reachability, the
`seller.js` gates, the real catalogue-created POS sale — inherits that block.
