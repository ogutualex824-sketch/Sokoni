# The 11 undeployed `rc/combined` commits — go/no-go review

**Status:** AWAITING DECISION. **Nothing has been deployed.**
**Live:** `cdfc8ab` (branch `rc/combined`, built 2026-08-18T06:08Z, `sokoni-20260818060826-v523`)
**This branch:** `fix/merchant-shell-capability` = `rc/combined` (`c5f7151`) **+ 7 commits**

Related: [[MERCHANT_SHELL_CAPABILITY]] · [[RELEASE_STATE]]

---

## Why this review exists

"Deploy v2 alongside v1" looks additive. It is not, from this lineage. Production is **11 commits
behind `rc/combined`**, so any hosting deploy from here ships those 11 as well as our 7 — 18
commits, not 7. They ride along whether or not they are ready, so each needs a decision.

One more thing makes this urgent rather than tidy: **`version.json` on live reports
`"dirtyWorkingTree": true`.** The live build was deployed from a tree with uncommitted changes, so
live content is not reproducible from any commit. A clean deploy may revert something that is live
and exists nowhere in git. Nobody should deploy from this lineage until that is understood.

## What actually reaches production

`firebase.json` ignores `docs/**`, `scripts/**`, `functions/**` and `**/*.md`. Verified live:
`docs/RELEASE_STATE.md` → **HTTP 404**. So of the 43 files in the `cdfc8ab..HEAD` delta, only
**27** deploy — and of the 11 commits under review, only **five files** reach users:

```
pos-db.js        pos-mobile.js      ← inventory client   (ca1e8ca)
pos-mobile.css   pos.html           ← checkout layout    (13515cb)
seller.css                          ← host-mode nav      (c5f7151)
```

Everything else is release documentation, CI gates, or Cloud Functions that a hosting deploy does
not touch.

---

## ⛔ BLOCKER — hosting and functions cannot be separated

`ca1e8ca` adds `PosDB.products.correctStock()`, which calls the **`merchantAdjustStock`** Cloud
Function and deliberately throws rather than write anything locally if the server does not agree —
that strictness is the point of the change.

It is **already wired to a live control**: `pos-mobile.js:445` calls it for the **restock** action.

`merchantAdjustStock` is exported in `functions/index.js` on this branch but is **NOT deployed to
production**. So:

> **Deploying hosting without first deploying `merchantAdjustStock` breaks POS restock in
> production.** Today it works (live `pos-mobile.js` still uses the local `adjustStock`). After a
> hosting-only deploy it would throw, and by design nothing local changes — the merchant simply
> cannot restock.

This also affects Merchant v2: `sokoni-merchant-inventory-ui.js` and `sokoni-merchant-stock.js`
call the same function.

**Order is therefore fixed: Cloud Functions first, verified, then hosting.** Not a preference.

---

## Commit-by-commit

### Group A — documentation only (5 commits) · **no production surface**

| commit | subject |
|---|---|
| `86f6946` | one authoritative release-state ledger |
| `de9dbed` | record the six POS paths as STATICALLY REVIEWED, not proven |
| `758b027` | permanent workstream-gate structure + merchant completion census |
| `8b8cc4b` | six-area census — NOT BUILT = 0, the gap list is empty |
| `0ee5690` | POS merge verified 8/8 — BUILT, not proven |

All touch only `docs/RELEASE_STATE.md`, which hosting ignores. **Recommend: GO** — zero risk, and
`758b027` is the authoritative release record memory already points at.

### Group B — tooling only (2 commits) · **not shipped to users**

| commit | file | effect |
|---|---|---|
| `1ea4d35` | `scripts/deploy/bump-sw-version.js` | raises the SW counter floor to **v530** |
| `4b1686d` | `scripts/gate-inventory-writers.js` | registers `merchantAdjustStock` as a server inventory authority |

`1ea4d35` matters **for** the deploy rather than in it: live is at `v523`, and the floor stops the
counter regressing. **Recommend: GO, and take it before any deploy** — it is the guard, not the
payload.

### Group C — POS inventory, client + server (2 commits) · **the blocker**

| commit | files |
|---|---|
| `ca1e8ca` | `functions/merchant-inventory.js` (new, 205 lines), `functions/index.js`, `pos-db.js`, `pos-mobile.js`, + a 206-line test |
| `96bce0b` | `functions/merchant-inventory.js` — align the runtime with the POS callables |

This is a genuine correctness improvement. The old `adjustStock()` wrote IndexedDB **first** and
pushed canonical "best-effort, online-only", so an offline correction *looked* applied and could
silently never persist. `correctStock()` writes local state only **after** the server agrees, and
with the server's number. It is explicitly **not** for sales — `posCompleteCheckout` still owns a
sale's decrement, so the same units cannot be deducted twice — and it requires a stable
`adjustmentId` so a double tap is idempotent server-side.

**Recommend: GO — but functions FIRST.** Deploying the client half alone is the blocker above.
`scripts/test-merchant-adjust-stock.js` ships with it and should be run against the deployed
function before the hosting half.

### Group D — POS checkout layout (1 commit) · **the "NOT accepted" one**

`13515cb` — `pos-mobile.css` (+149), `pos.html` (+23). The commit subject says *"layout only, POS
NOT accepted"*, which is easy to misread as "unsafe to ship". Read the diff: it means POS as a
whole is not **certified**, not that this change is unproven.

What it actually does is fix a defect that stops a merchant taking money:

> The payment prompt had **no keyboard handling at all**. Typing a customer's phone number raised
> the iOS keyboard directly over the button that sends the STK push — the merchant could enter the
> number and then not reach the control that charges it.

The `pos.html` half is now purely a sensor (it publishes `--pos-kb-inset` on `<html>`); the layout
decision moved into CSS.

**Recommend: GO** — it repairs a blocking payment interaction. But it is a **POS surface change and
POS is not certified**, so it wants a real-device check on the M-PESA modal before it is called
done. That is a founder call, which is why it is listed rather than assumed.

### Group E — seller host mode (1 commit) · **coupled to our work**

`c5f7151` — `seller.css` (+30), suppresses `seller.html`'s own navigation when hosted inside the
merchant shell.

Not optional for us: the capability layer **downgrades seven routes to `seller.html#<sec>`**, and
without this the legacy seller nav renders inside the merchant shell — two navigations on one
screen. It is already the base commit of this branch.

**Recommend: GO — required by the merchant work.**

---

## Recommended order

```
1. Group A + B      docs and CI               no deploy involved
2. FUNCTIONS        merchantAdjustStock       + run test-merchant-adjust-stock.js
3. verify           POS restock still works on live
4. HOSTING          the 27 deployable files   (guard-no-rollback allows: HEAD is ahead of cdfc8ab)
5. verify           version.json = our commit; /merchant-v2 200; /merchant unchanged
6. smoke test       /merchant-v2 in production
```

The rollback guard will **not** stop this deploy — `cdfc8ab` is an ancestor of our HEAD, so it is a
move forward, not a rollback. The guard is silent on whether the 11 commits are *wanted*, which is
what this document is for.

## Open questions for the founder

1. **`dirtyWorkingTree: true` on live.** What was uncommitted at the last deploy? Until that is
   known, any deploy risks reverting live content that exists in no commit.
2. **`13515cb`** — ship the POS keyboard fix now, or hold it until POS is device-accepted? It fixes
   a payment-blocking interaction, which argues for now.
3. **Bottom-nav till slot** — the certified registry re-points it `pos` → `sell`. v1 resolves the
   declared `fallback:'pos'`, so v1's bottom bar is unchanged. Confirm that is intended.
