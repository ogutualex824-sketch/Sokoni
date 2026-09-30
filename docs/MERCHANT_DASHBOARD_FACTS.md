# Merchant dashboard facts, customers, scanner and callable diagnostics — the 2026-09-30 merchant-v2 repairs

**Owner reports (2026-09-30):** "Business Pulse still not loading anything in the merchant-v2 dashboard, still not in sync" · "barcode scanner still unavailable" · "POS and till prompting still saying internal" · "customers are not yet loaded in KASS shop yet there are sales".
**Method:** read-only census first (served rules, live data counts for the real merchant via the Admin SDK, Cloud Logging, served file digests), then the smallest server-authoritative repair, reusing what exists. No production data written.
**Related:** [[HOME_PICKED_FOR_YOU_INVENTORY_SYNC]] · [[POS_SETUP_PAGE]] · [[PRODUCT_TIMESTAMP_WRITER_CENSUS]] · [[SmartPOS]] · [[Payments]]

---

## 1 · Business Pulse — why it showed nothing, and the fix

| Figure | What the dashboard could read (served rules) | Live data for the real merchant (counts only) | Verdict |
|---|---|---|---|
| Sales (till) | `posDailySummary`: **no rule** · `posRetailSales`: **admin only** | 5 completed till sales (all cash, `customer: null`), `merchantId == sellerUid == uid` | unknown **by design** — no client can read the merchant's own till money |
| Orders / customers | `orders where sellerUid == uid`: readable | 10 orders, 3 distinct identified buyers, 0 today | rendered "0 today · partial" — true but read as "nothing loads" |
| Best seller | `productStats`: public, but the query `where sellerUid orderBy sold` needs a composite index that does not exist | 0 rows | silently null |
| Money | `commissionLedger` seller-readable (0 rows); `sellerBilling` monthly doc absent | — | unknown, correctly |
| Deliveries | no server writer stamps `senderUid` | — | unknown, unchanged finding |

**Fix (server-authoritative, reuse-first):** one callable `merchantDashboardFacts` (`functions/merchant-dashboard-facts.js`, exported from `functions/index.js`), App Check enforced, scoped **only** by `request.auth.uid` — no client-supplied id is accepted, so no tenant guard is needed and no third guard is invented. It reads `orders` and `posRetailSales` where `sellerUid == uid` (single-field indexes, no composite) and returns each figure with its state and reason: today's till takings, paid online sales, takings (till + online), orders today, needs-attention, identified customers, trend vs yesterday and the 7-day series. A truncated sample is **partial**, an unreadable source is **unknown**; nothing is extrapolated; walk-in cash sales are sales, not customers.
`sokoni-merchant-dashboard.js` consumes it through `ctx.db.readFacts` (wired in `merchant-v2.html`); the client-side reads remain the fallback and still fill low stock, best seller and waiting replies. Proof: `scripts/test-merchant-dashboard-facts.js` 27/0 (pure computation on the live shape, handler against the fake Firestore, spoofed ids ignored, breakage controls); `test-merchant-dashboard.js` 117/0.

## 2 · Customers — empty despite sales

`crmCustomerProfiles`, the only source the Customers route read, is **empty project-wide** (0 documents): it is written only by the CRM callables (`buildCustomerProfile`, `calculateCLV`), which nothing runs for a shop's ordinary sales. The empty set rendered as "no customers".

**Fix:** `sokoni-merchant-customers.js` keeps profiles as the richer source and, when there are none, asks the same callable for `{op:'customers'}`: customers derived from the shop's real orders and identified till sales (order count, spend, first/last order, source), completeness stated, walk-ins reported in a note. Wired through `merchant-v2.html` (`callFacts`) and `sokoni-merchant-customers-ui.js`.

## 3 · Barcode scanner "unavailable"

Served scanner files are byte-identical to the tree, so the code was right and the **device** was not: `pos-barcode.js` had exactly one decoder, `BarcodeDetector`, which is honest only on Android Chrome. On Windows/Linux Chrome and Edge the constructor exists but `getSupportedFormats()` is empty and every `detect()` rejects; on iOS Safari and Firefox the API is absent. The premium scanner then reports "unavailable". `sokoni-barcode.js` already carried a ZXing (WASM) fallback from unpkg (allowed by `script-src`).

**Fix (reuse, not a second engine):** `pos-barcode.js` treats a detector with no supported formats as absent, falls back to the same ZXing build for live frames, image uploads and a detector that throws mid-session, and `hasDecoder()` answers truthfully. Every path still resolves a VALUE only through the one `submitScannedCode`. Proof: `scripts/test-pos-barcode-decoder-matrix.js` 16/0 (Android native · desktop empty-formats · iOS/Firefox · native-throws · ZXing fails to load · no-barcode frame · premium-scanner contract unchanged); `test-premium-scanner.js` 32/0; `test-pos-barcode-path.js` 20/0.

## 4 · POS and till "internal" — not yet reproduced, now observable

Seven days of Cloud Logging show **no** unhandled error in any POS, till, merchant or printer function (the only `FAILED_PRECONDITION` was `wfGetMyWorkspaces`, called from account-centre, twice). The till dispatcher `smartPosDispatch` received **no request from the merchant at all** in the window; its only traffic was this session's probes, which returned the expected JSON 401 with correct CORS from both the cloudfunctions.net and run.app URLs. So the "internal" the merchant sees is produced in the browser **before** the call lands (the SDK reports a failed fetch, a blocked request or a non-JSON reply as `internal`), and nothing recorded it.

**Fix:** `merchant-v2.html`'s callable wrapper now reports every failed callable (`internal`, `unavailable`, `deadline`, `not-found`, `unauthenticated`, `failed-precondition`) to the existing `logClientDiagnostic` with name, code, message, online state, App Check state, page and user agent, then rethrows unchanged. The next occurrence names its cause; the served CSP `connect-src` (cloudfunctions.net only, no `*.run.app`) is the first thing to check against that record.

## 5 · POS setup page and the POS button

The one-page POS setup (`7dd719c`, branch `ui/pos-setup-page-on-be7c676`: set up once, edit anytime, premium receipt with KRA eTIMS) was **not** on the live lineage; it merges cleanly and is included in this candidate. It is a shell **exit** (`kind:'exit'`, Back to Merchant, `?return=`) and embeds the existing hardware wizard, so completing hardware still writes `posSetupComplete`. The POS button keeps its contract: setup first while unconfigured, then `pos.html` opening on CHECKOUT — the one in-shop checkout of the SmartPOS consolidation (`pos-checkout.html` is the older standalone checkout and is not framed, to keep one checkout).

## 6 · Not changed

Firestore rules and indexes, App Check, `firebase.json`, storage rules, production data. The Home listener finding and `uploadedAt` server authority stay separate ([[HOME_PICKED_FOR_YOU_INVENTORY_SYNC]]).

## Day boundary (2026-10-01)

"Today" is the **shop's** day. Kenya is UTC+3 all year. Cloud Functions run in UTC, so the previous `setHours(0)` boundary was midnight UTC, which is 03:00 in Nairobi. Between midnight and 03:00, a merchant's "today" still held last night's sales. `dayStart` now computes Nairobi midnight arithmetically.

A sale's instant is its own timestamp (`createdAt` / `checkoutStartedAt`). `saleDate` is used only as a fallback, read as noon Nairobi, because at least one till writer stamps it with `toISOString()` (a UTC date). The suite pins fixtures to Nairobi time and passes on a UTC host (`TZ=UTC`). Result: 32/0, sabotage 2/2.
