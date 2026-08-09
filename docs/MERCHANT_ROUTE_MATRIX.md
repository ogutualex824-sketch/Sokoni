# Merchant Route Matrix

> Generated from `sokoni-merchant-routes.js` — the single source of merchant navigation.
> **Do not hand-edit this table to change behaviour**; edit the contract and regenerate.
> Related: [[NAVIGATION_CONTRACT]], [[CANONICAL_COLLECTIONS]], [[SmartPOS]], [[Payments]], [[Marketplace]].

## Rules (enforced by gates, not convention)

Every merchant destination:

1. opens **in-shell** inside `/merchant` — no `window.open`, no `target="_blank"`, no top-level navigation;
2. is declared **once**, in the contract — the sidebar, mobile drawer, bottom nav and ⌘K palette are projections of it;
3. names a target that **provably exists** — a seller `sec` in `seller.js` `DASH_PAGES`, a `data-tab` in `pos.html`, or a real file on disk;
4. **never** targets a legacy dashboard, and never falls back to one;
5. **fails loudly** when its id is unknown, rather than silently rendering Dashboard.

A route is PASS only when: button → canonical route → correct module mounted → correct mobile
layout → correct desktop layout → clean exit → clean return.
**HTTP 200 is not a pass, and a changed title is not a pass.**

### Gates

| Gate | What it proves |
|---|---|
| `npm run test:merchant-routes` | Static: contract integrity + every target really exists (64 checks) |
| `npm run test:merchant-visual-gate` | **The acceptance gate.** webkit at 375×667, 393×852, 430×932 and desktop, notch simulated, authenticated merchant session: `elementFromPoint()` touchability, inside-iframe document state, per-document error attribution, screenshots (568 checks) |
| `npm run test:rules:returns` | Firestore rules for `returns` — ownership, isolation, both real LIST queries, empty-is-success, write refusal. **Requires JDK 21+** |

Why a second gate replaced the first: `test-merchant-route-gate.js` reported 164/164 while a
real iPhone was unusable. It asserted the iframe *element's* `src`/`id` and the panel's bounding
box — never whether the module's document loaded, never whether a control was touchable — and it
ran signed **out**, so no authenticated-path regression could be caught. Bounding boxes lie.
The visual gate is the authority; keep the old one only as a fast smoke test.

**Measurement rules learned the hard way** (all three produced false results):
- `page.on('pageerror')` carries **no frame**, so it attributes every uncaught error to the
  shell. Use an `addInitScript` bridge that records each error against its own `location`.
- Never resolve a module by scanning `page.frames()` for a URL substring — POS and Seller panels
  are persistent, so that can match a **stale** frame from the previous route. Ask the shell
  which iframe is in the shown panel and bind to that element.
- Never measure during the panel's 240ms `mPanelIn` entrance animation: `translateY(6px)` reads
  as a 6px overlap with the bottom nav that does not exist once it settles. Await
  `getAnimations()`, not a sleep.
- Compare module identity on the **extensionless basename** — hosting runs `cleanUrls:true`, so
  the real URL is `/plans`, not `/plans.html`.

## Primary sidebar (canonical order)

| Button | Route id | Module / target | Role | Required context | Status |
|---|---|---|---|---|---|
| 🏠 Dashboard | `dashboard` | native | seller, merchant | sellerUid | ✅ live |
| 💎 Plan | `plan` | page · plans.html?shell=merchant | seller, merchant | sellerUid, shopId | ✅ live |
| 🏷️ Products | `products` | seller · sec:products | seller, merchant | sellerUid, shopId | ✅ live |
| 📦 Inventory | `inventory` | pos · tab:inventory | seller, merchant | sellerUid, shopId, branchId | ✅ live |
| 💳 POS / Cashier | `cashier` | pos · tab:pos | seller, merchant, cashier | sellerUid, shopId, branchId | ✅ live |
| 🧾 Orders | `orders` | native | seller, merchant | sellerUid, shopId | ✅ live |
| 📈 Analytics | `analytics` | native | seller, merchant | sellerUid, shopId | ✅ live |
| 💰 Revenue | `revenue` | native | seller, merchant | sellerUid, shopId | ✅ live |
| 💳 Payments | `payments` | native | seller, merchant | sellerUid, shopId | ⏳ planned |
| 🛵 Deliveries | `deliveries` | page · dispatch.html | seller, merchant | sellerUid, shopId | ✅ live |
| ↩️ Returns | `returns` | page · returns.html | seller, merchant | sellerUid, shopId | ✅ live |
| 🧾 Receipts | `receipts` | seller · sec:receipts | seller, merchant | sellerUid, shopId | ✅ live |
| 👥 Staff | `staff` | seller · sec:team | seller, merchant | sellerUid, shopId | ✅ live |
| 💬 Messages | `messages` | seller · sec:messages | seller, merchant | sellerUid | ✅ live |
| ⚖️ Disputes | `disputes` | seller · sec:disputes | seller, merchant | sellerUid, shopId | ✅ live |
| ⚙️ Settings | `settings` | native | seller, merchant | sellerUid, shopId | ✅ live |

### More tier

Preserved destinations, one tap deeper. Nothing was removed in Phase 2.

| Button | Route id | Module / target | Role | Required context | Status |
|---|---|---|---|---|---|
| 📣 Marketing | `marketing` | seller · sec:marketing | seller, merchant | sellerUid, shopId | ✅ live |
| 🏪 My MiniShop | `minishop` | page · minishop-admin.html | seller, merchant | sellerUid, shopId | ✅ live |
| ⚡ Flash Sale | `flash-sale` | seller · sec:flash | seller, merchant | sellerUid, shopId | ✅ live |
| 🧾 KRA Tax | `kra-tax` | seller · sec:tax | seller, merchant | sellerUid, shopId | ✅ live |
| 📸 Stories | `stories` | seller · sec:stories | seller, merchant | sellerUid, shopId | ✅ live |
| 🧑‍🤝‍🧑 Customers | `customers` | seller · sec:customers | seller, merchant | sellerUid, shopId | ✅ live |
| 📊 Reports | `reports` | native | seller, merchant | sellerUid, shopId | ✅ live |
| 🟢 Availability | `availability` | native | seller, merchant | sellerUid, shopId | ✅ live |
| 🏬 Shop Details | `shop` | seller · sec:store | seller, merchant | sellerUid, shopId | ✅ live |
| 🚚 Fulfilment | `fulfilment` | page · seller-fulfilment.html | seller, merchant | sellerUid, shopId | ✅ live |
| 🏍️ Riders | `riders` | page · driver.html | seller, merchant | sellerUid, shopId | ✅ live |
| ✅ Verification | `verification` | page · verification.html | seller, merchant | sellerUid | ✅ live |
| 🖨️ Devices | `devices` | native | seller, merchant, cashier | sellerUid | ✅ live |
| 🖨️ POS Setup | `pos-setup` | page · pos-printer-setup.html | seller, merchant, cashier | sellerUid | ✅ live |
| ⚙️ POS Settings | `pos-settings` | pos · tab:settings | seller, merchant | sellerUid, shopId, branchId | ✅ live |
| 🛡️ Audit Log | `audit` | pos · tab:audit | seller, merchant | sellerUid, shopId | ✅ live |

### Legacy aliases

Back-compat for bookmarks and open tabs. These resolve **before** the unknown-route check, so
they are aliases — not a silent fallback to Dashboard.

| Old id | Resolves to |
|---|---|
| `#finance` | `#revenue` |
| `#team` | `#staff` |
| `#promotions` | `#flash-sale` |
| `#store` | `#shop` |
| `#tax` | `#kra-tax` |
| `#pos-printer-setup` | `#pos-setup` |

## Bottom navigation

Exactly four, never more. Every id must be a real route (or the `__more` drawer sentinel), so
the bar cannot drift out of sync with the registry.

| Slot | Route |
|---|---|
| 🏠 Home | `dashboard` |
| 🧾 Orders | `orders` |
| 💳 Sell | `cashier` |
| ☰ More | opens the full drawer |

**Plan is deliberately excluded** — it is a primary sidebar destination and must not crowd the
four-up bar.

## Persistent-panel note

The POS and Seller apps are **one panel each**, shared by several routes and never destroyed —
that is what keeps the Bluetooth/GATT printer connection and Firestore listeners alive across
navigation. For those routes `previousModule === null` is provably false and is **not**
asserted. The gate asserts instead: exactly one panel visible, it is the right one, and the
correct tab/section was requested on it.

## Mobile geometry contract

Defined once in `merchant.html` `:root`:

| Var | Meaning |
|---|---|
| `--safe-top` | `env(safe-area-inset-top)` — status bar / notch |
| `--safe-bot` | `env(safe-area-inset-bottom)` — home indicator |
| `--top-h` | header height **including** its safe inset |
| `--bnav-h` | bottom nav height **including** its safe inset |

Bottom-nav clearance lives on `.mmain`, **not** `.mcontent`. Module panels are
`position:absolute; inset:0`, and an absolutely-positioned box resolves `inset:0` against its
containing block's *padding box* — so padding on `.mcontent` (the positioned ancestor) is a
no-op and leaves every module running under the nav. Padding `.mmain` (a flex container)
genuinely shortens `.mcontent`.

No page may render under the header, under the bottom nav, or under either safe-area inset, and
the page body must never scroll horizontally — only explicitly horizontal components may.

### Measured (webkit, the iPhone/Safari engine)

| Viewport | Panel bottom → bnav top (before) | After |
|---|---|---|
| 393×852 | 852 → 787 (**65px buried**) | 787 → 787 |
| 390×844 | 844 → 779 (**65px buried**) | 779 → 779 |
| 375×667 | 667 → 602 (**65px buried**) | 602 → 602 |

Under a simulated notch (`--safe-top:59px`, `--safe-bot:34px`) the header grows 56 → 115px and
the burger clears to y=69.5.
