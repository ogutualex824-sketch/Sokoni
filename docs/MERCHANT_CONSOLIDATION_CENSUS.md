# Merchant Consolidation — Capability / Reference / Lifecycle Census

**Stage 1 of the merchant onboarding + seller/merchant consolidation track. READ ONLY — nothing was
changed.**
Regenerate with `node scripts/census-merchant-consolidation.js` (no network, no credentials).
Related: [[Application Lifecycle]] · [[Role Authority]] · [[SmartPOS Merchant OS]] · [[Subscription Billing]]

---

## 1. Capability census — what merchant.html owns vs borrows

`sokoni-merchant-routes.js` is already the canonical route contract: **30 routes, validating clean**.
merchant.html is not a competing dashboard — it is a shell, and for eleven capabilities the shell
**mounts `seller.html` in an iframe** (`merchant.html:568`, `src = 'seller.html#' + sec`).

| kind | n | meaning |
|---|---|---|
| `native` | **9** | owned by merchant.html — dashboard, orders, analytics, revenue, payments, settings, reports, availability, devices |
| `seller` | **11** | **borrowed** — products, receipts, staff(`team`), messages, marketing, flash-sale(`flash`), kra-tax(`tax`), stories, disputes, customers, shop(`store`) |
| `pos` | 1 | mounts a `pos.html` tab |
| `page` | 8 | mounts a standalone file — deliveries, returns, plan, minishop, fulfilment, riders, verification, pos-setup |
| `exit` | 1 | home |

**11 of 30 routes require `seller.html` at runtime.** That is the consolidation target — and the
useful framing is that consolidation means *changing eleven route kinds*, not rewriting a dashboard.

Sizes: `merchant.html` 161KB · `seller.html` 445KB · `seller.js` 280KB.
`seller.js` exposes 16 `DASH_PAGES` sections; merchant routes address 11. The five it does not
address — `overview`, `analytics`, `orders`, `history`, `pos` — are already native or POS routes in
the shell, i.e. genuinely superseded rather than missing.

## 2. Reference census — 471 references across 125 files

| refs | files | class | what migration costs |
|---|---|---|---|
| 177 | 26 | docs / manifest (`CHANGELOG.md` 103, `navigation-registry.json` 23) | nothing — historical prose |
| 140 | 62 | page / feature links (`profile.html` 18, `pos.js` 8, `index.html` 7, `seller-success.html` 7) | the real surface area |
| 88 | 27 | tests / harnesses | must be migrated *with* the capability, not before |
| 31 | 4 | platform nav / auth (`sokoni-nav-engine.js` 22, `shared-header.js` 3, `sokoni-permissions.js` 3, `splash.js` 3) | the workspace switch itself |
| 18 | 3 | backend (`functions/index.js` 14, `email-templates.js` 3, `algolia-admin.js` 1) | **deep links inside sent email — cannot be broken silently** |
| 17 | 3 | the two systems themselves | — |

The backend class matters most for the compatibility decision: **emails already in merchants'
inboxes point at `seller.html`**. A redirect is therefore not optional cleanup — it is the only way
those links keep working.

## 3. Lifecycle census — the five transitions

This is the finding that reframes the stage. The target architecture is
`START SELLING → WHAT ARE YOU OFFERING? → APPLICATION → PENDING → APPROVED → ROLE + CLAIM → SHOP LIVE → TRIAL → merchant.html`.
Measured against the tree, **the marketplace path has no application, no approval, and no
entitlement at all** — those transitions exist only on the POS path.

| # | transition | collection | production writers | verdict |
|---|---|---|---|---|
| A | application (automation trigger) | `sellerApplications` | **0** | `autoOnSellerApplication` listens to a collection **nothing writes**. The auto-approve path converged in Stage 2 is unreachable in production. |
| B | application (canonical) | `applications` | 14 (11 client, 3 server) | client writers are healthcare, driver, professional, provider, hub-register — **a merchant can submit from NONE** |
| C | shop activation | `shops` | **1** (`automation-engine.js:293`) | the only writer sits inside the unreachable path in row A |
| D | seller registry | `sellers` | 6, **all client-side** (`seller.html:2734`, `seller.js:2449`, `pos-onboard.html`, `sokoni-branch.js`) | a shop "becomes real" when the merchant saves a form |
| E | subscription / trial | `subscriptions` | 2 server (`business-bootstrap.js:973`, `entitlement-adapters.js:98`) | correctly shaped 14-day trial — reachable **only** from `pos-setup.html` |

Two further facts:

- **Approval projects nothing for a seller.** `DELEGATED_ROLES` in `application-lifecycle.js` maps
  `seller → 'sellers'` and the projection records `action: 'delegated'` — deliberately, because
  "sellers has its own onboarding". The census shows that *own onboarding* is row D: a client-side
  form write. So an approved seller application produces a role and a claim, and **no registry
  document**.
- **`onboarding-seller.html` ("Seller Setup", 25KB) writes exactly one thing:** an `addDoc` to
  `onboardingCompleted`. No application, no registry, no shop, no role, no trial.

### What actually happens today when someone clicks Start Selling

```
Start Selling → /offer → "A Product" → seller.html
                                          ↓
                                  merchant fills the shop form
                                          ↓
                              client writes sellers/{uid}   ← the entire "lifecycle"
```

No `applications` document, no admin review, no `grantAccountRole()`, no `seller` claim, no
`shops/{uid}`, no subscription. This is consistent with, and explains, the claim census: **0 of 11
seller accounts hold the seller claim** — nothing on this path was ever going to mint one.

---

## What the census settles before any code moves

1. **The consolidation is eleven route-kind changes**, not a dashboard rewrite. merchant.html
   already owns the nine capabilities that matter most operationally.
2. **`sellerApplications` must not be built on.** It has zero writers and a live trigger. The
   canonical registry is `applications` (`applications` = REQUEST, registries = TRUTH), which
   already has a working server lifecycle, an admin console, and the converged role authority
   behind it. Building the merchant application on `applications` adds no second authority;
   building it on `sellerApplications` would.
3. **"Shop goes live" has no server writer on the marketplace path.** It needs one — the projection
   `application-lifecycle.js` currently delegates. That is a change to an existing authority, not a
   new one.
4. **Do not create a second subscription authority.** The correctly-shaped trial already exists in
   `business-bootstrap.js:_createBusiness`; it is reachable only from POS setup. The work is to
   reach it (or factor its trial block into a shared primitive), not to write a second one.
5. **seller.html cannot become a pure redirect in this stage.** 140 page/feature references and 18
   backend references — including links inside already-delivered email — depend on it, and eleven
   merchant routes mount it. Compatibility must be tested, not assumed.

## Stage plan implied by the census

| # | commit | scope |
|---|---|---|
| 1 | **this census** | read-only baseline (done) |
| 2 | onboarding / application flow | merchant submits into `applications`; `/offer` → application, not straight to a dashboard |
| 3 | approval → live authority | stop delegating `seller`: project the registry + `shops/{uid}` inside the existing lifecycle, after the canonical role grant |
| 4 | subscription / trial integration | reach the existing trial authority on approval; no second authority |
| 5 | merchant.html consolidation | convert `kind: 'seller'` routes to native, one at a time, each with its tests |
| 6 | regression + mutation tests | pending→live, claim grant, trial creation, application submission, merchant routing |

Each stage stops at a clean commit. Nothing is deployed.
