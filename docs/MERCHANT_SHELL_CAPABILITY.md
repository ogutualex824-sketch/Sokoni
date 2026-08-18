# Merchant Shell Capability Negotiation

**Status:** DESIGNED + STATICALLY PROVEN — **not wired into either shell.**
**Branch:** `fix/merchant-shell-capability` (from `merchant-v2-preservation` @ `168d54f`)
**Gate:** `scripts/test-merchant-capability.js` — **36 passed, 0 failed**

Related: [[MERCHANT_V2_CERTIFICATION]] · [[MERCHANT_ROUTE_MATRIX]] · [[NAVIGATION_CONTRACT]] ·
[[MERCHANT_CLICKABLE_CENSUS]] · [[DELIVERY_DESTINATION_BLOCKER]]

---

## 1. The problem, stated exactly

There is now **one** route registry and **two** shells that can render different amounts of it.

The certified `sokoni-merchant-routes.js` (48,364 bytes, sha256 `2b8fc08d…`) differs from the
registry live on `rc/combined` (29,296 bytes, sha256 `7697b4f5…`) in four measured ways:

| | `rc/combined` | certified |
|---|---|---|
| routes | 30 | **32** |
| added | — | `sell` (native), `inventory` (native) |
| `seller` → `native` | — | `customers`, `disputes`, `kra-tax`, `marketing`, `messages`, `shop`, `staff` |
| page `src` | plain | 7 routes gain `?shell=merchant` |
| exports | — | `ACTIONS`, `ACTION_OWNERS`, `actions`, `plannedActions` |

Those 7 upgrades are the whole problem. **Measured** native renderer coverage, read out of each
shell's own `renderNative()` body rather than asked for:

| shell | native renderers | count |
|---|---|---|
| `merchant.html` (live on `rc/combined`) | dashboard, orders, analytics, revenue, reports, payments, availability, settings, devices | **9** |
| `merchant-v2.html` (certified) | the 9 above **+** sell, inventory, staff, marketing, disputes, messages, customers, shop, kra-tax | **18** |

v1's `renderNative()` ends like this:

```js
else if (byId[id] && byId[id].status === 'planned') renderPlanned(id);
else console.error('[merchant] native route "' + id + '" has no renderer');
```

An unhonoured `kind:'native'` in v1 is therefore **not** a graceful failure. It renders *nothing* —
an empty panel plus a console line no merchant will ever read. Adopting the certified registry into
v1 unchanged blanks **7 live surfaces**.

> A registry must never be able to break a shell merely by being adopted. That would make it a
> hidden breaking-change mechanism rather than a contract.

---

## 2. The design

Split the decision. The registry keeps stating the **preferred** capability; each shell states what
it can **actually render**; a pure resolver intersects them.

```
sokoni-merchant-routes.js        each shell
  "sell is BEST native"            "I have / have not got that renderer"
            │                                    │
            └─────────────► negotiate() ◄────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
           native            downgrade           withhold
      shell renders it   legacy seller.js    no legacy equivalent:
                          section instead    removed from every nav
                                             projection; deep-link gets
                                             a NAMED panel, never blank
```

Implemented in `sokoni-merchant-capability.js`. Three functions, no DOM, no Firestore, callable
from node so the gate can prove it without a browser:

```js
negotiate(route, caps)      -> { id, outcome, kind, sec?, src?, tab?, reason }
negotiateAll(routes, caps)  -> every route with its outcome, withheld included
projectNav(routes, caps)    -> the list sidebar/drawer/bottom-nav/palette must build from
```

`caps` is either `{ native: { id: true, … } }` or `{ canRenderNative(id) }`.

### Why `withhold` exists as a third outcome

`sell` and `inventory` are genuinely **new** capabilities. They have no legacy seller.js section to
fall back to, and the two obvious substitutes are both forbidden:

- **`sell` → POS is not a downgrade, it is a merge.** The registry is explicit that Sell is the
  phone-first till and POS is a counter-scale application; the merchant suites enforce a wall
  between them. Falling `sell` back to POS would quietly demolish exactly what the platform
  decided to keep apart.
- **`inventory` no longer aliases the POS inventory tab.** That aliasing was removed on purpose.

So a capability with no equivalent is **absent, not approximated**. It leaves navigation entirely —
no button can promise what the shell cannot mount — and a direct deep-link renders a named
"not available in this shell" panel. That satisfies the registry's own hard rule: an unknown id is
a **loud** failure, never a silent redirect to Dashboard.

### Why the fallbacks are recovered, not authored

Every `sec` in `LEGACY` is copied **verbatim** from the descriptor that same route carried in
`rc/combined` before it was upgraded. The map restores information that already shipped and was
already gate-proven. Two entries would have been guessed wrong by anyone deriving them from the
route id:

```
kra-tax -> 'tax'      (not 'kra-tax')
shop    -> 'store'    (not 'shop')
staff   -> 'team'     (not 'staff')
```

The gate independently confirms all 7 targets are real keys in `seller.js` `DASH_PAGES` — a
downgrade pointing at a section seller.js does not have is a blank with extra steps, because
seller.js silently resolves an unknown page to Overview.

### Why this is a sidecar and not a field in the registry

The certified registry is preserved **byte-identical** as the artifact Merchant v2 was certified
against. Adding a `fallback:{}` field to it would end that identity before integration has even
been agreed.

**When the registry is next opened for integration, `LEGACY` should be folded in as a per-route
`fallback:{}` and the map deleted.** Until then the overlay keeps the certified artifact clean and
keeps the whole thing reversible.

---

## 3. What was proven — and what was not

`scripts/test-merchant-capability.js` — **36 passed, 0 failed.**

Capability is **measured by parsing each shell's own source**, never declared. A manifest drifts the
moment someone deletes a renderer and forgets to update it; the code cannot. If a shell later claims
a capability it does not have, the parse still reports the truth and the assertion still fails.

### PROOF 1 — v1 + certified registry

| assertion | result |
|---|---|
| v1 opens no blank panel on any of the 32 routes | PASS — 0 blanks |
| the 7 upgraded surfaces **downgrade** rather than blank | PASS — customers, disputes, kra-tax, marketing, messages, shop, staff |
| only the 2 genuinely-new surfaces are **withheld** | PASS — inventory, sell |
| withheld routes absent from every nav projection | PASS — nav = 30 of 32 |
| all 7 downgrade targets are real `DASH_PAGES` keys | PASS — 7/7 |

### PROOF 2 — v2 + certified registry

| assertion | result |
|---|---|
| v2 renders `sell` natively | PASS |
| v2 renders `inventory` natively | PASS |
| v2 opens no blank panel on any of the 32 routes | PASS — 0 blanks |
| v2 needs no downgrade at all | PASS — full native coverage of all 18 |
| v2's downgrade path still works for a future unported surface | PASS — 7 downgrades under a synthetic 1-renderer shell |
| …and v2 really mounts `kind:'seller'`, so a downgrade is not a lie | PASS |

### Negative controls — the gate can fail

A gate that cannot fail proves nothing.

- **NC1** an empty `renderNative()` measures **zero** capabilities (the parser inherits nothing).
- **NC2** a native route with no renderer and no legacy equivalent **withholds** — it does not
  silently resolve to native.
- **NC3** *the one that matters.* Remove the `staff` fallback and keep the projection showing the
  button — the realistic regression. The blank-panel assertion must then **fail**, and it does:
  `staff` is reported as a blank risk. **If NC3 ever passes, Proof 1 has become vacuous and every
  other PASS in this document is worthless.**

### RUNTIME CONVERSE — the hazard is measured, not argued

`scripts/test-merchant-route-gate.js --all` was run against **v1 + the certified registry** on real
webkit viewports (iPhone SE 375×667, iPhone 14 Pro 393×852). This is the shell as it ships today,
with no capability layer, loading the certified registry — i.e. exactly the merge someone might
have performed.

```
PASS  every visible contract route has a sidebar button   [30/30]

── SELL  (#sell) ──
PASS  correct module mounted (native)      [native-sell]
FAIL  native module rendered real content
FAIL  no route/console error   [[merchant] native route "sell" has no renderer]
```

The same pair of failures repeated for **`inventory`, `staff`, `messages`, `disputes`** — five
routes × two viewports = the 10 `native module rendered real content` failures in the run. The
shell drew a sidebar button for every one of them, entered the route, mounted a panel, set the
active state, and rendered **nothing** inside it.

So the blank-panel hazard in §1 is not a projection from reading the code. It is the observed
behaviour of the shipped v1 shell the moment it is handed the certified registry.

Two honest limits on that run:

- It **did not complete.** It ended `SKIP — webkit watchdog timeout` after SETTINGS, and exited `0`
  anyway. **Exit 0 here is a timeout artifact, not a pass** — the known release-gate trap where
  ENV/TIMEOUT outcomes are non-blocking. The tally where it stopped was 487 PASS / 30 FAIL.
- It only reached **primary**-tier routes. `customers`, `shop`, `marketing` and `kra-tax` are
  `tier:'more'` and were never clicked. They are **unmeasured, not proven safe** — static analysis
  says they blank for the same reason, but no viewport has confirmed it.

Four of the 30 failures are unrelated environment noise (CORS 204 on a headless origin,
`Can't find variable: firebase`, POS deep-link `null`, seller deep-switch confirmation timeouts) —
consistent with a headless unauthenticated run and **not** attributable to the registry.

### What is NOT proven

This is deliberate and it is the honest boundary:

- **Neither shell calls the layer.** `sokoni-merchant-capability.js` is not loaded by
  `merchant.html` or `merchant-v2.html`. These are proofs about the resolver and the projection
  contract, evaluated against **measured** shell capability — *statically reviewed*, **not**
  *runtime proven*, and certainly not *device accepted*.
- **The seven `seller → native` values were not flipped, and must not be** until a shell that
  actually calls `negotiate()` is the one loading the registry.
- **No merchant has ever seen a downgrade render.** Proof 1 says v1 *would* mount
  `seller.html#team` for `staff`. It does not say that panel looks right inside the v2-era shell
  chrome.

---

## 4. Blockers found by running the existing gates against both shells

`scripts/test-merchant-routes.js` gained one additive, default-preserving change — the shell under
test is now `process.env.MERCHANT_SHELL`, defaulting to `merchant.html`, so CI and every existing
caller are unchanged. Two shells reading one registry is the entire point of the contract; a gate
that can only see one of them cannot prove it.

```
MERCHANT_SHELL=merchant.html     ->  55 passed, 2 failed
MERCHANT_SHELL=merchant-v2.html  ->  53 passed, 4 failed
```

### BLOCKER 1 — the founder sidebar is a founder decision (fails in **both** shells)

```
FAIL  sidebar ORDER matches the canonical spec exactly
FAIL  no extra primary destinations   [17 vs 15]
```

The gate holds a hardcoded `FOUNDER_SIDEBAR` of 15 ids. The certified registry adds `sell` and
`inventory` as **primary** tier, giving 17:

```
dashboard, plan, sell, products, inventory, pos, orders, analytics, revenue,
payments, deliveries, returns, receipts, staff, messages, disputes, settings
```

This is not a bug to fix in code. The constant is named `FOUNDER_SIDEBAR` because the merchant
sidebar and its order are a product decision. **Adopting the certified registry requires an
explicit decision that Sell and Inventory become primary destinations, in that position.** Nobody
should quietly edit the constant to make the gate green — that would convert a product decision
into a silent side effect of a merge.

### BLOCKER 2 — v2 has a navigation shape the route contract has no vocabulary for

Only in `merchant-v2.html`:

```
FAIL  the only shell navigation is the declared exit route   [location.assign( location.assign(]
FAIL  shell never navigates the tab to login/auth
```

Located at `merchant-v2.html:2431`:

```js
async function doSignOut () {
  …
  location.assign('/login?next=/merchant-v2.html');
}
```

**This is not the outage defect the gate was written to catch.** That one was a *module's*
`postMessage` ending a session the merchant had not asked to end. This is a merchant pressing a
Sign out button they can see. The intent is legitimate.

But three things are wrong with it, and the gate is right to stop it:

1. **The contract has no `kind` for it.** The only navigation the contract sanctions is a
   declared `kind:'exit'` route. Sign-out is a second legitimate navigation shape that simply is
   not modelled. `merchant.html` has **no sign-out at all**, so v2 introduced both the capability
   and the unmodelled shape together.
2. **`next=/merchant-v2.html` breaks the repo's own cleanUrls rule.** The same gate asserts, three
   checks earlier, that every exit href must be root-relative and **not** `.html`, because
   cleanUrls 301-redirects those. This `next=` target is exactly the shape that rule forbids.
3. **It hardcodes a pre-integration filename.** After integration the shell is served at
   `/merchant`. A merchant who signs out and back in lands on a stale path.

*(For the record, this is **not** the `project_merchant_auth_boundary` defect — that one's
fingerprint is a **missing** `?next=`. Here `?next=` is present.)*

**Recommendation:** model sign-out in the contract as a declared route kind rather than widening
the navigation assertion. Widening it re-opens the exact hole the assertion was written to close.

---

## 5. Sequence — what happens next, in order

1. **Founder decides Blocker 1** — do Sell and Inventory become primary sidebar destinations, in
   that position? Nothing below can proceed honestly until this is answered.
2. **Model sign-out in the route contract** (Blocker 2), then fix the `next=` target to a
   cleanUrls-safe root-relative path.
3. **Wire `negotiate()` into both shells.** v2 first — it is the one under active certification and
   currently negotiates to full native, so wiring it changes no behaviour and proves the plumbing.
   Then v1, where the layer actually does work.
4. **Re-run the runtime gate** (`scripts/test-merchant-route-gate.js`) against both shells with the
   layer wired. Static proof of a downgrade is not proof that the downgraded panel renders.
5. **Only then** fold `LEGACY` into the registry as a per-route `fallback:{}` and delete the
   sidecar.

The seven `seller → native` flips are **not** a step in this list. They already exist in the
certified registry and stay exactly as certified; what changes is that a shell finally asks itself
whether it can honour them.
