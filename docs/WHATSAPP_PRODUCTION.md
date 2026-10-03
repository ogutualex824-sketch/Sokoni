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
