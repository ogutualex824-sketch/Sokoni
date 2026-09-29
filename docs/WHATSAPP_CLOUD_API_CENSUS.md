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

---

## 8 · Slice 1 — the inbound receiver (owner-authorised 2026-09-29)

**Directive settled:** superseded **for API-integrated WhatsApp only**. `wa.me` hand-offs remain
banned — the 98 files are still wrong, and an API rail does not make a hand-off acceptable, it makes
it *replaceable by something better*. IntaSend remains the payment authority.

**25 passed, 0 failed** — `scripts/test-whatsapp-webhook.js`.

### Why the receiver is first

`webhookSmartpos` shipped public and unsigned, and anything reaching it could inject. The build order
exists so that cannot repeat: the door is built and proven before anything is bolted to it. A send
path first would have had nothing to verify what came back.

### It fails closed in every direction

| condition | result |
|---|---|
| wrong verify token | 403 |
| **verify token not configured** | **403 — inert, not permissive** |
| wrong mode / missing challenge | 403 |
| no signature header, or empty | 403 |
| signature from the wrong secret | 403 |
| malformed signature (wrong prefix, length, non-hex) | 403 |
| **tampered body with a signature valid for the original** | **403** |
| **app secret not configured** | **403 — inert** |
| raw body unavailable | 403 — it refuses rather than verify a re-serialisation |

The two *not configured* rows matter most. A receiver that accepts everything when its secret is
absent is worse than one switched off, because it looks like it is working.

Every refusal has an **inverting control**: a correctly signed payload of the same shape is accepted
and yields 2 events. Compares are `timingSafeEqual`, length-checked first; the refusal reason is
logged but **never returned** — telling an unauthenticated caller why their signature failed is a
probing oracle.

### The raw body is the only verifiable thing

`JSON.stringify(req.body)` is a re-serialisation — key order, whitespace and unicode escaping may all
differ from what Meta signed. Verifying against it fails valid requests, and the tempting "fix" is to
weaken the check. Absent `rawBody`, the request is refused.

### Idempotency, because Cloud API retries

`create()`, not `set()`. The same batch twice writes **2 documents, not 4**, the second delivery
reports `duplicate: 2`, and the stored records are byte-identical afterwards — a replayed *delivered*
cannot overwrite a later *read*. Distinct statuses for one message are three records, because
sent/delivered/read are three facts. A duplicate returns **200**: a non-200 makes Meta retry for ever.

### What it deliberately does not do

**Message bodies are not stored.** An inbound message is a customer's words; this records that one
arrived, from whom, of what type and when. Content belongs in the conversation store under the
communications engine's retention, not in a diagnostic collection. Asserted, with a control proving
the fixture really contained the text.

The module contains **no** Graph call, no outbound HTTP of any kind, and touches no order, payment,
checkout or notify path. One collection, `whatsappInbound`, Admin-SDK written and never client-read —
so no `firestore.rules` entry, since an unlisted path is default-deny.

### Not exported from `functions/index.js`, deliberately

`defineSecret` binds at deploy time, and **neither `WHATSAPP_VERIFY_TOKEN` nor `WHATSAPP_APP_SECRET`
exists in Secret Manager yet**. Wiring this into `index.js` today would make the next functions
deploy fail — for every agent in this repository, on lanes unrelated to WhatsApp. Because `index.js`
does not require the module, `defineSecret` never executes and nothing is bound. Shipping it is two
lines once the secrets are provisioned.

`enforceAppCheck` is deliberately absent: Meta is not a SOKONI client and cannot present a token. The
signature *is* the authentication, which is why it is verified before anything else happens.

### Two defects in my own harness, found and fixed

- **The empty-signature case never reached the module.** `o.sigOverride || sign(...)` treats `''` as
  falsy and substituted a **valid** signature, so the test passed by accepting a good request. A
  harness that quietly swaps a valid credential for the invalid one under test is worse than no test.
  Now `!== undefined`.
- **An assertion matched the module's own comment.** The check for `JSON.stringify(req.body)` hit the
  prose warning *against* the practice, so it would have failed however correct the code was — the
  same defect as the earlier B10 check. Now asserted on stripped source, with a control that the
  stripper is not a no-op.

### Still UNPROVEN, and not small

**No real Meta delivery has occurred.** There is no WABA, no phone-number-id and no credential, so
what is certified is the receiver's logic against payloads *shaped* like Meta's. Not registered with
Meta, not exported, not deployed. The handshake has never been performed against Meta's servers.

### Not done

No catalogue entry — WhatsApp still does not meet the bar for the 52, and will enter through the
delta process when it is real. No outbound. No campaigns, Flows or in-conversation ordering. No
`wa.me` replacement work. No deployment.

---

## 9 · Slice 2 — provisioning preparation (no handshake, no catalogue change)

`node scripts/whatsapp-preflight.js` — read-only, names only, never a secret value.

```
[ok]  Secret Manager readable                     observed       41 secrets in sokoni-aeb26
[ok]  POSITIVE CONTROL — a known secret is found  observed       FACEBOOK_APP_SECRET
[--]  secret WHATSAPP_VERIFY_TOKEN                absent
[--]  secret WHATSAPP_APP_SECRET                  absent
[ok]  receiver module present                     observed
[--]  exported from functions/index.js            absent         INTENTIONALLY
[ok]  receiver certification                      observed       25 passed, 0 failed
[--]  function deployed                           absent         404 from gcloud
[n/a] callback URL                                n/a            no endpoint until deployed
[  ]  WABA · phone-number-id · subscription · handshake   not-attempted
```

### The census UNPROVEN is now closed

*"Whether any WhatsApp credential exists outside the repository"* — **it does not.** 41 secrets in
`sokoni-aeb26`, neither of the two present. That is a measured absence, not an assumption, because
the same query **finds `FACEBOOK_APP_SECRET`**: the positive control proves the detector works. An
empty result without that control would have been worthless.

### A finding that changes what you provision

**`FACEBOOK_APP_SECRET` already exists.** WhatsApp's `X-Hub-Signature-256` is signed with the **Meta
app secret** of the app that owns the WABA — so if SOKONI puts WhatsApp on the *same* Meta app as
Facebook Login, the value SOKONI needs is **already in Secret Manager**, under a different name.

That makes this a decision, not a fetch:

| option | consequence |
|---|---|
| **Separate Meta app for WhatsApp** *(recommended)* | its own app secret, its own `WHATSAPP_APP_SECRET`. Rotating WhatsApp cannot break Login, and a WhatsApp compromise does not reach the Login app. |
| Same Meta app as Facebook Login | no new app secret needed — bind `FACEBOOK_APP_SECRET` directly. **Do not copy its value into a second secret name**: two names holding one value drift the moment either is rotated, and nothing would detect it. |

Either way the **verify token is always new** — SOKONI chooses that value; Meta only echoes it.

### What to provision

1. **Decide one Meta app or two** (above).
2. **`WHATSAPP_VERIFY_TOKEN`** — a fresh high-entropy random string. It authenticates the one-time
   handshake and nothing else.
3. **`WHATSAPP_APP_SECRET`** — the Meta app secret, *or* rebind the function to `FACEBOOK_APP_SECRET`
   if the same app is used.
4. In Meta: a **WhatsApp Business Account**, a **business phone number**, and its **phone-number-id**.

Secrets go in Secret Manager only. Never in `functions/.env` — that file is foreign working state
here and has its own standing rule against being committed.

### Then, in order

```
secrets created
   ↓  two lines in functions/index.js
const whatsapp = require('./whatsapp-webhook');
exports.whatsappWebhook = whatsapp.buildFunction();
   ↓  deploy  --only functions:whatsappWebhook     (scoped; see the estate note)
   ↓  preflight again — `function deployed` and `callback URL` become observed
   ↓  paste the callback URL + verify token into Meta, subscribe to `messages`
   ↓  Meta performs the GET handshake — the FIRST real proof
   ↓  send one message to the business number; confirm a row in whatsappInbound
```

The handshake is **the first evidence that anything works**, and nothing before it counts as one.
Until Meta has echoed a challenge and a signed POST has been recorded, the rail is certified logic
and nothing more.

### Why the export is still absent

`defineSecret` binds at deploy time. Exporting before the secrets exist makes the **next functions
deploy fail for every agent in this repository**, on lanes unrelated to WhatsApp. The preflight
reports this row as `absent` with the reason attached, so it reads as a deliberate state rather than
an oversight.

### Two things the checker itself demonstrated

- **It reported `unreadable`, not `absent`, when it could not run `gcloud`.** Node 24 on Windows
  refuses to spawn a `.cmd` shim directly, and the first run hit that. A broken tool must never read
  as "the secret is not there" — that is the invitation to re-create a credential that already
  exists.
- **It classified a real 404 as `unreadable` until the pattern was corrected.** gcloud returns
  `status=[404] … was not found`, which the original regex missed. Fixed — an absent function is a
  known fact; only an *unrecognised* failure stays unreadable.

### Not done

No handshake, no deployment, no export, no secret created, no catalogue change (still 52 + 2), no
outbound, no campaigns, no Flows, no `wa.me` replacement. Share attribution remains a separate slice
needing no Meta credential.
