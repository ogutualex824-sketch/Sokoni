# Gate 13 — Browser Fabrication Census

Measured 2026-10-03 on `hosting/intasend-card-wizard-on-72dca56` with `scripts/browser-fabrication-census.js`
(64 client writes of a payment-success state in 34 files), then classified by hand. Related:
[[IntaSend Convergence Brief]], [[IntaSend-Only Payment Gate]].

**Result: no BROWSER_AUTHORITY payment completion remains on this branch.** Live production (72dca56) still has the
ones fixed here until the hosting deploy. The `bookingFees` Firestore rule still lets any signed-in user create a fee
record, which is an open rules item.

## Blockers found and their state

| Where | What the browser decided | State |
|---|---|---|
| `bnb.html` booking | "Payment confirmed!" after 4 s; booking `confirmed`, invoice, commission, host message, no payment | Fixed 265b1f7 (`_finalise` now unreachable) |
| `pos.js` sendSTK | `SIMULATED_` checkout "confirmed" after three polls; sale completed unpaid | Fixed a436e12; IntaSend POS rail on 99e1177 (sokoni-2f) |
| `landlord.html` no-key branch | "Payment Confirmed!" after 3 s; rent `paid:true` | Fixed a436e12; superseded by sokoni-f3's B2 df1a4cb (rent recorded as external, never confirmed) — B2 wins at merge |
| `landlord.html` IntaSend COMPLETE | browser event writes rent `paid:true` | Removed by B2 df1a4cb (no provider call at all) |
| `car-hub.html` confirmBooking | booking takes NO payment, yet wrote an "auto-collected" commission and a paid booking fee | Fixed this commit |
| `sokoni-pay.js` saveFee (callers: car hub, checkout, food, IntaSend client) | wrote `bookingFees/{ref}` to Firestore with a page-supplied amount; admin.html reads it as revenue | Fixed this commit: local display cache only |
| `sokoni-intasend.js` _recordCommission | after the webhook-written payment doc, the browser wrote `bookingFees/{ref}` ("intasend_confirmed") itself | Fixed: no-op; the server ledger is the record |
| `pos-checkout.html` gift card | `PosLoyalty.redeemGiftCard` debits IndexedDB only (the direct `giftCards` update is refused and the error swallowed), then sends `{method:'gift_card', amount: total}` to `posCompleteCheckout`, which never verifies non-M-Pesa/card tenders | **OPEN — BROWSER_AUTHORITY.** Server half (fail-closed tender allow-list; gift card redeemed inside the checkout transaction through one `giftCards` authority) = sokoni-5b, POS lane, owner decisions pending |
| `sokoni-invoice.js` | every invoice said "Total Paid" / "Paid via M-Pesa", including unpaid bookings (27 callers) | Fixed this commit: PAID only with `paymentVerified:true`; checkout passes its server-verified flag |

Test: `node scripts/test-browser-payment-authority.js` (5/0, 5/5 sabotages; the invoice check executes the real
builder and renderer).

## Classification of the 64 writes

| Class | Count | Where |
|---|---|---|
| BROWSER_AUTHORITY | 0 remaining | the blockers above, all fixed or superseded on this branch |
| LEGACY_INACTIVE | 3 | `bnb.html:304` (`_finalise`, no caller), `landlord.html:1670` (retired engine's onSuccess, unreachable), `landlord.html:1714` (removed by B2) |
| SERVER_CONFIRMED | 4 | `referral.html:611` maps a server `completed` to a label; `sokoni-intasend.js:305` writes only after `_waitForPaymentConfirmation` reads the webhook-written payment document (its Firestore fee write is now gone); `legal-hub.html:4706/4710` status set by the `updateConsultationStatus` function, local mirror after it |
| DISPLAY_ONLY | 9 | `sokoni-banking-pro.js:583` (a business marks its own invoice paid; localStorage and a local "wallet" only — see note); `landlord.html:1107` (landlord records rent received, owner's own record); `sokoni-invoice.js:272` (now conditional); `fitness-hub.html` ×3, `healthcare.html:1011`, `provider.html:1302`, `bnb-hub.html:587` (booking status, not a payment claim) |
| NON_PAYMENT_REFERENCE | 30 | delivery / logistics / navigation / commissioning / POS sale-record "completed"; `financial-os.html:808` (admin records a manual bank payout — see note); workflow and audit statuses (`sokoni-wap-definitions.js`, `sokoni-webhook-engine.js`, `digital-esoko.html`, `sokoni-sports.js` fixtures) |
| DEMO / MOCK DATA | 18 | `demo-seed.js`, `sokoni-mock-data.js`, `sokoni-dev-mock.js`, `sokoni-test-suite.js`, `provider.html:1104/1106` samples, `pos-printer-setup.html:1826` sample receipt, `sokoni-pay.js:807-848` (`seedDemoRevenue`, manual dev only, not auto-run) |

## Open items

| Item | Owner |
|---|---|
| `bookingFees` rule: client `create` must be `false`. **Done in the rules candidate** (sokoni-f3, after b778499 on rules/capability-decisions-on-f20be7d); live until that rules release ships. | Rules release |
| `orders` create: `paymentStatus` limited to pending/unpaid/idle/pending_payment. **Done in the same rules candidate**; update branches were already closed. | Rules release |
| `admin.html` (legacy) reads `bookingFees` and local ledgers as revenue. AdminOS is canonical; the legacy page should read the server `commissionLedger` or stop showing revenue. | Admin surfaces |
| `sokoni-banking-pro.js` local "wallet" balance moved by a manual "mark paid" — local-only, but presented as a wallet. | Banking Hub (sokoni-2f) |
| `financial-os.html:808` admin marks a manual bank payout `completed` from the browser. | Payouts lane (sokoni-2f) |
| `sokoni-order-service.js:101/142` labels POS in-store sales `paymentStatus:'paid'` in the unified order view (a read model, DISPLAY_ONLY) — it should carry the sale's real payment state once POS M-Pesa is server-confirmed. | POS workstream |
| `sokoni-payment-engine.js:798` `recordCompleted` writes `orders/{id}.paymentStatus:'paid'` and runs a split from the browser. No page calls it (LEGACY_INACTIVE), but it is loaded on live pages and callable from a console: the `orders` rules must refuse a client `paymentStatus` write. Remove the method. | sokoni-b2 (removal) · rules release (verify) |
