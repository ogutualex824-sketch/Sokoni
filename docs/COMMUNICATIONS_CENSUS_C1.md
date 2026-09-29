# Communications census (Slice C1)

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` · **Read-only** — nothing changed in this slice.
Scope from the owner directive: email (SendGrid), Africa's Talking, phone/support number, in-app communications,
notifications, and how the AdminOS workspace reaches them. Related: [[COMMUNICATION_ENGINE]] ·
[[COMMUNICATION_NOTIFY_BYPASS_BACKLOG]] · [[SOKONI_CONNECT]] · [[INTEGRATION_EVIDENCE_MODEL_B]] ·
[[ADMINOS_NAVIGATION_CERTIFICATION]].

Evidence vocabulary: **observed** (read in code or measured) · **provisioned** (a credential/param exists) · **not
implemented** (no code path) · **unknown** (not measurable from here). Nothing below is inferred from what a provider
*offers*.

## 1 · Capability matrix

| Capability | State | Evidence |
|---|---|---|
| **Email — outbound send** | implemented; deployed | `functions/email-service.js`: SendGrid primary (`SENDGRID_API_KEY`), SMTP fallback (`MAIL_HOST/USER/PASS`); queue, retry, dedupe by `emailId`; `emailLogs` (`pending` → `processing` → sent/failed, `bounced`); `Message-ID: <emailId@domain>`. Callers: `notify.js` (the one engine), `communication-send.js` (`communicationSend`, admin), `email-triggers.js`, auth/commerce dispatchers. |
| **Email — sender identities** | implemented | 24 send-only `FROM` identities on the authenticated domain (`noreply@`, `verify@`, `support@`, `accounts@`, `orders@`, `payments@`, `billing@`, `disputes@`, `tickets@`, `events@`, `seller@`, `vendors@`, `delivery@`, `dispatch@`, `drivers@`, `tracking@`, `property@`, `health@`, `law@`, `security@`, `tech@`, `marketing@`, `notifications@`). 22 dormant identities were retired 2026-07-21. |
| **Email — reply routing** | implemented, **external** | Universal `Reply-To` = `support@mysokoni.co.ke`, "the single monitored destination". It is monitored in the domain mailbox provider (HostPinnacle/Workspace) — **outside SOKONI**. No reply ever lands in the platform. |
| **Email — delivery events** | implemented; deployed | `emailWebhook` (`email-triggers.js:867`, HTTP 405 on probe): SendGrid Event Webhook, HMAC verified when `SENDGRID_WEBHOOK_KEY` is set (accepts with a warning when unset); `open`/`click`/`bounce`/`dropped` → `emailLogs`. Events are evidence about *outbound* mail, not inbound mail. |
| **Email — inbound mail** | implemented **for DMARC reports only** | `dmarcReportWebhook` (`email-dmarc.js:260`, HTTP 405): SendGrid Inbound Parse for host `reports.mysokoni.co.ke` (MX → `mx.sendgrid.net`), parses DMARC XML attachments. No Inbound Parse host for `support@` or any human mailbox. |
| **Email — two-way mailbox / threading** | **not implemented** | No inbound path for human mail; no `In-Reply-To`/`References` handling; no thread store; `communication-send.js:324`: *"we have no human mailbox transport"* (`google_workspace` reported absent). |
| **Email — admin surface** | implemented (broadcast only) | AdminOS Communications → Email Blast → `adminSendEmailBlast`; Push → `adminSendPushNotification`; SMS → `adminSendSMSBlast`. Broadcasts, not conversations. |
| **Templates** | implemented | `functions/email-templates.js` (branded layouts, `SUPPORT_URL`/`HELP_URL`), `sms-service.js` `TEMPLATES`, `notify.js` `TYPES` (48 registered types with per-channel policy). |
| **Unified timeline** | implemented | `communication-timeline.js` joins `conversations`, `connectSessions`, `notifyLog` (push/SMS/email envelopes sent through `notify()`), `notifications`, `supportTickets`. Email sent **outside** `notify()` (direct `email-service.send`) is not on it — the bypass backlog. |
| **SMS — outbound** | implemented; deployed | `sokoni-at.js` (transport; `AFRICASTALKING_API_KEY/USERNAME`, `AT_ENV`, `AT_SENDER_ID` param — empty until the "SOKONI" sender ID is approved, so the shared shortcode is used) under `sms-service.js` (templates, idempotent `smsQueue` keyed by `dedupeKey`, `smsDeadLetter`, `smsPreferences`, `smsQueueWorker`, `smsEnqueue` HTTP 400 on probe). |
| **SMS — delivery reports** | implemented; deployed | `smsDeliveryWebhook` (`sms-service.js:499`, HTTP 405): token-gated (`SMS_WEBHOOK_TOKEN`, query or `x-sms-token`), writes `smsDelivery/{providerMessageId}` (status, network code, failure reason, phone tail only). Inbound **evidence**, never a probe. |
| **SMS — inbound (MO) messages** | **not implemented** | No AT incoming-message handler anywhere in `functions/`. |
| **Voice / USSD (Africa's Talking)** | **not implemented** | Only a comment that `atBuildClient()` *could* be used for Voice/USSD; no caller of `atBuildClient` exists outside its own file. |
| **Push / in-app** | implemented | `notify.js` (FCM via Admin SDK; in-app `notifications`); policy by type: critical → SMS+push+in-app, commerce → push then SMS fallback, marketing → push+email (SMS opt-in). |
| **In-app calls / video** | implemented (transport honest) | SOKONI Connect: `PROVIDERS = { webrtc: true, pstn: false }`; TURN unprovisioned (`TURN_URL/CREDENTIAL` absent); certified 856/0. Slices V1–V3 attached video verification to records. |
| **Provider health** | implemented | `communicationHealth`: **provisioning** (credential presence, never values) on one axis, **observations** (outcomes of real sends, `unobserved` until one happens) on the other. |
| **Support phone — authoritative** | implemented | `functions/company-identity.js:81` and `sokoni-company.js:62`: `supportPhone: '+254 705 726 803'`; `contact.html` shows it (and a second "Call us" line `+254 722 376 801` whose authority is not in any config). |
| **Support phone — `support.html`** | ~~fabricated~~ **repaired (C5)** | `support.html` linked a placeholder `tel:` number nobody answers. Since C5 every support-number control on `support.html` and `contact.html` is `[data-support-phone]` and is filled by `SOKONI_COMPANY.applySupportPhone()`; with no configured number the control loses its href and reads "Support line not configured". Evidence `scripts/test-support-phone.js` 9/0. |

## 2 · What "email as a first-class workspace" requires — exactly what is missing

The target flow *incoming email → workspace → thread → reply → provider → inbound reply → same thread* needs four
things SOKONI does not have. Each is named so it cannot be papered over:

1. **An inbound mail path for a human mailbox.** Today only `reports.mysokoni.co.ke` is parsed. Missing: an Inbound
   Parse host (e.g. `mail.mysokoni.co.ke` or `support@`'s domain) with MX → SendGrid, and a **signed** receiver
   (`mailInboundWebhook`) that stores the message — never a synthetic observation, always the actual post.
2. **A thread store with correlation.** Missing: `emailThreads/{threadId}` + `emailMessages/{id}` keyed by
   `Message-ID`, correlating replies by `In-Reply-To`/`References` to the `emailId` SOKONI stamped on the outbound
   message (`X-Entity-Ref-ID`). Anchors to `supportTickets`, `verificationRequests`, `applications`, `users`,
   `businesses` where an authoritative id exists (the V2 `context` shape).
3. **A reply path that stays in the thread.** Missing: `email-service.send` support for `In-Reply-To`/`References`
   headers and a per-thread Reply-To that returns to the parsed host, not to the external `support@` mailbox.
4. **The UI's status must say which of the two exists.** Outbound sending is real today; a two-way mailbox is not.
   The workspace must label "Send" as available and "Reply from here / inbound" as **not provisioned** until 1–3 are
   built *and* observed — per the owner's correction, never "reply from here" before inbound threading is proven.

Until then: `support@` replies are answered in the external mailbox; SOKONI can *see* that it sent, opened, clicked or
bounced, and nothing more.

## 3 · Integration console — what the catalogue claims vs. what is observed

| Entry | Catalogue today | Observed | C3/C4 reconciliation |
|---|---|---|---|
| `sendgrid` | `status: live, direction: bidirectional`, "inbound event webhooks" | outbound ✓; event webhook ✓ (inbound *events*); inbound *mail* ✗ except DMARC | keep `live` for outbound; the inbound-mail rail is a separate **declared, no-safe-probe** lane; event/DMARC receivers are the inbound/correlation lane (evidence = the posts they received, never a probe). Configuration presence stays *provisioned*, never *ACTIVE*. |
| `africastalking` | `status: live, direction: bidirectional` | outbound SMS ✓; delivery-report webhook ✓; inbound SMS ✗; voice ✗ | "bidirectional" is true only as *delivery reports*; voice/USSD must not appear as capabilities. Sender ID: shared shortcode until `AT_SENDER_ID` is approved — that is the correct state, not a defect. |

`integrationProbeLatest`, `no_safe_probe`, `requires_secret_binding`, REFUSED-BY-DESIGN vs UNKNOWN: untouched by this
census and to stay so in C2–C6.

## 4 · Plan implied by the census

- **C2 — Email workspace (AdminOS Communications → Email).** Outbound composer through `notify()` /
  `communicationSend` (anchored to a record via the V2 `context` shape), `emailLogs` timeline per record, delivery
  events shown as evidence, and an explicit **"Inbound mail: not provisioned"** panel that lists items 1–3 above with
  their current state. No "reply" control until inbound is real.
- **C3 — SendGrid in the evidence model.** Catalogue entry split by lane (outbound send · delivery events ·
  inbound mail); operational workspace link → C2; no synthetic observation for inbound.
- **C4 — Africa's Talking in the evidence model.** SMS outbound + delivery reports; sender-ID state as a declaration;
  voice/inbound marked not implemented; operational workspace = the existing SMS blast + `smsStats`.
- **C5 — Support number surface. DONE (this branch).** One source (`SOKONI_COMPANY.supportPhone` ↔ `company-identity.js`,
  parity asserted); `support.html` (Call Support, WhatsApp card, ticket follow-up) and `contact.html` (two WhatsApp
  tiles, Alternative line, footer icon) read it through `[data-support-phone]`; the fabricated placeholder removed;
  fail-closed "not configured" proven by a negative control. **Left for the owner:** the `+254 722 376 801` "Call us"
  line on `contact.html` and `index.html` still has no configured authority — it was neither removed nor promoted;
  hub pages carry placeholder-looking numbers (`car-hub`, `food-rider`, `healthcare`, `legal`), reported by the suite,
  outside this slice.
- **C6 — Cross-app links.** Merchant, buyer, Super Admin, Connect, support and email link to the same records by
  stable ids (`context`), never a local copy.

## 5 · Deployment state (read-only probe, 2026-09-29)

`emailWebhook`, `smsDeliveryWebhook`, `dmarcReportWebhook` → HTTP 405 (deployed; GET refused);
`communicationSend`, `notifySend`, `smsEnqueue` → HTTP 400 (deployed; unauthenticated call refused).
Functions deploys remain gated by the merchant-identity provenance gap; nothing in this census changes that.
