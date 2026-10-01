# WhatsApp Cloud API — production setup and the SOKONI sender

**Status:** sender + status webhook BUILT and certified (31/0, sabotage 4/4), **not deployed**. Branch
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

## Deploy (after the secrets exist; one functions slot; scoped)
Export `whatsappWebhook` (buildFunction) from `functions/index.js`; wire the WhatsApp channel into `notify.js` on the
LIVE notify lineage (pinned candidate — the functions source lineages differ). Then the end-to-end test: six real
messages to the owner's phone, each proven by `whatsappSends/{wamid}.status == 'delivered'`, not by "it showed up".

## Not done here
`notify.js` channel wiring (needs the live lineage + secrets) · AdminOS view of `whatsappSends` · rules: no client
match for `whatsappSends` (default deny — keep it that way).
