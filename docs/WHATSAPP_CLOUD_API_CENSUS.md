# WhatsApp Cloud API — census, and a directive conflict to resolve first

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` · **Read-only. No code, no
catalogue change, no deploy.**

Run before writing anything, as the WhatsApp brief itself instructs — and for the reason that brief
gives: *"declaring WhatsApp support is not the same thing as having a working WhatsApp
integration."* That is the `sokoni-webhook-engine.js` lesson, and it applies here more than
anywhere.

---

## 1 · This is NOT a repeat of the 09-27 census

`project_whatsapp_handoff_census` (2026-09-27) already counted **hand-offs** — `wa.me` links — and
classified them: 12 replace-payment · 39 replace-booking · ~154 replace-communication · 43
keep-share · 3 inert server channels. That work stands and is not redone here.

This asks a different question: **does any mechanism exist to send or receive through Meta's API?**

## 2 · The answer: the capability is ABSENT, not unconfigured

| signal | code files | what it would prove |
|---|---|---|
| `graph.facebook.com/v*/…/messages` | **0** | a send path |
| `graph.facebook.com` (anything) | **0** | any Graph call at all |
| `phone_number_id` | **0** | a business number bound |
| WABA / `whatsapp_business_account` | **0** | an account |
| access token (`WHATSAPP_*`, `WA_*`, `META_*`) | **0** | credentials |
| `hub.challenge` / `hub.verify_token` | **0** | a webhook receiver |
| WhatsApp Flows | **0** | structured interactions |
| catalog / `product_retailer_id` | **0** | product messages |

**Every one is zero.** A Cloud API integration needs a send path, a phone-number-id, a token and a
webhook verify handler. None exists. This is *absent*, which is a different fact from *present but
unconfigured* — and the distinction matters, because an absent capability cannot be fixed by adding
a secret.

**Two apparent hits were false positives**, both worth recording because they are the same class of
error as the `discPanel` → "cPanel" trap:

- `functions/email-triggers.js:25` — `async function trigger(templateName, …)`. **Email** templates.
- `home-services.html:306` — the pattern `hsm` (WhatsApp's Highly Structured Message) matched inside
  the element id **`hsMyJobsList`**.

Adjacent Meta surface that *does* exist: **Facebook Login**, 14 code files, already catalogued as
`facebook-login`. It shares a Meta app with WhatsApp in most setups, which is worth knowing when
credentials are provisioned — but it is not a WhatsApp capability.

## 3 · What SOKONI has today is the inverse of the brief

```
the brief proposes     Cloud API  →  conversation comes INTO SOKONI
SOKONI has             98 code files with wa.me hand-offs  →  conversation LEAVES
                       0 files with any API capability
```

So the platform currently has the thing the owner **banned** on 09-27, and none of the thing the
brief **proposes**.

## 4 · The conflict that has to be resolved before any code

**A ratified directive says the opposite of this brief**, and it should be updated deliberately
rather than quietly overtaken.

`feedback_no_whatsapp_everything_in_app` — owner, 2026-09-27:

> *"no whatsapp payment everything in app communication and all booking"*
>
> **Payments:** IntaSend only. **Bookings:** in-app booking authorities. **Communication:** SOKONI
> in-app messaging. **Keep:** social SHARE of a SOKONI link — distribution, not communication.

The brief asks for campaigns, support conversations, buyer conversations and in-conversation
ordering over WhatsApp. On its face that is the banned column.

### But the two are not straightforwardly contradictory, and the reason matters

The 09-27 directive banned hand-offs **for a stated reason**:

> *no server-verified payment · no booking record · no conversation anchor, audit or moderation*

A `wa.me` link takes the conversation outside SOKONI and leaves nothing behind. **The Cloud API does
the opposite**: messages arrive by webhook into the communications engine, every event is recorded,
delivery and read status are observable, and the brief explicitly keeps **IntaSend as the payment
authority** rather than making WhatsApp a second rail.

So the new architecture **answers the objection the directive was built on**. What it still
contradicts is the directive's *letter* — "communication all in-app".

**That is the owner's call, not mine to assume.** What I will not do is treat a ratified directive as
silently superseded because a later message pointed elsewhere.

### What is needed

1. **Update `feedback_no_whatsapp_everything_in_app` explicitly** — either
   *"superseded for API-integrated WhatsApp; `wa.me` hand-offs remain banned"*, or
   *"stands; WhatsApp remains share-only"*.
2. If superseded, the distinction to preserve is **hand-off vs API**: the 98 `wa.me` files stay
   wrong either way. An API rail does not make them acceptable — it makes them *replaceable by
   something better*.
3. **IntaSend remains the payment authority.** The brief already says so; it should stay written
   down, because "sell inside the conversation" is exactly where a second rail would appear.

## 5 · What the catalogue should say meanwhile — nothing new

Under the evidence rules established this week, WhatsApp Cloud API **must not** be added to the 52.
There is no code path, so it is not a technical integration; and it is not an operational dependency
either, because the business does not currently rely on it. **It does not exist yet.** Adding an
entry now would be precisely the `sokoni-webhook-engine.js` defect: a declaration standing in for a
capability.

When it is built, it enters through the delta process — proposal, review, one controlled rebaseline
— like `google-maps` and the other four.

## 6 · Suggested sequencing, once the directive is settled

| # | slice | gate |
|---|---|---|
| 1 | directive update | **owner decision** — blocks everything below |
| 2 | credentials provisioned (WABA, phone-number-id, token, verify token) | owner; secrets in Secret Manager, never in the repo |
| 3 | webhook receiver + signature verification, inbound only | its own certification; a public unsigned webhook is the `webhookSmartpos` defect |
| 4 | outbound send behind the existing `notify.js` sender | one sender, not a second |
| 5 | catalogue delta 52 → 53, with a real probe | the established delta process |
| 6 | share attribution (`shareId` → view → cart → order) | measurable, and the least contentious part of the brief |
| 7 | campaigns · Flows · in-conversation ordering | only after 1–6, and IntaSend stays the payment authority |

Step 6 is worth noting: **seller share attribution is already allowed** under the current directive —
sharing a SOKONI link is distribution, not communication — so it could proceed even if the directive
stands unchanged.

## 7 · Not done

- **No code, no catalogue entry, no deploy.** Nothing was added to the 52 + 2.
- The 09-27 hand-off census was **not** re-run; its counts are cited, not recomputed.
- **UNPROVEN:** whether any WhatsApp credential exists outside the repository (Secret Manager was not
  queried in this pass); whether the deployed bundle differs from this source.
