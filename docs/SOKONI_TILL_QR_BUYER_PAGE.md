# Buyer-facing SOKONI Till payment page — /pay/q/** (Q8)

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · CERTIFIED (pure core + served-page browser
check). COMMITTED · STACKED. NOT ON R1 · NOT DEPLOYED.** Production remains `d592d8f`/v632,
untouched.
**Date:** 2026-09-03

**Scope:** the page a buyer actually lands on after scanning either QR product, wired to the
already-certified backend (Q5 QR authority, Q6 attribution, Q7 PAID transition) with no new
payment authority invented on the client. One real, proven, unavoidable backend dependency was
found during the trace (§2) and fixed narrowly, not worked around.

---

## 1. Trace — `resolveSokoniQR` → existing IntaSend initiation, followed all the way through

```
buyer scans QR -> /pay/q/{token}
  -> resolveSokoniQR({token})                              (Q5, unmodified except §3 below)
       type:'till'   -> { sokoniTillId, shopName, currency }              — no amount
       type:'intent' -> { ref, amount, currency, shopName, status }       — fixed amount
  -> [till only] createPaymentIntent({purpose:'pos_till_sale', sokoniTillId, amount})
       (EXISTING, UNMODIFIED — the buyer's typed number is only ever the SEED; the
       RETURNED ref/amount is what every later step uses, never the raw input again)
  -> initiateSTKPush({phone, ref, amount})                  (EXISTING — see §2, one narrow fix)
  -> webhookIntasend -> attribution -> paymentIntents/{ref}.status = 'paid'    (Q6/Q7, untouched)
  -> the page observes THAT transition — §4 — and only then shows success
```

## 2. The one real, proven blocking dependency: `initiateSTKPush`'s ownership check

`initiateSTKPush` (`functions/index.js:6521`) refuses to push an STK request whenever
`intent.uid !== request.auth.uid` — correct for subscriptions/checkout/bookings, where the payer
mints their own intent. **Traced concretely for the dynamic-QR flow and confirmed it fails
outright:** the intent is created by the CASHIER (Q5's `pos_till_sale` cart-mode requires
`callerUid === till.merchantUid`), but the person who must push the STK request — and receive the
prompt on their own phone — is the WALK-UP BUYER scanning the QR, a different uid by design, every
time. Without a fix, **every dynamic-QR payment would be refused with "This payment does not
belong to you"** the moment the buyer's page called `initiateSTKPush`. This is exactly the kind of
dependency the instruction asked to prove before touching the function, not assume away.

**The narrow, evidenced fix** (`functions/sokoni-qr-authority.js`, new `canInitiateStkForIntent`,
certified in isolation, 74/74 in the Q5 suite including a dedicated sabotage control): the
ownership check gets ONE additional `||` clause — true only when the intent unambiguously IS a
`pos_till_sale` intent whose money-routing is ALREADY fully locked to the Till's own merchant
(`metadata.merchantUid`, Q6-hardened). This is safe specifically because the STK caller's identity
has **zero influence** on money movement once such an intent exists:

- **Who gets credited** — `attribution.merchantUid` (Q6), never `payData.uid`, for any Till sale
  with populated Till metadata. The buyer's uid becoming `payments/{ref}.uid` changes nothing
  downstream.
- **What is charged** — the amount-match check immediately below (`expected !== amountKES` →
  throw) is **unconditional whenever an intent exists**, untouched by this fix, and `pos_till_sale`
  *always* has an intent (Q5's flow mints one before any QR exists) — so this dependency did not
  even require touching D2 (Stage-1b enforcement, which only governs the *missing-intent* case).

Every OTHER purpose's ownership check is enforced **exactly as before** — certified directly
(`canInitiateStkForIntent` returns `false` for `subscription`/`product_order`/`digital_download`/
`service_booking`/`event_ticket`/`hub_registration`, and for a `pos_till_sale` intent with no
`metadata.merchantUid`, defence in depth). No global loosening — a scoped, evidenced exception.

## 3. Extending `resolveSokoniQR` for post-payment polling (Q5's own function, not D1-D4)

The buyer's page needs to know when a payment finishes. Two different mechanisms, chosen by who
owns the intent (this asymmetry is inherent to the Q5 design, not new here):

- **Permanent-Till flow:** the buyer created the intent themselves (`intent.uid` == the buyer) —
  they can read `paymentIntents/{ref}` directly, the existing owner-only rule already allows it.
  The page uses a plain Firestore `onSnapshot` listener. No backend change needed.
- **Dynamic-QR flow:** the CASHIER owns the intent — the buyer has no rule-based read access.
  The only channel the buyer already has is the signed token itself, so the page polls
  `resolveSokoniQR({token})` again. This required one small, deliberate extension:
  `classifyIntentResolution` (Q5's pure core) previously treated `status:'paid'` as a **refusal**
  ("This payment is no longer available") — correct for a fresh scan, wrong for a buyer polling
  their *own* just-completed sale. `status:'paid'` is now a distinct **success** outcome
  (`{ok:true, status:'paid'}`); `completed`/`cancelled`/`expired` remain refusals, unchanged. This
  creates no new payment-initiation risk: `initiateSTKPush`'s own unmodified idempotent-replay
  guard (`payments/{ref}.status === 'COMPLETE'` → `alreadyPaid:true`, no re-charge) is what
  actually prevents a double payment, not this resolution function — re-run and confirmed still
  passing (74/74, including the pre-existing "terminal status refused" cases for the three statuses
  that still ARE refusals).

## 4. The page — state machine, never a client-side shortcut

`pay-q.html` (new) + `sokoni-pay-q-core.js` (new, pure client-side core, no DOM/Firebase — the
token-parse/phone-validate/payment-decision logic, certified with Node,
`scripts/test-pay-q-core.js`, same methodology as every backend pure core in this programme).
`firebase.json` gained `/pay/q/**` → `/pay-q.html`, inserted **before** the existing broader
`/pay/**` rewrite (Hosting matches top-to-bottom, first match wins — verified by reading the
existing rewrites array before editing).

States: loading → sign-in-required (if unauthenticated — `resolveSokoniQR` requires auth, matching
every other purpose's existing convention, Q5) → resolved (till: amount input; intent: fixed,
non-editable amount + already-paid short-circuit) → paying → **waiting** (never skipped) → paid /
error. Explicitly, by construction:

- **QR page loaded ≠ payment started** — `resolveSokoniQR` only reads and displays; nothing is
  charged by loading the page.
- **payment started ≠ payment confirmed** — after `initiateSTKPush` returns successfully (not
  `alreadyPaid`), the page transitions to `stateWaiting` and shows "check your phone," never
  "paid."
- **payment confirmed ≠ POS marked paid, until the page itself observes it** — `stateWaiting` only
  ever exits via `paymentIntents/{ref}.status === 'paid'`, observed either through the buyer's own
  Firestore read (permanent Till) or through `resolveSokoniQR`'s polling (dynamic QR) — both
  reflecting Q7's write, which only `webhookIntasend` performs after a verified IntaSend event.
  **The page itself never sets any status; it only ever reads one.**
- **The dynamic-QR amount is never editable, and never buyer-supplied even internally** —
  `sokoni-pay-q-core.js`'s `decidePaymentAction` does not read `rawAmountInput` at all in the
  `'intent'` branch (certified directly, including a tampered-input test that proves a hostile
  value is ignored even if it somehow reached the function) — proven by construction, not by a
  check that could be forgotten. The page's own DOM doesn't even render an amount field for that
  case (`#amountInputWrap` stays `hidden`).

## 5. Certification

**Source/static (pure core):**
- `functions/sokoni-qr-authority.js` extended (Q5's own file — `classifyIntentResolution`'s
  'paid' outcome, `canInitiateStkForIntent`) — `scripts/test-sokoni-qr-payment.js`, now **74/74**
  (was 60/60; +14 for the two Q8 additions, including a dedicated second sabotage control for
  `canInitiateStkForIntent`'s purpose check).
- `sokoni-pay-q-core.js` (new) — `scripts/test-pay-q-core.js`, **43/43**, negative control, and a
  sabotage control proving the "dynamic-QR amount is server-only" invariant would be caught if it
  regressed.
- Q6 (34/34) and Q7 (19/19) suites re-run clean — no regression from any Q8 change.

**Served-page / browser check found a real bug, then confirmed the fix — exactly why this check
was required, not optional.** `pay-q.html` was served locally (a static file server mimicking the
real `/pay/q/**` hosting rewrite — no live backend, matching "no deployment") and loaded headless.

**First pass: a real, silent defect.** The three `<script src="...">` tags (`security.js`,
`shared-header.js`, `sokoni-pay-q-core.js`) were root-relative *without* a leading slash. On a page
served at `/pay/q/{token}` — two path segments deep — the browser resolved them against `/pay/q/`,
not `/`, so the requests landed on `/pay/q/security.js` etc. The `/pay/q/**` rewrite caught those
too, serving `pay-q.html` itself back as the "script." Chromium silently declines to execute a
`text/html` response as a classic script — **no `console.error`, no `window.onerror`, nothing** —
so the page simply sat on `stateLoading` forever, `window.SokoniPayQCore` stayed `undefined`, and
this would have shipped invisibly to a plain "check the console" pass. Confirmed via DOM
inspection (`document.querySelectorAll('script[src]')` showed the wrong, nested URLs) and `curl`
(each of the three URLs returned a 200 with `pay-q.html`'s own HTML body, all three the identical
byte size).

**Fix:** leading slashes on all three tags (`/security.js`, `/shared-header.js`,
`/sokoni-pay-q-core.js`), matching the already-correct `import ... from '/firebase.js'` immediately
below them.

**Re-verified after the fix, same method:** the three script tags now resolve to
`http://.../security.js` etc. (root-level, confirmed via `curl` and DOM inspection — correct
`Content-Type: application/javascript`, correct byte size); `window.SokoniPayQCore` loads,
`typeof window.SokoniPayQCore.parseToken === 'function'`, and calling it in-page against the real
URL returns the exact expected token string; the page's active state is confirmed
`stateSignin` (not stuck on `stateLoading`) — the correct, honest outcome for a fresh headless
session with no live Auth. Console/network: only the expected App Check 403 noise
(`content-firebaseappcheck.googleapis.com/.../exchangeDebugToken`, unavoidable without a real
deployed backend) plus one benign connectivity-check probe abort; no `ReferenceError`/
`TypeError`/`SyntaxError`, no new errors introduced by the fix, no 404s for any local dependency.

**What "real user journey" honestly means without deployment, stated plainly:** the certification
above proves the CLIENT-SIDE decision logic is correct by construction (Node, no browser needed
for that half) and that the REAL page file parses, mounts, and reaches the correct first gated
state in a REAL browser. It does not exercise a live IntaSend sandbox charge or a live webhook
round-trip — that would require deployment, which this slice explicitly does not do. The backend
half of the same journey (attribution, PAID transition, replay-safety) was already certified
end-to-end at the pure-core level in Q5-Q7 and re-run clean here.

---

## What this slice does NOT do

Does not touch `posCompleteCheckout`, `posRetailSales`, `posSales`, `retailSettlements`,
`commission-config.js`/D4, or `intasendWebhook` — the trace found no dependency on any of them.
Does not fix D1/D2/D3 globally — see the status note below. Does not deploy, and does not touch
`C:/temp/sok-r1`.

## D1/D2/D3 — reaffirmed open, not silently considered fixed

Per explicit instruction: Q5-Q7 avoided the D1-D3 hazards **on the Till path specifically** by
construction (server-derived metadata, never client meta, for that path). They are **broader**
payment-system defects, unrelated purposes still carry them, and nothing in Q8 changes that.
`docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md` remains the standing, open record — not touched by this
slice beyond this reaffirmation.

## Related

`docs/SOKONI_TILL_QR_IMPLEMENTATION.md` (Q5) · `docs/WEBHOOK_ATTRIBUTION_AUTHORITY.md` (Q6) ·
`docs/POS_QR_PAID_STATE_INTEGRATION.md` (Q7) · `docs/PAYMENT_AUTHORITY_DEFECTS_LOG.md` (D1-D4,
unaffected) · `functions/sokoni-qr-authority.js` (extended) · `functions/index.js`
(`initiateSTKPush` — 1 hunk, the ownership-check exception) · `pay-q.html`, `sokoni-pay-q-core.js`
(new) · `firebase.json` (`/pay/q/**` rewrite) · `scripts/test-sokoni-qr-payment.js`,
`scripts/test-pay-q-core.js` (certification)
