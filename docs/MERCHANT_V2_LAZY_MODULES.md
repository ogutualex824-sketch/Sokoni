# merchant-v2 — section modules load on first open (2026-10-01)

**Owner ask:** "make sure the page speed is top notch on all pages, and buttons respond super fast and work well." Split with sokoni-32: they own home + the shared files (shared-header, splash, layout, performance); this slice covers merchant-v2.
**Branch:** `hosting/mv2-lazy-modules-on-6e7bfe2`. **Related:** [[MERCHANT_SURFACE_AUDIT]] (0bd20bc), [[PRINTER_ONE_SETUP]], [[MERCHANT_DASHBOARD_FACTS]]

## What changed

merchant-v2 parsed every section's code at start, before the merchant had opened any section.

| merchant-v2 start | Before | After |
|---|---|---|
| synchronous external scripts | 42 | 15 |
| local JavaScript referenced at start | 1,528 KB | 704 KB |

The 14 native sections now load on first open: Sell, Products, Inventory, Offers, Wallet, Receipts, Team, Marketing, Disputes, Messages, Customers, Store, Tax and Flash. They are listed in `MODULE_SCRIPTS` (keyed by route, in dependency order) and loaded by `renderModule`.

This converges with the 0bd20bc design (2026-08-20, never landed on the live line). It keeps the same registry name, the same in-flight promise per URL, sequential dependency loading and an abandonment guard. It is extended to every native section, plus:

- **Intent pre-load.** `pointerdown` / `mouseover` / `focusin` on any `[data-route]` starts loading that section, so it is usually ready when the click fires.
- **Sell warm-up.** At idle Sell (the till) is fully loaded, **unless** the connection reports save-data or 2G. There is no blanket prefetch, because on mobile data every byte is the merchant's money.
- **Abandonment guard.** An async load mounts only if its host is still in the page **and** visible. That covers route panels and the Wallet's host inside Payments.

Shared authorities stay eager: data, routes, receipt, cash, fulfilment, promotions, product specs, authority and analytics.

## Proof

- **`test-module-authorities.js`** is now registry-aware. A dependency counts as supplied if it is eager, or earlier in the same route's list. 51/0, sabotage 4/4: a dropped helper, a wrong order, a route that is not a section, and a missing file are all caught.
- **`test-merchant-wallet.js`** now requires the loader WITH the guard, which is the condition its provenance block always stated. 74/0, guard sabotage caught.
- **Products, receipts and AI-photo suites** have their "loaded" assertions kept, now registry-aware. 23/0, 28/0 and 35/0.
- **`test-merchant-v2-lazy-modules.js`** (ported from 0bd20bc). Its static section is 8/0. Its network section certifies:
  - zero on-demand requests at a save-data boot
  - each route fetches exactly its own files, once
  - a revisit fetches nothing
  - shared authorities are fetched exactly once
  - without save-data, the warm-up fetches the till only

  The network section runs under the browser window and is **not yet run** (machine RAM floor).
- Every other non-browser merchant-v2 suite is unchanged and green.

## Not yet observed

- **Timings.** FCP/DCL/load/long-task on a throttled Pixel-5 profile with sokoni-32's perf probe, before vs after. Not measured: the machine is under the browser memory floor. The byte and script counts above are static facts, not timings.
- **Browser certification.** The network-certified suite and the existing merchant-v2 browser suites still have to run.
