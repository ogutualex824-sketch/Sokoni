# AdminOS — Finance → Receipts (2026-10-03)

Status: **built and unit-tested. NOT deployed.** Branch `hosting/adminos-receipts-on-72dca56`, which descends from live `72dca56`.

Related: [[TRANSACTION_RECEIPTS_2026-10-03]] · [[Payments]]

## What it is

A **read-only** screen for platform transaction receipts, inside the one canonical admin workspace (`admin-os.html`).

- **Search:** by receipt number, payment reference, booking/quote/order id, buyer uid, or provider/seller uid.
- **Shows:** header, money position (paid, held, released, refunded, SOKONI fee, provider share, deductions "not commission") and the immutable history.
- **Unknown values:** an unknown payment method shows as "—".
- **Data source:** only the callable `adminSearchReceipts`. It requires the admin claim and **audits every lookup**. Rules deny raw receipt reads to every client, admins included (f3, `eb05e6b`).
- **Super Admin only:** "Retry failed receipt writes" (`adminRetryReceiptFailures`, audited) completes a missing document step for an already-confirmed transaction. It never re-runs a payment.
- **Read-only:** nothing on this screen can change a receipt or an event.

## How it is wired (minimal footprint)

- **`admin-os.html`:** one nav entry, one empty `panel-receipts`, and `<script src="sokoni-aos-receipts.js" defer>`.
- **`sokoni-aos.js`:** **unchanged**. The module loads itself the first time its panel is shown, so it can't conflict with other AdminOS work.

## Dependencies (release order)

- **Functions first:** `adminSearchReceipts` and `adminRetryReceiptFailures` live on commercial-fn (`65e85d1`, `bc9af28`). This hosting change must ship with or after them. Before that, the screen reports "could not be loaded — not an empty result".
- **No receipt claims to users:** per the owner, nothing tells users receipts exist until one complete production money path creates and shows one.

## Tests

`scripts/test-aos-receipts.js` passes 8/0:
- V1: wiring.
- V2: only the two callables, no Firestore access.
- V3: the retry button is shown to Super Admin only.
- V4: an error is not shown as empty.
- V5: real `card()` rendering — escaping, "—" method, B2B deduction distinct from fee, history order.

Existing suites are unchanged: admin-nav-context 3/0, home-logo-routing 31/0.
