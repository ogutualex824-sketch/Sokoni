# Profile — buyer only (2026-10-03)

**Owner ask:** make the profile buyer-related only. Business and services actions go to their dashboards; the floating Active Role card gets a background; quick actions, KASS action items, Recent Activity, My Hubs and Business Management must all work and stay in sync.

**Surface:** `profile.html`
**Branch:** `hosting/profile-wallet-instant-on-72dca56` (built on live 72dca56). **NOT deployed.**
**Suites:** `scripts/test-profile-buyer-only.js` (20/0; production 72dca56 fails 18) · `scripts/test-business-hub-acting-role.js` (36/0) · `scripts/test-profile-wallet-instant.js` (13/0)
**Related:** [[PROFILE_BUYER_VIEW]] (93af1fc, superseded) · [[Authentication]] · [[Marketplace]]

## What was wrong on production

| Defect | Effect |
|---|---|
| Active Role card floats at 3% white + blur | the cards behind it showed through; unreadable |
| Executive Commands "Go Online" → `driver-dashboard.html` | **the page does not exist**. So did 12 other links: Navigate, Earnings, My Day, insights and search entries |
| Business blocks rendered on the profile | POS / Add Product / Invite Staff, business health, module summaries, Businesses/Workspaces tiles, Listings/Rating |
| Doorways shown only while *acting as* that role | a seller browsing as a buyer had no way back to their shop |
| Business links → legacy `merchant.html#…` and `admin.html` | not the canonical merchant-v2 / AdminOS |
| Edit profile carried "M-Pesa Till / Paybill (Sellers)" | business payout data on a personal page |
| Orders / Spent counted the browser cache `sokoniOrders` | an invented figure, and the cache is not scoped to the signed-in account (a shared phone showed someone else's orders) |
| Recent Activity had two writers (orders listener + `profileGetActivityTimeline`) | whichever finished last won; an empty server answer left a stale list |
| Timeline titles inserted unescaped | seller-typed names reached `innerHTML` (XSS) |

## What it is now

### Floating Active Role card
- It still floats (sticky) and now sits on an opaque surface (`rgba(13,13,13,.97)` plus a shadow).
- The switcher markup is byte-identical to production.

### Buyer only
- `.sk-biz-only{display:none!important}` is unconditional.
- The same nine blocks 93af1fc tagged carry it, including Executive Commands (where "Go Online" lived) and the POS/staff quick actions.
- The person's own blocks stay:
  - tabs
  - buyer Quick Actions
  - wallet
  - KASS
  - Recent Activity
  - My Hubs
  - Rewards
  - identities
  - Business Management

### Doorways
- **"Your SOKONI identities"** shows a doorway for every role the account **holds**:
  - Business → `merchant-v2.html`
  - Services → `provider-dashboard.html`
  - Delivery → `driver.html`
  - AdminOS → `admin-os.html`
  - Super Admin
- **Business Management** keeps the acting-role view (switching to Buyer clears it). Its links are canonical:
  - merchant-v2 routes `#shop #products #orders #pos #staff #payments #revenue #analytics`, all verified against `sokoni-merchant-routes.js`
  - Financial OS → `sfos-wallet.html`
  - the provider dashboard or onboarding (unchanged `_bizRouteProvider`)
  - Rider → `driver.html`
  - AdminOS

### Every link resolves
Every local page the profile links to exists (35, checked by B3).

### Edit profile
- The till field, its read and its write are gone.
- The save no longer sends `tillNumber`, so a stored value is left untouched.

### Stats
- **Orders** = the account's real orders (`listenUserOrders`, uid OR buyerUid). A real 0 shows as 0; at the query cap it shows "200+".
- **Spent** shows "—" until the server provides a total.

### Recent Activity
- One writer: `profileGetActivityTimeline`.
- It says "Loading your activity…", then shows the events, the empty state, or "Couldn't load your activity right now."
- Title, subtitle and status are escaped.

### My Hubs
Buyer hubs only (Shop, Food, Services, Delivery, Property, Fitness, plus the adaptive universal hubs).

### KASS action items
Unchanged: `profileGetCompletion` (LIVE). The card is hidden when there are no recommendations.

## Hosting assembly note
- This branch supersedes **93af1fc**, whose view depends on the acting role. The owner has since ruled the profile buyer-only in every role.
- It also supersedes **4ad7443**, which removed the floating card. The owner now wants it kept, with a background.
- Take this branch's `profile.html` and re-apply nothing from those two except what this one already carries: the till removal.

## Open
- **Spent:** no server total exists. Showing it needs `profileGetOverview` to return a paid-orders total (functions slice).
- **Browser proof:** not run (memory floor). A real browser run is UNPROVEN.
