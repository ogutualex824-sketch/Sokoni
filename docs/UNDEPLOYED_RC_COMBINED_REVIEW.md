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

A second concern — **`version.json` on live reporting `"dirtyWorkingTree": true`** — looked like
"production matches no commit". It is **RESOLVED**: production *is* reproducible from `cdfc8ab`,
and the flag itself was broken in a way that made it permanently true. Full evidence in
[Open questions §1](#1-dirtyworkingtree-true-on-live--resolved-production-is-reproducible).

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

## Open questions — status

### 1. `dirtyWorkingTree: true` on live — **RESOLVED. Production is reproducible.**

Measured rather than assumed. Live bytes compared against the deployed commit `cdfc8ab` across
eight shipped files — `seller.css`, `pos-mobile.js`, `pos-db.js`, `shared-header.js`,
`sokoni-ui.js`, `auth.js`, `merchant.html`, `pos.html` — **all identical**.

`merchant.html` and `pos.html` first appeared to differ. They did not: cleanUrls **301-redirects**
a `.html` URL, so `curl` without `-L` was hashing a 24-byte redirect body. Fetched through the
clean URL with `-L` they match exactly. That is the documented cleanUrls trap and it nearly
produced a false alarm about production integrity.

The one real difference is `service-worker.js`, and **only its `CACHE_VERSION` line** — live `v523`
vs committed `v522`, byte-identical otherwise.

**Cause:** `generate-version.js` runs as predeploy **step 4**, and **step 3**
(`bump-sw-version.js`) has already rewritten `service-worker.js` in the tree; `version.json` is the
script's own output. A blanket `git status --porcelain` therefore **cannot** report clean, so the
flag was permanently `true` — and `release-gate.js:83` **fails on it unconditionally**. A gate that
can never pass is worse than no gate.

**Fixed** (`5853ddd`): dirtiness now means *edits the deploy pipeline did not make*.
`service-worker.js` is excluded **only if** its sole difference from HEAD is the `CACHE_VERSION`
line, so any other edit to it still counts; everything else counts. Exclusions publish as
`pipelineArtifacts` and real dirt as `dirtyPaths`, so the exclusion is auditable rather than
trusted. Proven on a clean throwaway worktree across five cases, including a stray edit alongside
the bump and an edit to the worker beyond its version line.

> **A clean release will now report `dirtyWorkingTree: false`**, which is the precondition you
> asked for — and it will report `true`, with paths, when it should.

### 2. `13515cb` — the POS keyboard fix · **NEEDS A REAL-DEVICE CHECK**

Not certifiable from code gates, and it should not be labelled certified because it passed them.
The focused check is below. If it passes, accept the fix; if it fails, it stays on its own POS
workstream and does **not** hold the v2 architecture.

### 3. Bottom-nav till slot — **ALREADY BEHAVIOURAL, evidence below**

The concern was that the fallback might be a hidden registry field leaving a visible button
pointing at a withheld route. It is not — the resolution happens when the bar is built, so the
rendered button *is* the fallback:

```
BOTTOM NAV:  [{"id":"home"},{"id":"orders"},{"id":"pos","label":"Sell"},{"id":"__more"}]
AFTER TAP:   {"hash":"#pos", "title":"POS", "frame":"mfx-pos"}
```

The slot renders `id=pos`, and tapping it lands on `#pos` with the POS panel mounted. **No merchant
can reach "This screen is not available in this version of Merchant" from the till button** — that
panel is only reachable by deep link, and the route gate asserts every bottom-nav slot resolves to
something this shell can mount.

The label reads "Sell" over a POS destination, which is **exactly what `rc/combined` ships today**
(`{ id:'pos', label:'Sell' }`), so v1's bottom bar is unchanged. v2 renders Sell natively and gets
the native surface. Confirm only if you want the *label* changed — the behaviour already matches
what you asked for.

---

## The POS iOS keyboard check (`13515cb`)

A human on a real iPhone. Simulators do not reproduce the visual-viewport behaviour this change
depends on.

| # | step | pass condition |
|---|---|---|
| 1 | Open `/pos` on a real iPhone, signed in as a merchant | POS loads, till visible |
| 2 | Add any item to the cart | cart total shows |
| 3 | Start checkout, choose **M-PESA** | payment panel opens |
| 4 | Tap the **amount** field | keyboard opens; the amount field stays visible |
| 5 | Tap the **phone number** field and type a number | **the STK-push button remains visible and tappable — this is the defect being fixed** |
| 6 | Tap the STK-push button **without dismissing the keyboard** | the push initiates |
| 7 | Dismiss the keyboard | layout returns with no gap or overlap left behind |
| 8 | Rotate to landscape, repeat 5–6 | button still reachable |

Also worth one pass on a **small** device (SE-class, 375×667), where the keyboard takes the largest
share of the viewport.

**If step 5 or 6 fails,** do not ship `13515cb` with the v2 deploy — it goes back to the POS
workstream. Nothing in Merchant v2 depends on it.

**If it passes,** it is accepted as a *fix*, not as POS certification. POS remains uncertified.

---

## Release gate board

```
MERCHANT V2
────────────────────────────────────────────────────────────
Shell preserved                    ✅  da8cd2df… byte-identical on the
                                       preservation branch
Certified route registry           ✅  2b8fc08d… byte-identical
Compatibility layer                ✅  wired into v1, 42/0
v1 blank routes                    ✅  0   (was 10, runtime-measured)
v2 native surfaces                 ✅  9   (9 distinct panels, 41/0)
Route gates                        ✅  v1 68/0 · v2 68/0 · runtime 500/12
Exit contract                      ✅  18/0 mutation controls
Exit runtime                       ✅  11/0
18 modules integrated              ✅  byte-identical, files not commits

POS Functions dependency           🔴  MUST DEPLOY/VERIFY
                                       contract agreement proven 25/0;
                                       logic proven 39/0; NOT deployed
Dirty production artifact          🟢  RESOLVED — production reproducible from
                                       cdfc8ab; flag fixed so a clean release
                                       now reports false (5853ddd)
SW floor                           🟢  VERIFIED ISOLATED — one hosting-ignored
                                       file; next deploy = v531 > live v523
POS iOS keyboard fix               🟡  REAL DEVICE TEST — checklist above
Till → Sell navigation             🟢  BEHAVIOURAL — renders id=pos, taps to
                                       #pos/mfx-pos; label unchanged from live

MERCHANT_URL                       /merchant        ← UNCHANGED, not flipped
PRODUCTION CUTOVER                 ❌  NOT YET
```

### What still stands between here and a deploy

1. **Deploy `merchantAdjustStock`** (+ `functions/merchant-inventory.js`) and verify an
   authenticated merchant stock adjustment against the deployed callable. This is the one red item
   and it is a hard prerequisite — `pos-mobile.js:445` already calls it.
2. **Real-device POS keyboard check** (checklist above) — decides whether `13515cb` rides along.
3. Then hosting, from a clean tree, with `version.json` expected to read
   `"dirtyWorkingTree": false`.

`MERCHANT_URL` stays `/merchant` throughout. The cutover is a separate, later decision that needs
production smoke tests, real-seller certification and the P58E human test first.

### Note on the authenticated stock-adjustment test

It cannot be run before the function is deployed. The Functions emulator is not configured in
`firebase.json` (only `firestore` and `auth` ports) and `functions/node_modules` is absent, so an
emulator run would need both added first — and it still would not exercise App Check, which this
callable enforces.

What **is** proven without deploying: the transaction logic against a Firestore double (39/0 —
ownership, idempotency, the zero floor, `sold` untouched), and the full client↔server wire contract
(25/0). What is **not** proven is the deployed callable answering a real authenticated merchant.
That is a post-deploy verification, and it is the thing to run first after the functions deploy.
