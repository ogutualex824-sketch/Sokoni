# SOKONI Communication Engine

**Status:** backbone BUILT and CERTIFIED. The business anchor now reaches `notifyLog`, so all
three stores join. Coverage is PARTIAL — one caller wired. Nothing deployed.
**Date:** 2026-09-22
**Suite:** `scripts/test-communication-engine.js` — **365 pass, 0 fail**

One communications backbone instead of five unrelated integrations. Related:
[[SOKONI_CONNECT]] · [[Payments]] · [[Orders]] · [[Marketplace]]

---

## The finding this is built on

SOKONI already sends on seven channels. It does not connect them, and the reason is one
missing field — measured, not assumed:

| Store | Carries | Joinable? |
|---|---|---|
| `conversations/{id}` | `transactionType` + `transactionId` | **yes** |
| `connectSessions/{id}` | `context.relationship` + `context.anchorId` | **yes** |
| `notifyLog/{key}` | `anchorType` + `anchorId` | **yes — since this slice** |

Until this slice, `notifyLog` recorded WHO was told and WHAT KIND of message it was — never
WHICH ORDER it was about. A chat and a call about SK-99420 joined; the push that told the
seller did not.

**That single field was the difference between five systems and one. It has now been added.**

---

## What was built

Three pure modules and one read-only callable. Providers are replaceable; SOKONI's
communication identity, authorization, business context and audit trail are not.

```
                    COMMUNICATION ENGINE
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
    ENVELOPE             ROUTER              PROVIDERS
   one shape          which channel        which vendor,
   + the anchor       + why not the        and when NOT
                      others               to fail over
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                    TIMELINE (read-only)
                    projects canonical records
```

### It sends nothing

`notify.js` remains the platform's one notification engine and owns tokens, channel routing,
preferences, quiet hours, dedupe and the audit log. `messages.js` owns conversations. Connect
owns sessions. The engine gives their records a common description so they can be read
together. The suite asserts no module here pulls in a provider SDK or calls a send path — **a
second sender is the thing it exists to prevent.**

---

## The envelope

`functions/shared/communication-envelope.js` — one shape for `chat · voice · video · email ·
sms · push · in_app`.

### Delivery evidence is not collapsed

| State | Means |
|---|---|
| `queued` | accepted by SOKONI, not handed to a provider |
| `sent` | a provider accepted it |
| `delivered` | it reached the recipient's device |
| `read` | the recipient's client reported it was seen |
| `failed` | it will not arrive |
| `suppressed` | SOKONI chose not to send (preferences, quiet hours, opt-out) |

`sent` is **not** terminal and **not** `delivered`. A provider accepting a message is the most
over-claimed fact in messaging systems, and this programme has already been careful about the
same distinction for a ringing phone.

`suppressed` is its own state, not a failure. Something SOKONI deliberately did not send is a
different fact from something that could not arrive.

### An unanchored communication is recorded as unanchored

It is not refused — most of what the platform sends today is unanchored, and refusing it would
simply mean the timeline never sees it. `anchored: false` is stated on the record. **Absence is
reported, never hidden.**

### It carries a preview, not a body

An envelope is an index entry; the message lives in the system that owns it. Copying bodies
would create a second store of everything anyone has ever said, which then drifts. No telephone
number may enter an envelope — the builder **refuses** rather than redacting, the same rule
Connect holds for sessions.

---

## The router

`functions/shared/communication-router.js`.

```
present in-app?  → in_app    free, instant, already in context
push available?  → push      cheapest reachable channel
critical?        → sms       costs money; reserved for consequence
needs a record?  → email     a receipt someone can keep
```

### The rule with a bill attached

**`commerce` and `marketing` never route to SMS**, whatever the reachability. Only `critical`
may. SMS costs money per message, and a chat layer that quietly falls back to SMS turns a free
conversation into a metered one — usually discovered on an invoice.

The suite proves both halves: a commerce message *with* a phone number plans no SMS, and the
identical reachability at `critical` does.

### Every omission is explained

`considered` names why each unplanned channel was not planned — `no_push_target`,
`recipient_not_present`, `priority_not_sms_eligible`. "Why didn't we text them?" is a question
someone asks about a bill, and an answer reconstructed from code is not an answer.

### A required record that cannot be made is a refusal

`requiresRecord: true` with no email address returns **no plan at all**, not a best-effort. A
receipt nobody received becomes a dispute nobody can settle.

### It is not a second notification authority

It returns a **plan**, and a plan is advice. It answers the question `notify.js` cannot — what
to do given *reachability*. `notify.js` remains the authority and this is its input.

### It now has a production caller

`communicationPlan` and `communicationSend` both route through it, so the policy is
load-bearing: a commerce message cannot become an SMS because the router says so, not because
a comment says so. Until this slice it was a table with no reader.

---

## The provider policy

`functions/shared/communication-providers.js`.

### Not every failure deserves a second attempt

| Failure class | Fail over? | Why |
|---|---|---|
| `transport` | **yes** | unreachable, 5xx, timeout |
| `quota` | **yes** | rate limited or over plan |
| `auth` | no | failing over hides a misconfiguration that keeps costing |
| `recipient` | no | the same invalid address fails again and hurts a second reputation |
| `suppressed` | no | **failing over actively defeats the suppression** |
| `content` | no | the same payload will be rejected again |
| anything unclassified | no | fail closed |

### A human mailbox is not a transactional fallback

`google_workspace` is deliberately **absent** from the email failover chain. `receipts@` and
`support@` are different things: automated mail wants deliverability engineering and a
reputation SOKONI controls; a human mailbox wants threads, search and someone's actual inbox.
Mixing them means a bounced receipt damages the address the support team replies from.

### Health reports provisioning, never liveness

`state` is `configured` or `not_configured` and nothing else. A provider that is configured may
still be failing, and rendering that as green would be the dashboard lying. Whether a provider
is configured is an **argument**, never read from the environment — a module that checks its
own env cannot be tested for the unconfigured case, and that is the case that matters.

---

## The template library

`functions/shared/communication-templates.js` — 16 approved templates across `order`,
`delivery`, `payment`, `account`, `support`. Pure: no firestore, no clock, no env, no require,
and it sends nothing. Templates are **data**.

### A missing variable is a refusal

`render` throws on any unfilled placeholder — including an empty string and whitespace.

> The failure this prevents is the one everybody has received: **"Hi , your order  has been"**.
> A blank where a name should be is worse than no message, because it was sent on purpose and
> reads as contempt.

### A template declares its channels

The same words do not work everywhere. An SMS is metered and has no subject line; a push has
about forty characters before a phone cuts it off. Asking for a channel a template does not
declare is **refused**, not silently reformatted — the alternative is a 300-character "email"
arriving as three truncated SMS nobody can read.

`account_restricted` is **email and in-app only**, deliberately. A restriction needs explaining,
and telling someone their account is restricted in forty characters with no room for why or
what to do is a notification that *creates* a support case instead of preventing one.

### Custom copy is allowed, and marked as custom

`describeCustom` returns `templateId: null, source: 'custom'`. A custom message dressed up as
approved makes "what did we tell people" unanswerable.

### No logic in the copy

Placeholders are `{name}` and nothing else — no loops, no conditionals. A template that can
branch is a program, and a program in a copy library is a thing nobody reviews.

---

## The admin send path

`functions/communication-send.js` — three admin-only callables.

### Plan before send

`communicationPlan` **sends nothing** and returns the channel decision plus every channel that
was ruled out and why. "Why didn't we text them?" is a question someone asks about a bill, and
the answer belongs on the screen where the decision was made, not reconstructed from code
afterwards.

### The router's first production caller

Both callables route through `communication-router.js`. Until this slice it was a policy module
nothing consulted — a table with no reader, the defect this codebase has paid for twice. The
policy is now load-bearing: a commerce message cannot become an SMS because the router says so.

### It resolves; `notify.js` sends

No provider SDK is reached here. Reachability is **read, never assumed** — presence from the
same document Connect uses, tokens from the one notification engine rather than a second field,
and every absent signal reads as false.

**No address or telephone number is ever returned.** An operator needs to know a channel is
available, not what the value is.

### A half anchor is refused

`anchorType` without `anchorId` (or the reverse) is rejected rather than silently dropped: a
message recorded unanchored when the operator thought they anchored it vanishes from the
timeline they will go looking in.

A send failure is reported, never smoothed into success. A dedupe is reported as a dedupe.

---

## Provider health

`communicationHealth` reports whether each credential **exists**, as a boolean — no value, no
length, no prefix.

It states what it measures and what it does not: *"liveness, delivery rate, or latency —
nothing here has sent anything."*

> A dashboard rendering "operational" over an expired API key is worse than one rendering
> nothing, because it is consulted during an incident.

TURN and Google Workspace both report **not configured**. "We have no human mailbox transport"
must be visible, not omitted.

### The send surface is its own file

`sokoni-comms-send.js`, mounted by both consoles through the console module, so
`sokoni-comms-console.js` keeps its certified guarantee of containing no write path. The suite
asserts the read console still reaches exactly one callable — the read-only timeline.

The client renders **no copy of its own**. The template menu is a menu; the server refuses
anything it does not approve, so a stale menu produces a refusal rather than wrong copy.

---

## The timeline

`functions/communication-timeline.js` — callable `communicationTimeline({ anchorType,
anchorId })`.

It **projects** canonical records into envelopes at read time. There is no `communications`
collection and no second message store.

### It still declares its own incompleteness

All three stores join now, but **coverage is partial by construction**, and `complete: false`
travels with every response alongside `anchorCoverage`:

1. every `notifyLog` row written **before** the anchor shipped has none, and never will
2. every call site not yet given the two lines still writes none — **Connect is the only one
   wired so far**

An operator reading a short timeline is told it is partial rather than concluding the
relationship was quiet. A source that could not be read is reported as unreadable, never as
empty.

### A suppressed notification is not a failed one

`processing` maps to `queued` (SOKONI has it, no provider does), quiet hours and preferences
map to `suppressed`, and **nothing maps to `read`** — a push nobody opened was not read.

### One real vocabulary mismatch, handled

Connect stores the **collection** in `context.anchorType` (`orders`) and the **business kind**
in `context.relationship` (`order`). `conversations` stores the business kind. The envelope's
anchor types are business kinds, so the timeline joins on `relationship` and never on the
collection name — joining on the collection would return nothing for every anchor, and an empty
timeline reads as "nothing happened".

### A call is not reported as read because it was placed

| Session state | Delivery evidence |
|---|---|
| `authorized` | `queued` |
| `ringing` | `sent` |
| `accepted` / `connecting` | `delivered` |
| `connected` / `ended` | `read` — both parties were present |
| `declined` | `delivered` — it reached them; they declined |
| `cancelled` / `expired` / `failed` | `failed` |

Every Connect state is mapped; the suite asserts none falls through to a guess.

### Authorization

An admin reads the timeline. Anyone else must be a participant in at least one row and sees
only the rows they were party to — a business relationship is not a licence to read everything
about it, and a rider on a delivery is not entitled to the buyer's support case. Participants
are an authorization **input**, stripped before the response so the timeline never hands out a
membership list.

---

## The Connect freeze is untouched

C1 `API_CONTRACT`, C2 `SokoniConnectClient.CONTRACT`, the actor vocabulary and the session
states are all re-asserted by this suite. The engine was built **around** the frozen contracts,
as instructed. `test-connect-authority.js` remains 674/0.

---

## Not built

Stated so nothing here reads as more complete than it is.

- **Seven modules BYPASS the one engine** with their own `_notify` helper — 43 calls across
  automation-engine, sub-billing, sub-engine, financial-os, loyalty, franchise-engine and
  installments. No anchor added to `notify.js` reaches any of them. **This is the real ceiling
  on coverage**, measured by `scripts/audit-communication-anchors.js`. Converting them is a
  behaviour change to money-adjacent code and deserves its own slice.
- **Three engine call sites pass an anchor.** `notify.js` records one now, and
  `connect-notify` is the single caller wired. Every other call site still writes
  `anchored: false` — honestly, and invisibly to any timeline. Two lines each; the highest-value
  remaining change.
- **No user-facing contact rebuild.** `contact.html`, `help.html` and `support.html` already
  exist and `adminCreateSupportTicket` already creates cases — a fourth surface would be the
  duplication this engine opposes. What they still need is the two-line anchor.
- **Support cases are not joined to the timeline yet.**
- ~~**No offline outbox.**~~ **Built 2026-09-22** — see [[#The offline outbox]]. Not yet mounted
  on a chat surface: the queue, the identity and the server dedupe exist and are proven together,
  but no page draws a pending bubble or a retry control yet.
- **Nothing is deployed**, and the Connect functions deploy remains blocked by the
  merchant-identity provenance gap.

---

## The offline outbox

A message composed without a connection must not be lost, and must not be sent twice when the
connection returns. `sokoni-outbox.js` holds the first half; `functions/shared/message-identity.js`
and `sendMessage` hold the second. Neither half is sufficient alone.

### It is a transport buffer, not a message store

The queue holds only what the server has **not** accepted. The moment a message is acknowledged
the canonical record is the server's, and `forget()` drops the local entry — which is why it
refuses to drop anything unacknowledged. Nothing here is ever read back as history; that would be
the [[#One message store|second message store]] this engine exists to prevent.

### The ladder

```
queued ──▶ sending ──▶ sent ──▶ delivered ──▶ read
   │           │         │
   └──────────▶ failed ◀─┘
                 │
                 └──▶ sending   (explicit retry ONLY, same identity)
```

`sending → queued` is **deliberately absent**. Re-queuing an in-flight send would let the next
drain pick it up while the first attempt is still outstanding, which is how one message becomes
two. A stalled send goes to `failed` and waits to be retried by hand. Nothing retries by itself —
there is no timer in the module at all.

`sent` means the server said so. A resolved promise that does not carry `accepted: true` is
**not** an acknowledgement, and is recorded as `no_acknowledgement`. This is the same rule the
platform applies to money: never show success before the canonical operation completes.

### Exactly-once, and why the client could not do it alone

The hard case is not a failed send. It is a send the server **accepted** and the client never heard
about — a timeout, a dropped connection, a closed tab. Marking that `failed` and letting the user
resend delivers the message twice.

So every entry carries a `clientMessageId`, minted once when the user pressed send and never
regenerated: not on retry, not after a reload, not after a timeout. The retry is the same logical
message.

That is only useful if the server recognises it. Before 2026-09-22 `sendMessage` minted a random
document id, so a retry wrote a **second message and incremented `unread` a second time**. It now
derives a deterministic id and writes with `create()`:

```
messageDocIdFor(senderUid, conversationId, clientMessageId) -> m_<32 hex>
```

- The **sender component comes from the verified token**, never the request body. If the key alone
  were the document id, any user could occupy another user's document and block an honest message —
  a denial of service available to anyone who can guess a string. Namespacing makes that impossible
  by construction rather than by check.
- The write is `batch.create`, so a duplicate rejects the **whole batch** and the `unread`
  increment does not apply either. A duplicate that only skipped the message would still leave the
  badge wrong.
- `ALREADY_EXISTS` is the **success** case: it returns `{ accepted: true, duplicate: true }`.
  Returning an error would push a correctly-delivered message into the client's failed pile and
  invite the user to send it again by hand.
- A malformed key is **refused**, never sanitised. Rewriting two different keys into one string
  would merge two distinct messages.
- The key is **optional**. Callers that send none keep the previous random-id behaviour exactly,
  so nothing that exists today changes.

### The seam

`sokoni-chat-engine.js` **carries** the key and does not mint one. Minting it in the transport
would be a fresh key on every call — a random id under another name. The suite asserts the absence.

### Evidence

`scripts/test-outbox.js` — **165 pass, 0 fail**. All 36 ordered state pairs are exercised, and the
sweep asserts it found both permitted and refused pairs, so it cannot pass by matching nothing.

Two assertions are **inverted**, because a duplicate detector that cannot see a duplicate proves
nothing:

- the identity assertion is re-run against a deliberately broken outbox that regenerates the key on
  retry, and the suite **fails if the detector does not catch it**;
- the round trip is re-run against a store modelled on the **old** server — random ids, `set()` —
  and the suite fails unless it observes two messages and a doubled unread count.

The second control also demonstrates why the fix had to be server-side: the client behaved
**identically** in both runs. A client cannot make a server idempotent.

Status: **TESTED**, not INTEGRATION-VERIFIED. Storage, clock and transport are injected, so nothing
in the suite touches a browser, a network or a wall clock — which is also its limit. No real
Firestore `create()` has rejected a real duplicate; that requires the emulator or production, and
the functions deploy remains blocked by the merchant-identity provenance gap.

---

## Running the suite

```bash
node scripts/test-communication-engine.js
node scripts/test-connect-authority.js        # the frozen contracts
```
