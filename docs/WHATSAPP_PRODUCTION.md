# WhatsApp Cloud API — production setup and the SOKONI sender

**Status (2026-10-03):** sender, status webhook, the `notify()` channel and the AdminOS trace are BUILT and certified,
**not deployed**. Production is **UNPROVEN**: see [Production gate](#production-gate-2026-10-03). Branch
`functions/whatsapp-channel-on-9894df2`. Related: [[WHATSAPP_CLOUD_API_CENSUS]] · [[Notifications]] · [[Completion PIN]]

## Owner decision (2026-10-01)
WhatsApp Cloud API may carry **all transactional messages** — OTP + completion PIN, invoices/receipts, marketing, and
order / payment / delivery / refund / booking updates — **server-triggered only**: the server chooses an approved
template from a real event and resolves the recipient. `wa.me` hand-offs stay banned; chat, bookings and support stay
in SOKONI. Routing by cost: push + in-app (free) first, WhatsApp for important messages, SMS only as the OTP/PIN
fallback.

## Architecture
```
SOKONI event ─► notify.js (ONE sender) ─► whatsapp-sender.sendTemplate ─► Graph API /{PHONE_NUMBER_ID}/messages
                                               │ accepted → whatsappSends/{wamid} {template, masked number, status:'accepted'}
Meta ─► whatsappWebhook (signed, HMAC over raw body) ─► whatsappSends/{wamid}: sent → delivered → read | failed
```
- **True state:** `{ok:true, messageId}` only when Meta returns a message id; otherwise `{ok:false, error}`
  (`NOT_CONFIGURED`, `UNKNOWN_TEMPLATE`, `PARAMS_MISMATCH`, `BAD_PARAM`, `BAD_RECIPIENT`, `NETWORK`, `META_<code>`).
- **Nothing secret is stored:** template parameters go to Meta only — never Firestore, logs or queues. A PIN never
  appears outside the Graph request (test X1–X4).
- **Status never moves backwards;** `failed` never overrides delivered/read; statuses for messages that are not ours
  are ignored.
- **Completion PIN** (sokoni-70, `shared/completion-pin.js`): `require('./whatsapp-sender').makeSender({...configFromEnv(), resolvePhone})`
  gives `sender(phoneOrUid, 'completion_pin', {code})` → `{ok, messageId, error}`; on `NOT_CONFIGURED` / failure the
  engine falls back to Africa's Talking SMS.

## Templates to create in WhatsApp Manager (names MUST match `functions/shared/whatsapp-templates.js`)
Language `en`. Variables in order. Suggested wording — edit freely, keep the variable count and order.

| Template | Category | Variables | Suggested body |
|---|---|---|---|
| `completion_pin` | Authentication | {{1}} code | Meta's authentication format: "{{1}} is your SOKONI delivery code." + **Copy code** button |
| `otp_code` | Authentication | {{1}} code | "{{1}} is your SOKONI verification code." + **Copy code** button |
| `order_confirmation` | Utility | name, orderRef, amountKES | "Hi {{1}}, your SOKONI order {{2}} is confirmed. Amount: KES {{3}}." |
| `payment_received` | Utility | name, amountKES, paymentRef | "Hi {{1}}, we received KES {{2}}. Reference {{3}}. Thank you for shopping on SOKONI." |
| `payment_failed` | Utility | name, paymentRef | "Hi {{1}}, payment {{2}} did not go through. Please try again in the SOKONI app." |
| `order_ready` | Utility | name, orderRef | "Hi {{1}}, your order {{2}} is ready." |
| `order_completed` | Utility | name, orderRef | "Hi {{1}}, order {{2}} is complete. Thank you for using SOKONI." |
| `delivery_started` | Utility | name, orderRef | "Hi {{1}}, your order {{2}} is on the way." |
| `delivery_arriving` | Utility | name, orderRef, eta | "Hi {{1}}, your order {{2}} arrives in about {{3}}." |
| `refund_pending` | Utility | name, orderRef, amountKES | "Hi {{1}}, your refund request for order {{2}} (KES {{3}}) is being reviewed." |
| `refund_processed` | Utility | name, orderRef, amountKES | "Hi {{1}}, your refund of KES {{3}} for order {{2}} has been processed." |
| `seller_new_order` | Utility | shopName, orderRef, amountKES | "{{1}}: new order {{2}} — KES {{3}}. Open SOKONI to prepare it." |
| `seller_return_request` | Utility | shopName, orderRef | "{{1}}: a return was requested for order {{2}}. Review it in SOKONI." |
| `booking_confirmation` | Utility | name, service, when | "Hi {{1}}, your {{2}} booking is confirmed for {{3}}." |
| `booking_reminder` | Utility | name, service, when | "Hi {{1}}, reminder: {{2}} on {{3}}." |
| `booking_cancelled` | Utility | name, service, when | "Hi {{1}}, your {{2}} booking for {{3}} was cancelled." |
| `invoice_issued` | Utility | name, invoiceRef, amountKES | "Hi {{1}}, invoice {{2}} for KES {{3}} is ready in SOKONI." |
| `foundation_donation_receipt` | Utility | name, amountKES, receiptRef | "Thank you {{1}}. We received your donation of KES {{2}}. Receipt {{3}}." |

## Owner checklist (Meta side — only the owner can do these)
1. Business Portfolio for Bravilex International Co. Limited → **business verification**.
2. **SOKONI WhatsApp Business Account** (keep the test WABA for development only).
3. A **dedicated SOKONI number** (not an everyday WhatsApp number); display name SOKONI; website mysokoni.co.ke.
4. A **System User** with a permanent token for the app (`whatsapp_business_messaging`, `whatsapp_business_management`).
5. Create and get approval for the templates above. Set up **billing** on the production WABA.
6. Store the secrets yourself — never in chat, files or commits:
   `firebase functions:secrets:set WHATSAPP_ACCESS_TOKEN` · `WHATSAPP_PHONE_NUMBER_ID` · `WHATSAPP_VERIFY_TOKEN` · `WHATSAPP_APP_SECRET`.
7. Point the app's webhook to the deployed `whatsappWebhook` URL with the verify token; subscribe to `messages`.

## The notify() channel (2026-10-03)
Live authority: `notify()` in `functions/notify.js`. Callers declare a TYPE, and the engine picks the channels:
in-app, then push, then SMS (forced for critical types, otherwise a fallback when push fails), then email.

- **WhatsApp replaces an SMS, never adds one.** It is tried only where an SMS would have been sent. If Meta accepts,
  `channels.sms = 'not_needed_whatsapp_accepted'`. Any other result leaves the SMS path unchanged.
- **Type → template** (`functions/shared/whatsapp-notify-map.js`, parameters taken from the SMS vars the caller
  already passes):

| notify type | template | params ← vars |
|---|---|---|
| otp · phone_verification · payment_verification | `otp_code` | code |
| order_placed | `order_confirmation` | name, orderId, total |
| payment_success | `payment_received` | name, amount, ref |
| payment_failed | `payment_failed` | name, ref |
| refund_processed | `refund_processed` | name, orderId, amount |
| order_dispatched | `delivery_started` | name, orderId |
| order_delivered | `order_completed` | name, orderId |

  `name` is the account's display name, read on the server. Every other type (password_reset, wallet_*, bookings,
  promotions, …) keeps today's behaviour. Booking and invoice templates are not reached from `notify()`, because
  those events have no SMS today.
- **Gates:**
  1. a mapped type;
  2. secrets present (otherwise `NOT_CONFIGURED`);
  3. **consent**: `users/{uid}.whatsappOptIn === true`;
  4. the recipient is the account's own `phoneNumber`, never a caller-supplied phone.

  `notifySend` (the browser) forces `whatsapp:false`.
- **Correlation:** event → `notifyLog/{key}` (`channels.whatsapp`) → `whatsappSends/{wamid}` (`ref = key`,
  `channel: 'WHATSAPP'`) → status webhook.
- **Completion PIN:** sokoni-70's `shared/completion-pin.js` uses `makeSender()` directly, with its own SMS fallback.
  That module is not on this lineage.
- **AdminOS:** Comms → WhatsApp tab → `adminListWhatsappSends` through `adminOsDispatch`. It is read-only and needs
  the admin claim. It shows: template, masked number, Meta id, status, accepted/sent/delivered/read/failed times,
  error code, notification key.

## Production gate (2026-10-03)
| Item | State |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` · `WHATSAPP_APP_SECRET` | configured |
| `WHATSAPP_ACCESS_TOKEN` · `WHATSAPP_PHONE_NUMBER_ID` · `WHATSAPP_WABA_ID` | **missing** (owner sets them in Secret Manager) |
| `webhookWhatsapp` | live at `https://webhookwhatsapp-o3jpu5wacq-uc.a.run.app` (da47bb6), **Meta has never called it** |
| Send-status advance (e39c367) | built, not deployed |
| `notify()` channel / AdminOS op | built, not deployed |
| Consent capture UI (`whatsappOptIn`) | **not built** |
| Six-message DELIVERED proof | **not run** |

## Deploy order (one functions slot, scoped `--only`, memory gate ≥512 MB)
1. The owner stores `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`.
2. `webhookWhatsapp`: pinned live archive + the e39c367 delta. Then set the callback URL + verify token in Meta and
   confirm verification **in Meta's dashboard**.
3. `adminOsDispatch`: pinned live archive + `admin-notification-trace.js` + the registry line.
4. The `notify()` callers that should carry WhatsApp: each is redeployed from its **own** live archive, with this
   notify.js hunk + `whatsapp-sender.js` + the two shared modules, and declares both secrets. A function that does not
   declare them stays `NOT_CONFIGURED` and uses SMS.
5. Hosting: the AdminOS tab ships with the hosting unit.
6. End-to-end test: six real messages to a consenting owner number. Each is proven by
   `whatsappSends/{wamid}.status == 'delivered'`, not by "it showed up".

## Production values check + consent closure (2026-10-03, sokoni-2f)

**Are the production values the owner's real WhatsApp? NO.** A read-only Graph check (values never printed) of the
five Secret Manager secrets in sokoni-aeb26 (latest versions 06:03–06:05Z today):

| What | Observed |
|---|---|
| Phone number | Meta **Test Number** (+1 555…), `code_verification=NOT_VERIFIED`, display name **DECLINED** |
| WABA | **"Test WhatsApp Business Account"**, review **REJECTED**, business verification **not_verified** |
| Number belongs to that WABA | yes (the token now loads the WABA; the earlier "error 100" is gone) |
| SOKONI templates | **0 of 18** present (the WABA holds only Meta's sample `jaspers_market_*` + `hello_world`) |

So a production send would go from Meta's test number, can reach only allow-listed testers, and every SOKONI
template would be refused (no such template). **Owner-only, on the Meta side:** add + verify the real SOKONI
number in the real (business-verified) WABA, create the 18 templates above with exactly those names, then
replace `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_WABA_ID` / `WHATSAPP_ACCESS_TOKEN` (permanent system-user token)
with the real values, and register the webhook URL + verify token in the app. Re-run the check afterwards.

**Closed in code (NOT deployed):**
- `webhookWhatsapp` export restored in `functions/index.js`. This branch had lost it in the rebase, so a scoped deploy
  would have found no such function. It is identical to the live export (da47bb6).
- **Consent** — `functions/whatsapp-consent.js`, callable `whatsappConsent` (`op:'get'|'set'`):
  - It is the ONE writer of `users/{uid}.whatsappOptIn`, and acts on the caller's own account only.
  - The phone number is read on the server, not from the browser.
  - It stores `whatsappOptInPhone`, the consent version and the server time.
  - Every change is audited in `whatsappConsentEvents` (masked number). A no-op writes nothing.
- **notify() gate tightened:** a send needs `whatsappOptIn === true` AND `whatsappOptInPhone` equal to the current
  `phoneNumber`. A self-written flag, or a changed number, is refused as `NO_CONSENT`.
- **STOP:**
  - An inbound signed message reading stop / unsubscribe / cancel / acha / sitisha opts out every account on that number.
  - The words are not stored; only a boolean is.
  - An unsigned request changes nothing.
- **UI:** Profile → Settings → "WhatsApp updates" switch (hosting branch `hosting/profile-wallet-instant-on-72dca56`).
  It shows only the server's answer ("—" until then).

**Tests:**
- test-whatsapp-consent 14/0 (new); test-whatsapp-notify 34/0 (+C3b, C3c); test-whatsapp-webhook 28/0 (was 27/1);
  test-whatsapp-sender 31/0; test-admin-whatsapp-trace 17/0.
- Sabotage: phone-match removed → C3b/C3c FAIL; STOP wiring removed → S4 FAIL; NO_PHONE removed → K4 FAIL.

**Deploy additions** (still one slot, after sokoni-5b's webhookIntasend and the Foundation trio, memory gate ≥512 MB):
- `--only functions:whatsappConsent` (new).
- Then `webhookWhatsapp` (STOP + status advance).
- notify's tightened gate rides with each notify-bundling function's own deploy.
- `093fd4f` (Daraja removal) is cherry-picked first.

**Still OPEN:**
- Live `notifySend` lets a non-admin pass `phone` + a critical `type` (SMS to any number). This is a separate slice.
- Firestore rules still let a user write `whatsappOptIn` on their own doc. Harmless now, because the gate also needs
  the server-written number. Lock it in the combined rules candidate.
