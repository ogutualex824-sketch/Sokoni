# Recovery manifest — UI / MiniShop / cart work from the diverged branch

**Date:** 2026-09-09 · **Read-only analysis.** Nothing merged, rebased, cherry-picked, applied
or deployed. Shared tree untouched at 235 uncommitted entries.

**Method:** the branch's own history was inspected commit-by-commit. The whole-tree diff was
**not** used to identify features — on a diverged branch its 216,666 deletions are an artefact
of missing production commits, not of the work.

---

## The candidates — 208 commits, 4 relevant

| commit | subject | files | scale | classification |
|---|---|---|---|---|
| `59b6ffe` | 2D-2 step 5 — Messages, composer that stays on screen | 7 | +1394 / −2 | **A — genuine feature, frontend only** |
| `9fe09e2` | messages: premium composer, filters, delivery cards, reactions | 6 | +1074 / −4 | **A — but backend-coupled** |
| `fa5082b` | Rail-B multi-shop checkout — certified checkpoint | 13 | +1827 / −106 | **A — but frozen-coupled** |
| `37aa41d` | wire `sellerAuthorizeHandover` / `completePickupWithPin` into UI | — | — | **C — FROZEN** (the handover feature explicitly excluded at `4a17401`) |

**No MiniShop-specific commit is unique to this branch.** MiniShop work is therefore either
already on the production lineage or was never here — classified **ALREADY PRESENT / NOT FOUND**,
not "lost".

---

## 🟢 RECOVERABLE — `59b6ffe` (merchant Messages)

```
CHANGELOG.md · merchant.html · sokoni-merchant-messages.js · sokoni-merchant-messages-ui.js
sokoni-merchant-routes.js · scripts/test-merchant-messages.js · scripts/test-merchant-messages-ui.js
```

**Zero `functions/` files. Zero payment, wallet, commission, ledger, Till-On or card files.**
Frontend, its own two test suites, and a changelog entry. Ships with its own tests, which is
what makes it recoverable rather than merely small.

*(An earlier automated check reported "frozen-named: 5" for this commit. That was a faulty
grep — the explicit file list disproves it. Recorded because a false positive in the frozen
check is the failure mode that would either block good work or wave through bad.)*

## 🔴 NOT SAFELY RECOVERABLE — `fa5082b` (multi-shop checkout)

The feature you most want, and it **cannot be split**:

```
cart.html · cart.js · checkout.html · sokoni-cart.js          ← the UI half
functions/multishop-checkout-quote.js  (311 lines, NEW)       ← backend the UI calls
functions/checkout-mode.js             (122 lines, NEW)       ← backend the UI calls
functions/payment-purposes.js          (+167)                 ← 🔴 FROZEN — payment
functions/index.js                     (+128)                 ← 🔴 out of scope — export governance
```

Recovering only the UI half would ship a cart calling `createMultiShopCheckoutQuote` and
`getShopCheckoutMode` — callables that would not exist, because exporting them is precisely the
`index.js` governance this task excludes. And the commit modifies `payment-purposes.js`, which
is frozen.

**Per the final rule: reported, not forced.** The multi-shop cart cannot be recovered without
crossing two boundaries that are deliberately closed.

## 🟡 BACKEND-COUPLED — `9fe09e2` (premium composer)

```
chat.html · messages.html · sokoni-chat-composer.js (485 NEW) · sokoni-chat-engine.js
scripts/test-chat-history-boundary.js
functions/messages.js  (+271)     ← backend behaviour change
```

No frozen file, but `functions/messages.js` is a **271-line backend change**, and its test is
named `test-chat-history-boundary` — a *boundary* test, implying message-history scoping, which
is security-sensitive. Under "any backend/security-sensitive portion must receive its own
review" this needs a semantic review of its own before recovery.

**B — READY BUT NEEDS CERTIFICATION.**

---

## Step 4 · Candidate base

```
PRODUCTION BASE     d592d8f   (Hosting, PROVEN live)
CANDIDATE BASE      not yet created
ANCESTRY PROVEN     n/a — nothing applied
```

Seven branches descend from production and could host a recovery branch — cleanest is a fresh
branch off `d592d8f` itself, or `release/r1-pos-printer-fn` (+34, production's own lineage).
**No workspace was created and nothing was applied**, because only one commit qualified and
applying it is a separate authorisation.

---

## Manifest

```
RECOVERED                none applied — analysis only
RECOVERABLE ON REQUEST   59b6ffe  (merchant Messages, frontend + tests)
ALREADY PRESENT/NOT FOUND MiniShop — no unique commit on this branch
EXCLUDED                 fa5082b  multi-shop checkout — mixed, unsplittable
                         37aa41d  seller-handover UI — frozen at 4a17401
NEEDS CERTIFICATION      9fe09e2  premium composer — 271-line backend change
FROZEN                   functions/payment-purposes.js · functions/index.js
UNPROVEN                 the ~200 remaining branch commits — not individually classified
REGRESSIONS              none identified

MINISHOP           BLOCKED — no unique work found on this branch
CART               BLOCKED — inseparable from frozen payment + index changes
MULTI-SHOP CART    BLOCKED — same; backend callables require excluded index exports
MESSAGE UI/UX      PARTIAL — 59b6ffe recoverable · 9fe09e2 needs backend review

PAYMENT NON-REGRESSION   PASS (vacuous — nothing applied)
WORKTREE                 UNCHANGED — shared tree still 235 entries, untouched
PRODUCTION               NOT DEPLOYED · NOT MUTATED
```

## The honest position

The MiniShop/cart/message work is **not lost**, but it is **not mostly recoverable either**.
One commit out of the four relevant ones can be lifted cleanly. The headline feature —
multi-shop checkout — is entangled with frozen payment code and with the `index.js` export
governance that is itself blocked, so it cannot be extracted while those hold.

**The order implied by the evidence:** resolve index export governance and the payment freeze
*first*; multi-shop checkout then becomes recoverable. Attempting it now would either ship a
broken cart or quietly reopen the payment boundary.
